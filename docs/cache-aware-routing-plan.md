# Cache-Aware Routing — Implementation Plan

**Status:** Proposed (research complete, not yet implemented)
**Branch context:** builds on `feature/tencentdb-token-optimization`
**Motivation:** The one legitimate criticism of tier routing is that switching
models mid-session invalidates the provider's prompt cache, which can cost
more than the routing saves. This plan makes every switch decision
cache-cost-aware, so Lynkr only breaks a cache when the math says it pays.

---

## 1. The economics (researched 2026-08)

### Provider cache pricing

| Provider | Mechanism | Read price | Write price | TTL / retention |
|---|---|---|---|---|
| Anthropic / Bedrock / Vertex-Claude | explicit `cache_control` | 0.1× input | 1.25× (5 min) / 2× (1 h) | 5 min refreshed on read; 1 h opt-in (Bedrock GA Jan 2026) |
| OpenAI | automatic (≥1,024-token prefix) | 0.1× on GPT-5.x (was 0.5×) | free (automatic); explicit 1.25×, 30-min TTL, GPT-5.6+ | ~5–10 min idle; 24 h default on GPT-5.5 |
| DeepSeek | automatic, disk-based | ~0.02× (V4 Flash: $0.14 → $0.0028/M) | free | best-effort |
| Gemini | implicit (≥1,024–2,048 tokens) | 0.1× | free; explicit tier charges $1/M-tok/hour storage | implicit best-effort |
| Ollama / local | in-process KV cache | free (latency only) | free (prefill recompute) | process lifetime |

### The break-even that settles the debate

100k-token warm prefix, per-turn input cost:

- Stay on Opus ($5/M) with warm cache: 100k × $0.50/M = **$0.05/turn**
- Switch to Sonnet ($3/M): cold write 100k × $3.75/M = **$0.375 once**,
  then $0.03/turn → **~16 turns to recoup**
- Switch to Haiku ($1/M): cold write $0.125 once, then $0.01/turn →
  **~2 turns to recoup**

Conclusion: mid-session downshifts are sometimes ruinous and sometimes
clearly profitable. It is a computable break-even, not a principle. The
router must compute it.

### Prior art (GPU-cluster layer, same idea)

- NVIDIA Dynamo: radix-tree overlap score vs worker load (Baseten: 2× faster)
- SGLang v0.4 cache-aware balancer: 3.8× hit-rate, 1.9× throughput
- llm-d (K8s Gateway API): 57× TTFT vs round-robin on 8 pods
- Ray `PrefixCacheAffinityRouter`: hybrid — affinity when balanced,
  load-based fallback when queues diverge

No API-level gateway (OpenRouter, LiteLLM, Portkey) routes cache-aware
today; they pass caching through at best. This is open ground.

---

## 2. What Lynkr already has

| Piece | Where | Role in this plan |
|---|---|---|
| Sticky sessions / pins | `src/routing/session-affinity.js`, `affinity-store.js` (`session_pins`) | Primary cache protection; the thing switches must justify against |
| `cache_control` injection | `src/clients/prompt-cache-injection.js` (system + last-3 rolling) | Gets breakpoint-hygiene fix (Phase 5) |
| Model pricing registry | `src/routing/model-registry.js` (already carries `cache_read` from models.dev) | Source for read/write multipliers |
| Cache token accounting | orchestrator usage pipeline (`cache_read/creation_input_tokens`) | Source for warm-prefix size |
| Escalation ladder / de-escalator / bandit | `src/routing/` | The decision points that must consult the switch-cost model |
| Distiller (this branch) | `src/memory/distiller.js` | Both a hazard (rewrites history → busts cache) and an asset (stable prefix) — Phase 5 |

---

## 3. Phases

### Phase 1 — Cache-state tracking (small; do first)
Extend the affinity store with per-session cache state:

```sql
ALTER TABLE session_pins ADD COLUMN cache_state TEXT; -- JSON
-- { warmPrefixTokens, provider, model, lastRequestAt, ttlMs }
```

