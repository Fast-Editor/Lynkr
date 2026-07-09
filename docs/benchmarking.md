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
```

Competitors are optional; unreachable proxies are reported as
`SKIPPED (proxy not reachable)` and excluded from cost comparisons —
never counted as $0.00.

```bash
# LiteLLM head-to-head (same free Ollama backend → fair proxy-vs-proxy)
source ~/venvs/litellm/bin/activate
export $(grep -E '^(MOONSHOT_API_KEY|AZURE_OPENAI_API_KEY)=' .env | xargs)
litellm --port 8082 --config litellm-config.yaml

# Portkey (needs a real ANTHROPIC_API_KEY — OAuth tokens won't work)
docker run -d -p 8083:8787 portkeyai/gateway
```

## The 17 scenarios

| Group | IDs | What it measures |
|---|---|---|
| Feature economics | S1, T1, T2, H1, L1, L2, SC1, SC2, R1 | tier routing, tool-schema stripping, history compression, TOON JSON compression, semantic cache |
| Routing regressions | F1, F2, RS1, SR1, A1 | force-cloud phrases, path-risk, reminder-injection immunity, suggestion-mode side requests, autonomous→REASONING |
| Session behaviour | P1, P2 | fingerprint pins a SIMPLE opener, then the pin **escapes mid-session** when the real task arrives |
| Cache correctness | SC3 | the cache must not serve an answer to a *different* question |

## Reading the output

**Per-scenario rows** report the routing *decision* (Tier column, from
`X-Lynkr-*` headers) and the *served* model (from the response body — they
differ when tier-fallback rescued a failed upstream, flagged
`SERVED-VIA-FALLBACK`). `Saved` is signed: negative values expose proxy
overhead (e.g. system-prompt injection on small requests) instead of
hiding it.

**`ROUTING CORRECTNESS (Lynkr)`** is the pass/fail scoreboard. Route
expectations judge Lynkr only — other proxies synthesize tier labels from
cost heuristics. Any `✗ … ← REGRESSION` means a routing change re-broke a
fixed incident. Current baseline: **10/10**.

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

Two consecutive runs must both score 10/10. If run #2 diverges, the
benchmark found state leakage — that's a finding, not noise.

## Known limitations

- **Upper tiers serve via fallback in scripted runs.** azure-anthropic
  requires the OAuth token that only Claude Code supplies, so COMPLEX/
  REASONING decisions get *served* by the fallback chain. Routing
  decisions are still asserted; served-quality comparisons need the wrap.
- Nine-figure extrapolations from 17 requests are directional. For
  publishable numbers, loop the mix 50–100×.
- The token estimator (chars/4) is approximate; treat `Saved` as relative,
  not invoice-grade.
