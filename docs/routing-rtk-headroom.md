# Lynkr Internals: Routing, RTK-Style Compression, and Headroom

Study notes for presenting Lynkr. Written 2026-09-27, grounded in the current
code (file paths reference the repo). Three parts: how a request gets routed,
how tool-output compression works (the RTK port), and how the Headroom sidecar
compresses context.

---

## Part 1 — Routing: eight stations, fixed order

Every scored request walks the same pipeline. Design thesis in one line:
**layers that predict are capped, layers that observe are trusted, and every
decision is logged well enough to be second-guessed offline.**

### Station 1 — Hygiene (score what the user typed, nothing else)

The last user ask is extracted and cleaned before anything scores it:

- Claude Code wrapper text is stripped: `<system-reminder>`,
  `<task-notification>`, `[SUGGESTION MODE:]`, continuation summaries
  (`jev-router.js` cleaner; `intent-score.js` walks back past
  injected-only messages to the real ask).
- GUI-harness envelopes are stripped by `src/routing/harness-envelope.js`:
  Cursor delivers the ask wrapped in `<user_info>`, `<git_status>`, `<rules>`,
  `<agent_transcripts>` blocks *inside the user message itself*. If a
  `<user_query>` marker exists, only its contents are used.

**Why it exists (war story):** a Cursor workspace `<rules>` block containing
"never expose API keys / do not deploy to production" made the bare greeting
"Hi" trip the risk analyzer's high-risk keywords and force-route to REASONING
(2026-09-26 incident). The envelope, not the ask, was being scored. One shared
strip now feeds every scanner: force patterns, risk keywords, complexity
dimensions, anchors, and the judge all see the same cleaned ask.

### Station 2 — Deterministic gates (before any model-based scoring)

Checked first because they outrank everything:

- **Force patterns** (`complexity-analyzer.js`): `security audit|penetration
  test`, `ultrathink`, `think step by step`, `prove|formal proof|verify`,
  `from first principles`, and a two-sided lookahead — a *plan word*
  (plan/roadmap/RFC/strategy) AND a *technical word* (refactor/migrate/
  system/pipeline/codebase) together force REASONING. "Plan my vacation"
  stays quiet; "give me a plan to refactor the routing layer" escalates.
- **Risk analyzer** (`risk-analyzer.js`): high-risk instruction keywords →
  force high tier; protected-path keywords (auth, credentials, .env) →
  medium, unless read-only verbs (explain/summarize/show) demote intent.
- **Side-request quarantine**: title generation, autocomplete, suggestion
  frames, bare harness pings are pinned to static SIMPLE and are forbidden
  from writing any session state (two live incidents in July taught this:
  side traffic poisoned session pins).

### Station 3 — Embedding anchor score (the cheap 90%)

`intent-score.js`. The cleaned ask is embedded locally (nomic-embed-text via
Ollama, sha1-keyed cache) and compared by cosine to four **class centroids**
built from `data/difficulty-anchors.json` exemplars:

| Class | Representative value | Example anchors |
|---|---|---|
| trivial | 10 | "hi", "ok thanks", "how do I install golang on mac?" |
| substantive | 45 | "Implement a distributed rate limiter with Redis", "Fix the linter warnings" |
| heavyweight | 68 | "analyze every module in src/ for circular dependencies…", "architecture review" |
| frontier | 85 | "Prove the correctness of this lock-free queue…", "diagnose this heisenbug across three services" |

Mechanics worth knowing:

- Similarities are softmax-blended (temperature 0.05) so borderline asks
  interpolate between classes instead of cliffing.
- The **frontier class needs cosine ≥ 0.50** to participate at all — a weak
  topical match cannot jump to the expensive tier.
- Score bands: SIMPLE ≤19, MEDIUM 20–50, COMPLEX 51–75, REASONING 76+ —
  but bands are **auto-calibrated from live outcomes** (on 2026-09-19 the
  calibrator widened COMPLEX to [30,75] based on observed routing accuracy).
- **Envelope invariance is a tested contract**: the anchor scorer only ever
  sees a single cleaned message. Thread context travels separately, never as
  extra messages (`test/intent-score.test.js` pins this).
- If the embedding provider is down, scoring degrades to a lexical fallback
  (logged loudly, auto-recovers; a single transient failure is absorbed by
  an in-place retry rather than tripping 60s of degradation).

### Station 4 — TypeSafe "Jev" judge (the capped second opinion)

`jev-router.js`. Jev is a fast decision model (system-one: it categorizes,
it does not reason). Lynkr treats it accordingly — as one bounded vote.

**Exactly what is sent** (`buildJevState` — this is the privacy answer):

