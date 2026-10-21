# Lynkr vs LiteLLM Auto Router v2 — Fresh Head-to-Head (2026-09-28)

Re-run of the July 19 routing benchmark, this time on **identical models on
both sides** (the July run mirrored tier targets; this run mirrors the exact
live ladder). Run the night before the 2026-09-28 presentation.

## Setup
- Harness: `MODE=routing RUNS=3 node benchmark-tier-routing.js` (a scenario
  passes only if all 3 runs pass; 11 scenarios, same acceptable-tier judging
  for both proxies).
- Lynkr: current working tree (TaskBand + envelope hardening + capped
  overrides — the post-2026-09-22 stack), port 8081.
- LiteLLM: litellm v1.103.0, port 8082, config
  `litellm-autorouter-v3.yaml` — Auto Router v2 complexity_router
  (heuristic mode), explicit model_info.id per tier.
- **Identical model pool** (mirrors .env of this date): SIMPLE/MEDIUM →
  baidu qianfan glm-5.2; COMPLEX → muse-spark-1.3-contributor (api.meta.ai);
  REASONING → azure gpt-5.6-sol.

## Scoreboard

| ID | Acceptable | Lynkr | LiteLLM |
|---|---|---|---|
| S1 | SIMPLE\|MEDIUM | ✓ SIMPLE | ✓ SIMPLE |
| R1 | COMPLEX\|REASONING | ✓ REASONING | ✗ MEDIUM |
| F1 | COMPLEX\|REASONING | ✓ REASONING | ✗ MEDIUM |
| F2 | COMPLEX\|REASONING | ✓ REASONING | ✗ SIMPLE |
| RS1 | SIMPLE\|MEDIUM | ✓ SIMPLE | ✓ SIMPLE |
| SR1 | SIMPLE\|MEDIUM | ✓ SIMPLE | ✓ SIMPLE |
| A1 | COMPLEX\|REASONING | ✓ REASONING | ✗ SIMPLE |
| P1 | SIMPLE\|MEDIUM | ✓ SIMPLE | ✓ SIMPLE |
| P2 | COMPLEX\|REASONING | ✓ COMPLEX | ✗ SIMPLE |
| IV1 | MEDIUM\|COMPLEX | ✓ MEDIUM | ✗ SIMPLE |
| IV2 | MEDIUM\|COMPLEX | ✓ MEDIUM | ✗ SIMPLE |

**Lynkr 11/11 · LiteLLM 4/11** — identical scores to July 19, now on
identical models. All 7 LiteLLM misses are UNDER-routes (hard prompts sent
to glm-5.2), the systematic quality-loss direction. Smoke test reproduced it
pre-benchmark: "analyse security trade-offs of JWT vs httpOnly cookies for a
banking app" → tier-simple.

## Honest notes
1. **Lynkr strict-mode drift (not visible in the scoreboard):** the harness's
   internal exact-tier assertions flagged R1/F1/F2 — all "expected COMPLEX,
   got REASONING". One band UP on three hard scenarios: the conservative
   direction (over-provisioning, never quality loss), likely from this
   month's force/risk interplay or stale strict expectations vs the current
   env. Worth a post-presentation look; acceptable-set judging passes all 3.
2. **Ignore this run's cost/extrapolation tables.** LiteLLM reports $0 for
   custom-endpoint models it has no pricing for (glm via openai/ prefix,
   muse-spark) — the "100% cheaper" line is a pricing-registry artifact.
   Both proxies used identical models, so true model cost is equal by
   construction.
3. Latency: Lynkr averaged 4.2s vs LiteLLM 16.0s across scenarios —
   directionally interesting (both hit the same backends) but confounded by
   which tier each router chose; not a controlled latency benchmark.
4. Home-field caveat stands: scenarios derive from Lynkr's regression suite.
   The transferable finding remains the *direction* of LiteLLM's failures.

Reproduce: start both proxies (`node index.js`; `litellm --port 8082
--config litellm-autorouter-v3.yaml` with BAIDU/OPENAI/AZURE_OPENAI keys
exported), then the harness command above.
