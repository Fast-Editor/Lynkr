# Routing Intelligence

How Lynkr decides which model serves each request — the full pipeline as of
July 2026, covering sticky sessions, the escape ladder, and the closed
learning loop. For the per-message intent scorer see
[intent-window-routing.md](intent-window-routing.md).

## The decision pipeline

```
request arrives
   │
   ├─ side request? (harness autocomplete/title/summarization)
   │      → static SIMPLE tier. Never scored, never touches pins.
   │
   ├─ session pin exists? (content fingerprint, below)
   │      ├─ mid-tool-exchange (last message carries tool_result)
   │      │      → serve pin unconditionally (tool-call IDs can't cross providers)
   │      ├─ guards: risk · context-fit · vision
   │      │      any fails → full re-route
   │      ├─ escape ladder (below)
   │      │      fires → full re-route, re-pin upward
   │      └─ all clear → serve pin (skips scoring/embeddings/kNN/bandit)
   │
   └─ full routing: intent score → tier → guards → kNN → bandit → decision
          → decision becomes the session's new pin
```

## Session identity: content fingerprints

Claude Code, Cursor, and most Anthropic-API clients send **no session
identifier** — but they replay the full conversation history on every turn.
Lynkr derives a stable session id from that:

```
session_id = "fp-" + sha256(first user message + system prompt head + user-agent)
```

Every turn of one conversation maps to the same id, so routing decisions
stick for the whole conversation (one cold prompt-cache read instead of one
per turn). `<system-reminder>` blocks are stripped before hashing — their
contents vary between replays. A compaction that rewrites the first message
produces a new fingerprint, which is correct: the prompt cache was
invalidated anyway. Disable with `LYNKR_SESSION_FINGERPRINT=false`.

## The escape ladder

A pinned session re-routes when — in priority order:

| Trigger | Behaviour |
|---|---|
| **Force-cloud phrase** ("refactor the entire…", "architecture review", "security audit", "code review", "production issue") | instant COMPLEX via tier config, regardless of score |
| **Risk keyword in typed text** (authentication, credential, migration, deploy, payment, …) or protected path (`src/auth/…`, `.env`, workflows) | instant COMPLEX. Scans only user-authored text — harness-injected reminder blocks are stripped |
| **Score drift** | the latest message scores above the pinned tier's ceiling + `LYNKR_PIN_DRIFT_MARGIN` (default 15) → re-route + re-pin upward |
| **Context overflow** | conversation outgrew the pinned model's window → escalate to a context-capable model |
| **Vision** | image arrives → per-turn swap to a vision model (pin kept) |
| **Compaction** | history shrank → cache reset anyway, switching is free |

Deliberately one-directional: pins never voluntarily *demote*
mid-conversation — dropping a long conversation onto a cheaper model
re-reads the whole prompt cold, which usually costs more than it saves. The
economic-downgrade rule permits it only on compaction, under
`LYNKR_SWITCH_MAX_PROMPT_TOKENS` (default 20k) and a ≥25% price gap.

Two hard rules learned from production incidents:

- **Risk-forced decisions are never pinned.** Risk re-fires every turn, so
  pinning added nothing — and one phantom hit (e.g. a harness suggestion
  wrapper containing "credentials") used to lock whole conversations onto
  the expensive tier.
- **Side requests never write pins.** Claude Code's autocomplete/title/
  summarization calls replay the conversation (same fingerprint) wrapped in
  harness text; their routing outcomes must not overwrite the
  conversation's pin. Detection requires harness evidence (a detected
  client profile or a `[SUGGESTION MODE:` tag) — plain API clients sending
  tool-less requests still get full routing.

## De-escalation

Three layers, each requiring more evidence than escalation:

1. **New conversation** → fresh decision (this is where most savings live).
2. **Compaction + economics** → free switch window, price-gated.
3. **Evidence-gated demotion** (WS2): a fresh decision demotes one tier only
   when telemetry proves the lower tier served ≥30 requests of the same
   type at avg quality ≥70 with <5% errors over 7 days.

## The learning loop (WS4 + WS5)

Every request outcome feeds back into future routing:

```
response → quality score → telemetry (SQLite, .lynkr/telemetry.db)
                │
                ├─ reward = quality − λ·cost − μ·latency → LinUCB bandit update
                ├─ conclusive outcomes (quality ≥70 / ≤40) + the query's
                │    embedding → kNN index grows online
                └─ every 24h: auto-calibration re-fits tier score boundaries
                     from quality history and hot-reloads (no restart)
```

- Every telemetry row carries `propensity` and `candidates` — the
  probability the served model was chosen, and what else was considered —
  so any future routing policy can be evaluated **off-policy from logs
  alone**.