```
{
  current_request:     cleaned ask text, ≤ 4000 chars
  conversation_context: ≤ 360 chars —
     "[REFERENCE ONLY — background thread, NOT the current ask. Latest user
       message wins.] Task: \"<first ask of current task>\" Last: \"<prior ask>\""
  signals: {            // flat numbers, bucketed 1/2/3/5/8/13/21
    message_count_bucket, tools_attached, effective_tools,
    has_tool_history, session_turn_bucket,
    is_continuation, inherited_floor, task_open,
    last_turn_tools_bucket, last_turn_errors_bucket
  }
}
```

**Not sent:** the conversation, tool outputs, file contents, system prompts,
harness envelopes. The context line is sanitized (no newlines/brackets) and
framed as untrusted background.

**Bounded authority:** promote cut 0.3 (below it, the anchor stands); upward
moves capped at **one band above max(anchor, inherited floor)** — enforced at
both the reconcile step and the serving-layer override (`+jev_override_capped`
in the method string when the cap changed the outcome); demotions are
confidence-gated when the verdict leaned on thread context. Verdicts are
LRU-cached keyed on state + criteria hash.

### Station 5 — TaskBand (memory instead of prediction)

`task-ledger.js`. The router's answer to "you can't know difficulty from a
prompt": *stop predicting, remember.*

- A **pure fold** over the resent conversation segments it into tasks
  (a marker-only "thanks" turn closes a task; "thanks — now do X" closes and
  opens in one step). Memoized by prefix-chain hash, O(1) per new turn.
- A **continuation detector** (no LLM: deictic words + ≤2 novel tokens,
  OR embedding cosine ≥ 0.70 vs the task anchor, OR file-path overlap;
  vetoes: >400 chars, explicit new-task openers, side requests).
