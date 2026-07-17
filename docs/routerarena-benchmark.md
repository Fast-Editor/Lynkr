# Lynkr on RouterArena (third-party benchmark)

[RouterArena](https://github.com/RouteWorks/RouterArena) ([arXiv:2510.00202](https://arxiv.org/abs/2510.00202),
ICLR 2026) is an open evaluation platform and live leaderboard for LLM
routers — 8,400 queries across 9 domains and 44 categories, scored on
accuracy, cost, optimality, robustness, and latency. It is maintained by a
third party; Lynkr had no hand in its design, dataset, or scoring.

## Results (full 8,400-query split, evaluated 2026-07-15)

| Metric | Lynkr |
|---|---|
| Acc-Cost Arena score | **67.65** |
| Accuracy | **68.41%** |
| Cost per 1K queries | **$0.29** |
| Robustness | **92.38** |
| Optimal Selection / Optimal Cost / Optimal Accuracy | 11.13 / 17.00 / 85.37 † |

† Optimality metrics computed on 629 of 809 sub-split queries — the
remaining 180 comparison inferences were cut short when the evaluation
API budget ran out. All 8,400 scored queries and the robustness set are
complete.

### Against the leaderboard (snapshot, July 2026)

- Lynkr's 67.65 places roughly **#15 of 27** routers evaluated.
- It scores **above both commercial routers** on the board: GPT-5's
  built-in router (64.32 arena, $10.02/1K) and NotDiamond (57.29, $4.10/1K).
  Against GPT-5's router that is a higher arena score at **~34× lower cost**.
- **Robustness 92.38 is top-5.** RouterArena's robustness metric measures
  how often a router flips its model choice when the prompt is perturbed
  with noise; most evaluated routers score 25–70. Lynkr's anchor-embedding
  intent scorer classifies against fixed semantic centroids, so surface
  noise rarely moves the decision.
- Honest framing: several open-source research routers beat Lynkr on both
  axes (e.g. Hybrid Router: 71.38% at $0.04/1K; Nadir-Tumbler: 75.34% at
  $0.08/1K). The claim this benchmark supports is *"beats the commercial
  routers, competitive mid-table overall at near-floor cost"* — not
  *"best router."*

## Setup

**What was benchmarked:** Lynkr's live routing decision path — the WS7
anchor intent scorer (local `nomic-embed-text` embeddings, no LLM calls)
plus tier mapping — exposed via `POST /routing/analyze?mode=intent`. This
is the same scorer the proxy uses in production, not a benchmark-special
code path. Cascade verification (WS6) was **not** exercised: RouterArena
evaluates one upfront model choice per query.

**Model pool** (declared in the RouterArena config, all served via
OpenRouter):

| Lynkr tier | Model | Pricing (in/out per M) |
|---|---|---|
| SIMPLE | `openai/gpt-oss-120b` | $0.039 / $0.19 |
| MEDIUM | `qwen/qwen3-235b-a22b-2507` | $0.071 / $0.10 |
| COMPLEX + REASONING | `z-ai/glm-4.7` | $0.40 / $1.50 |

**Routing distribution:** 96.4% SIMPLE / 3.5% MEDIUM / 0.1% COMPLEX.
Lynkr routes this benchmark very aggressively cheap. The optimality data
suggests the SIMPLE/MEDIUM boundary is currently the highest-leverage
tuning target — some escalation-worthy queries stay on the cheap tier.

## Reproducing

```bash
git clone https://github.com/RouteWorks/RouterArena && cd RouterArena
uv sync
uv run python ./scripts/process_datasets/prep_datasets.py

# Lynkr running locally with an embeddings backend (Ollama + nomic-embed-text)
lynkr start   # or: node index.js

# Adapter class: router_inference/router/lynkr_router.py (LynkrRouter)
# queries POST http://localhost:8081/routing/analyze?mode=intent per prompt
uv run python router_inference/generate_prediction_file.py lynkr full
uv run python llm_inference/run.py lynkr              # needs OPENROUTER_API_KEY
uv run python llm_evaluation/run.py lynkr full --num-workers 4
uv run python llm_evaluation/run.py lynkr robustness
```

Total evaluation cost for the model-inference step: **$5.63** of OpenRouter
credits (dominated by GLM-4.7's reasoning-token output).

## Caveats

- Leaderboard positions move as new routers are submitted; numbers above
  are a July 2026 snapshot. Check the
  [live leaderboard](https://routeworks.github.io/leaderboard).
- RouterArena is single-shot Q&A. Lynkr's agentic-traffic features —
  client-harness profiles, tool-schema stripping, tool-result compression,
  semantic caching, cascade verification — do not contribute to this score.
  Treat the result as Lynkr's *general routing floor*, not a measure of the
  whole gateway.
- Different routers on the leaderboard declare different model pools;
  RouterArena scores each router with its own declared pool, so cross-router
  comparisons combine routing quality *and* pool choice.
