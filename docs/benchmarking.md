# Benchmarking Lynkr

`benchmark-tier-routing.js` (repo root) is both a **comparative benchmark**
(Lynkr vs LiteLLM vs Portkey on identical workloads) and a **routing
regression harness** — its correctness assertions encode real production
incidents so they can't silently return.

## Quick start

```bash
# Gateway must be running (standalone or via wrap)
node index.js &          # or: lynkr wrap claude in another terminal

node benchmark-tier-routing.js

# Routing-only head-to-head (skips compression/cache scenarios; judges
# EVERY proxy on the same acceptable-tier sets, not just Lynkr):
MODE=routing node benchmark-tier-routing.js

# Repeat each scenario to catch non-deterministic routers (a scenario
# passes only if every run passes); restrict to one proxy with ONLY:
MODE=routing RUNS=3 ONLY=LiteLLM node benchmark-tier-routing.js
```

Competitors are optional; unreachable proxies are reported as
`SKIPPED (proxy not reachable)` and excluded from cost comparisons —
never counted as $0.00.

```bash
# LiteLLM head-to-head against its Auto Router v2 complexity router
# (litellm >= 1.94): tier targets mirror Lynkr's TIER_* config, and each
# tier deployment carries an explicit model_info.id so the benchmark can
# read the tier decision from the x-litellm-model-id header.
litellm --port 8082 --config litellm-autorouter-v2.yaml       # heuristic (default)
litellm --port 8082 --config litellm-autorouter-v2-llm.yaml   # LLM classifier

# Legacy load-balancing comparison (cost heuristic tier inference):
litellm --port 8082 --config your-litellm-config.yaml

# Portkey (needs a real ANTHROPIC_API_KEY — OAuth tokens won't work)
docker run -d -p 8083:8787 portkeyai/gateway
```

## The 19 scenarios

| Group | IDs | What it measures |
|---|---|---|
| Feature economics | S1, T1, T2, H1, L1, L2, SC1, SC2, R1 | tier routing, tool-schema stripping, history compression, TOON JSON compression, semantic cache |
| Routing regressions | F1, F2, RS1, SR1, A1 | force-cloud phrases, path-risk, reminder-injection immunity, suggestion-mode side requests, autonomous→REASONING |
| Session behaviour | P1, P2 | fingerprint pins a SIMPLE opener, then the pin **escapes mid-session** when the real task arrives |
| Envelope invariance | IV1, IV2 | the same ask bare vs wrapped in tool schemas + fat system-reminders must land the same tier (WS7 anchor scoring) |
| Cache correctness | SC3 | the cache must not serve an answer to a *different* question |

`MODE=routing` runs the 11 scenarios that carry an `acceptable` tier set
(S1, R1, F1, F2, RS1, SR1, A1, P1, P2, IV1, IV2) and nothing else.

## Reading the output

**Per-scenario rows** report the routing *decision* (Tier column, from
`X-Lynkr-*` headers) and the *served* model (from the response body — they
differ when tier-fallback rescued a failed upstream, flagged
`SERVED-VIA-FALLBACK`). `Saved` is signed: negative values expose proxy
overhead (e.g. system-prompt injection on small requests) instead of
hiding it.

**`ROUTING CORRECTNESS (Lynkr)`** is the regression scoreboard: Lynkr's
strict per-incident expectations (`expectTier`). Any `✗ … ← REGRESSION`
means a routing change re-broke a fixed incident. Current baseline:
**12/12** (11 tier assertions + SC3's cache guard). With `RUNS>1` a
scenario passes only if **every** run passes.

**`ROUTING SCOREBOARD (all proxies)`** judges every proxy that exposes a
real tier decision against the same `acceptable` sets — broader than
`expectTier` (e.g. R1 accepts COMPLEX *or* REASONING) so it's fair to
routers with different tier philosophies. Lynkr's tier comes from
`X-Lynkr-Tier`; LiteLLM's from `x-litellm-model-id` when running an
Auto Router v2 config. IV2 additionally requires the same tier as IV1.
Reference run (2026-07-15, same backends): Lynkr 11/11, LiteLLM v1.94
heuristic 4/11, LiteLLM + GPT-5.2 LLM classifier 6–8/11 (non-deterministic)
— details in [BENCHMARK_REPORT.md](../BENCHMARK_REPORT.md) addendum.

**Cost tables** price local models (ollama/minimax/llama/qwen) at $0 and
bill cache hits as zero (`[CACHE-HIT]`, detected via the
`lynkr_semantic_cache` response marker). The extrapolation section is a
scenario-mix multiplication, not a traffic model — treat it as directional.

## Hermeticity (why reruns are trustworthy)

Server-side state persists between runs: session pins live 6h and the
semantic cache retains answers. The harness compensates:

- a **per-run nonce** is embedded in the stateful scenarios (P1/P2 and the
  SC family), so each run gets fresh fingerprints and cache keys;
- every non-cache scenario sends `x-lynkr-no-cache: true`, so run #2's
  feature measurements aren't silently served from run #1's cache;
- SC3's assertion is **similarity-aware**: a hit at ≥0.97 similarity is a
  prior run's identical question (correct behaviour, passes); a hit below
  that matched a *different* question — the real false positive — and
  fails with the similarity printed.

Two consecutive runs must both score 12/12 (or pass `RUNS=2` in one
invocation — each run gets a fresh nonce automatically). If run #2
diverges, the benchmark found state leakage — that's a finding, not noise.

## Known limitations

- **Upper tiers serve via fallback in scripted runs.** azure-anthropic
  requires the OAuth token that only Claude Code supplies, so COMPLEX/
  REASONING decisions get *served* by the fallback chain. Routing
  decisions are still asserted; served-quality comparisons need the wrap.
- Nine-figure extrapolations from 19 requests are directional. For
  publishable numbers, loop the mix 50–100× (`RUNS=50`).
- The token estimator (chars/4) is approximate; treat `Saved` as relative,
  not invoice-grade.