- If the turn continues an open task, the final band is **floored at the
  band the task already earned** (sticky max of served tiers, excluding
  force/risk/floor-raised serves so escalations can't self-perpetuate).
- Floors only raise, decay one band for two turns after task close,
  auto-close after 3 consecutive low-scoring turns, and are never written
  into session pins (floored tiers must not fossilize).
- A 10% FNV-1a session holdout never receives floors — the built-in
  control group for measuring the feature.

Net effect: "do the same here" after a COMPLEX refactor routes COMPLEX,
because the task *demonstrated* its difficulty; the judge no longer has to
rescue context-blind follow-ups.

### Station 6 — Structural lifts

- **Agentic detector**: harness-aware — subtracts each client's baseline tool
  loadout (Claude Code ~14, Cursor ~9) before judging a request "agentic",
  so default tools don't inflate every turn.
- **Vision guard**: image payloads must serve on a vision-capable model for
  that turn (pin-exempt — doesn't re-pin the session).
- **Capability shortfall** (`shortfall.js`): compares a requirement vector
  (reasoning/codegen/debugging/tool_use heads derived from the weighted
  analysis) against per-model capability profiles. Hard-learned guards:
  candidates sort **tier-before-cost** (unknown prices = Infinity must never
  hand the win to the only seed-priced frontier model); serve-path escalation
  capped at one band; and a **humility gate** — if the incumbent model's
  capabilities resolved only to tier-fallback ignorance, "incapable" is
  unfalsifiable and may not drive an escalation. (All three from the
  "Hi → grok-4.7-high" incident, 2026-09-25.)

### Station 7 — Economics and stability

- **Session pins**: repeat turns reuse the pinned provider/model (6h TTL)
  with guard checks (context growth, vision, risk) and an upward drift check
  so a trivial-opener pin can't hold back a real task.
- **Cache-switch break-even** (`cache-switch-cost.js`): a model downgrade
  must beat the cost of re-reading the warm prefix over the session's
  expected remaining turns. On flat-rate subscription paths the dollar leg
  is skipped entirely (there is no premium to amortize) — descents happen
  only for honest cache reasons.
- **Tool-loop hold**: a frame carrying tool history NEVER switches models —
  not for score, not for cache math (`tool_loop_hold`). Switching between a
  tool_use and its tool_result is how a COMPLEX task ends up half-answered
  by the cheap model (live incident, 2026-09-26).
- **Passthrough ladder** (subscription traffic): upgrades rewrite only
  `body.model` (prefix cache survives); upgraded pins persist; easy fresh
  turns step back down via the gate (`−stepdown`).

### Station 8 — Serving, fallback, telemetry

Provider invocation with a fallback ladder (terminal fallback:
azure-openai). Every decision writes a telemetry row: score, tier, method
(+suffixes like `+continuation_inherit`, `+shortfall`, `+jev_override_capped`),
propensity, judge verdict/confidence, continuation flags, cache tokens,
latency. That log feeds the learning loop: quality-score reward → contextual
bandit → off-policy evaluation (IPS + doubly robust, `ope.js`) → threshold
auto-calibration → kNN router (confidence-gated overrides from past
request outcomes).

---

## Part 2 — RTK-style tool-output compression

**What RTK is:** [rtk-ai/rtk](https://github.com/rtk-ai/rtk) ("Rust Token
Killer") — a client-side CLI proxy that intercepts shell commands and
compresses their output before the agent reads it ("cuts up to 90% of the
bash output your agent reads"; 100+ command handlers).

**What Lynkr did with it:** ported the *strategies* server-side.
`src/context/tool-result-compressor.js` opens with "RTK-inspired compression
for tool_result blocks in client mode" and its JS test parser is literally
ported from RTK's Rust source (`rtk/src/cmds/js/vitest_cmd.rs` is cited in
the comments). Applied in the orchestrator when large `tool_result` blocks
ride in a resubmitted conversation (gate: `TOOL_RESULT_COMPRESSION_ENABLED`).

**The tiered parser** (test output example):

- **Tier 1**: parse `jest --json` / `vitest --reporter=json` (shared schema,
  with an embedded-JSON extractor for pnpm/dotenv-prefixed output).
- **Tier 2**: regex-extract the default text reporters (vitest's
  `Tests  N passed` anchors) — the common case, since agents usually see
  the human reporter, not JSON.
- **Tier 3**: generic fallback truncation.
- Caps: 20 failures / 40 suites shown (`JS_TEST_MAX_FAILURES/SUITES`) — a
  10,000-line failing test log becomes a failure summary.
- A small tee-cache (200 entries) dedupes repeated identical outputs.

**Architectural comparison to present:**

| | rtk (the binary) | Lynkr's port |
|---|---|---|
| Where | client, between agent and shell | proxy, on the resubmitted payload |
| When | once, before output enters the conversation | every turn the result rides in context |
| Coverage | agents with the rewrite hook installed | every client centrally, zero installs |
| Best for | keeping outputs out of history at the source | fleets/heterogeneous clients |

They compose: run rtk client-side where you can; the proxy compresses
whatever gets through, for every client, from one place.

---

## Part 3 — Headroom: the context-compression sidecar

**What it is:** a separate Docker container (`lynkr/headroom-sidecar`, name
`lynkr-headroom`, port 8787) that Lynkr launches, health-checks, and calls
over HTTP (`src/headroom/{index,launcher,client,health}.js`). Lynkr owns its
lifecycle (`HEADROOM_DOCKER_*` config: 512MB memory cap, auto-build,
restart unless-stopped).

**When it runs:** in the orchestrator, before the upstream call, if all
gates pass:

1. `HEADROOM_ENABLED=true` and the sidecar is healthy (fail-open: a 5s
   timeout or a down sidecar means the request proceeds uncompressed —
   compression is an optimization, never a dependency).
2. The payload clears `HEADROOM_MIN_TOKENS` (100).
3. **The target provider is in the compatibility set** for
   `HEADROOM_PROVIDER` (a provider-family map). Gotcha worth telling:
   this was set to `anthropic` until 2026-08-19, which silently skipped
   compression for the actual serving providers (openai/azure-openai) —
   config reviews matter.

**What the sidecar does** (transform pipeline, each toggleable):

- **smart-crusher**: summarizes large content blocks (≥200 tokens,
  max 15 items per pass).
- **tool-crusher**: squeezes tool outputs specifically.
- **cache-aligner**: reshapes content to keep provider prompt-cache
  prefixes stable where possible.
- **rolling-window**: keeps the last 10 turns verbatim
  (`HEADROOM_KEEP_TURNS`), compresses older history.
- **CCR** (compressed-context retrieval, TTL 300s): stores crushed content
  so a later turn can retrieve detail that was summarized away.
- **LLMLingua**: available but disabled (needs GPU).

The client call (`client.js:compressMessages`) posts messages + tools with
`model`, `model_limit` (default 200k) and `mode` (`optimize`), and gets back
`{ messages, tools, compressed, stats }` — stats feed telemetry.

**The honest trade-off (measured, worth presenting):** per-turn compression
mutates conversation history, and mutated history breaks provider
prompt-cache prefix matching. The August benchmarking found "per-turn
crushers mutate history, zero cache hits observed" — the tension is real:
fewer tokens per request vs. stable prefixes for cache discounts. The
resolution on the bench path was a prefix-stable pipeline (deterministic
tool-call IDs, constant system prompt, uniform stripping), which took cache
hit rates to 92–95% and cut cost ~5×. Compression and caching are both
levers; they must be tuned together, not independently.

---

## One-paragraph summary for the deck

Lynkr routes by cleaning the ask, letting deterministic gates catch the
obvious, scoring the rest with local embeddings, consulting a capped LLM
judge with a privacy-bounded 4KB state, and then letting *memory* override
prediction — tasks keep the difficulty they demonstrated. Around that core:
harness-aware agentic detection, capability matching with humility, cache-
aware economics that never switch models mid-tool-loop, and a telemetry
trail rich enough to evaluate every policy change offline. Token cost is
attacked from both ends: RTK-ported compression squeezes tool outputs at the
proxy, and the Headroom sidecar compresses aging context — with the measured
caveat that compression and prompt-caching pull in opposite directions and
must be balanced deliberately.