- The kNN router answers "which model actually worked on questions like
  this?" It activates at 100 entries with confidence damped by
  `size/1000`, so a young index advises weakly. High-confidence matches
  (> `LYNKR_KNN_CONFIDENCE_HIGH`) override the heuristic; ambiguous ones
  escalate only when telemetry shows cheap tiers actually failing.
- The bandit explores only within `TIER_*`-configured models.
- Capability-decoupled shortfall routing (HyDRA port, off by default):
  `src/routing/capabilities.js` maps the 15 weighted dims onto 4 heads
  (`reasoning/codegen/debugging/tool_use`), and `src/routing/shortfall.js`
  serves the cheapest `TIER_*`-configured model covering them within τ.
  Switch, tolerance, weights, and model capabilities all live in
  `config/model-capabilities.json` (no env vars; restart to pick up edits),
  so catalog changes re-route with zero retraining. When off, shortfall still
  shadow-computes and logs the legacy-vs-shortfall comparison; when on, a
  disagreement serves the shortfall pick with `method+=+shortfall` (upward
  moves also record an `escalations[]` entry). Force paths (risk/force
  phrases), static mode, and downstream guards (context/vision/kNN/bandit/
  deadline/tenant) all dominate shortfall.
- Model capability is a property of the WEIGHTS, not the provider:
  `capability-seeds/family.js` normalizes `zai:glm-5.2`, `baidu:glm-5.2`
  and `ollama:glm-5.2` to one family id, so all three servings share caps
  (quantized GGUF servings take an automatic −0.02 haircut). Resolution
  order: operator `modelOverrides` → fetched snapshot (`data/`, gitignored)
  → shipped seeds (`config/model-capability-seeds.json`, reviewed) → family
  ladder heuristic → tier-slot caps. Every pick carries a `source` tag
  (override|seed:snapshot|seed:shipped|family|tier) for audit.

## Key environment knobs

| Variable | Default | Purpose |
|---|---|---|
| `LYNKR_SESSION_FINGERPRINT` | `true` | content-derived session ids |
| `LYNKR_STICKY_SESSIONS` | `true` | pin routing decisions per session |
| `LYNKR_STICKY_TTL_MS` | 6h | pin lifetime |
| `LYNKR_PIN_DRIFT_MARGIN` | 15 | points above tier ceiling before a pin escapes |
| `LYNKR_SWITCH_MAX_PROMPT_TOKENS` | 20000 | economic-downgrade cap |
| `LYNKR_KNN_MIN_INDEX_SIZE` | 100 | entries before kNN advises |
| `LYNKR_KNN_CONFIDENCE_HIGH` / `_LOW` | 0.7 / 0.4 | override / ambiguous bands |

Shortfall has no env vars — `enabled`, `tau` (~0.01 peak quality, 0.24
default, ~0.6 aggressive savings), `weights`, tier profiles, and
`modelOverrides` all live in `config/model-capabilities.json` (restart to
pick up edits).

## Seeding model capabilities (new-model runbook)

`npm run seed:capabilities` (→ `scripts/seed-capabilities.js --refresh`):

1. Fetches SWE-Bench Verified + models.dev flags (7-day file cache in
   `data/`, offline-safe) plus any `data/capability-benchmarks/*.json`
   drop-ins (TerminalBench/LiveCodeBench/AA exports).
2. Maps bare-model scores to families (scaffold+model composites like
   "live-swe-agent + claude" are quarantined — they measure harnesses, not
   weights — and weak matches stay unmapped for review).
3. Writes `data/capability-seeds.snapshot.json` and prints the diff,
   candidate graduations (wildcard matches worth an exact entry), and the
   review lists. `--dry-run` prints without writing; `--check` fails CI
   when shipped seeds go stale (>90d).
4. Promote by copying reviewed entries into
   `config/model-capability-seeds.json` (bump `updatedAt`) and restarting.
   Unknown families keep working throughout via heuristic → tier fallback.

Auto-calibration and the telemetry DB location are deliberately **not**
configurable — calibration self-gates on sample count, and telemetry lives
at `.lynkr/telemetry.db`.

## Verifying routing behaviour

`node benchmark-tier-routing.js` (repo root) runs 19 scenarios against a
live gateway, including 10 routing-correctness assertions that encode past
production incidents — reminder-injection immunity, suggestion-mode
handling, force/risk triggers, pin-then-escape, cache false-positive
guards. A `✗ … ← REGRESSION` in the scoreboard means a routing change
broke a previously-fixed behaviour. See
[benchmarking.md](benchmarking.md).