After every response, record `cache_read_input_tokens +
cache_creation_input_tokens` as the warm-prefix size, plus timestamp.
Anthropic's 5-min TTL refreshes on every read, so `lastRequestAt + ttlMs`
is a live cache clock. Providers without explicit signals (OpenAI,
DeepSeek) report analogous usage fields; map them in the same shape.

### Phase 2 — TTL-aware switch timing (clever and nearly free)
One comparison in the de-escalator and bandit-exploration paths:

- `now − lastRequestAt > ttl` → prefix is already cold → **switching is
  free cache-wise**; prefer acting now.
- Inside TTL → hold the pin unless Phase 3 math or a hard trigger says
  otherwise.

### Phase 3 — Switch-cost model at every decision point
Before the escalation ladder, de-escalator, or bandit changes a pinned
model:

```
stayPerTurn   = warmPrefix × cacheRead(current) + newTokens × input(current)
switchOnce    = (warmPrefix + newTokens) × cacheWrite(target)
switchPerTurn = warmPrefix × cacheRead(target) + newTokens × input(target)
breakEvenTurns = switchOnce / max(stayPerTurn − switchPerTurn, ε)
```

Switch iff `breakEvenTurns ≤ expectedRemainingTurns` (median remaining
turns given current turn count, from routing telemetry) — OR a hard
trigger fires (risk keywords, force phrases, context overflow), which
always wins because correctness beats cost.

### Phase 4 — Per-provider cache economics in the registry
Add `cacheWrite` multiplier + `cacheTtlMs` + `cacheMechanism`
(explicit/automatic/local) per provider-model to the registry, with the
table from §1 as fallback for models models.dev doesn't cover. Local
models get `dollarCost: 0` and a latency penalty instead (prefill
recompute time ∝ warmPrefix).

### Phase 5 — Breakpoint hygiene + distiller synergy
Current rolling last-3 breakpoints churn the cache each turn. Replace
with a stable hierarchy:

1. system prompt (never moves)
2. tools block (never moves)
3. **frozen history boundary** — advances only every K turns

The distiller integrates here: re-distill only every K turns so the
distilled block stays byte-identical between refreshes and becomes a
natural stable prefix, instead of rewriting (and cache-busting) history
every request. This one change serves both features.

### Phase 6 — Dashboard receipt
Track per-decision "cache dollars saved / burned by routing" in
telemetry; surface on `/dashboard` next to routing accuracy. This is the
public, benchmarkable answer to "routing breaks prefix cache."

---

## 4. Non-goals (for now)

- Session→instance affinity across multiple Ollama endpoints (the
  Dynamo/SGLang problem) — Lynkr's sticky sessions already approximate
  this for the single-endpoint case.
- OpenAI explicit-cache injection (GPT-5.6+, 1.25×/30-min) — worth doing,
  but after Phases 1–3 prove out on Anthropic-shaped providers.

## 5. Sources

- https://platform.claude.com/docs/en/build-with-claude/prompt-caching
- https://www.respan.ai/articles/claude-prompt-caching
- https://ofox.ai/blog/prompt-caching-cost-math-anthropic-vs-openai-2026/
- https://aws.amazon.com/about-aws/whats-new/2026/01/amazon-bedrock-one-hour-duration-prompt-caching
- https://openai.com/index/api-prompt-caching/
- https://effloow.com/articles/openai-prompt-cache-retention-24h-cost-proof-2026
- https://api-docs.deepseek.com/guides/kv_cache/
- https://developers.googleblog.com/gemini-2-5-models-now-support-implicit-caching/
- https://developer.nvidia.com/blog/introducing-nvidia-dynamo-a-low-latency-distributed-inference-framework-for-scaling-reasoning-ai-models/
- https://www.lmsys.org/blog/2024-12-04-sglang-v0-4/
- https://developers.redhat.com/articles/2025/10/07/master-kv-cache-aware-routing-llm-d-efficient-ai-inference
- https://docs.ray.io/en/latest/serve/llm/user-guides/prefix-aware-routing.html
