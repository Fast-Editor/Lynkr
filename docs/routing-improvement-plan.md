# Lynkr Routing Algorithm — Improvement Plan

*Grounded in current state analysis of `src/routing/` plus 2024-2026 research on LLM routing, cascades, contextual bandits, and production gateway design.*

---

## 0. Where We Are Today

The current Lynkr router (`src/routing/`, ~4,000 LOC) is **purely heuristic**. It has eleven modules but no learned components actually applied at runtime. The major gaps:

| Module | What it does | What it doesn't do |
|---|---|---|
| `complexity-analyzer.js` (1,048 LOC) | 42 regex patterns + 15-dim weighted score + ±35 graph adjustments | Regex is brittle. Token estimator uses naive 4-chars-per-token. No learned signals. Embeddings code exists but is optional and silently fails |
| `model-tiers.js` (367 LOC) | Maps 0-100 score to 4 fixed tiers [0-25/26-50/51-75/76-100] | Tier boundaries are hardcoded. Intra-tier model selection is "pick first". No context-window enforcement |
| `cost-optimizer.js` (305 LOC) | Estimates cost, finds cheapest-for-tier, tracks session spend | **Never overrides the TIER_* env vars.** Computed but unused |
| `risk-analyzer.js` (197 LOC) | Substring match on auth/payment/migration keywords + paths | False positives via substring matching. No semantic understanding |
| `agentic-detector.js` (320 LOC) | Scores tool count, tool types, prior tool results, conversation depth | Doesn't distinguish successful vs failed tool calls. Patterns hardcoded |
| `quality-scorer.js` (113 LOC) | Heuristic score from status/tokens/latency/retries | **Output is recorded but never fed back into routing.** Fixed weights, no learning |
| `latency-tracker.js` (148 LOC) | Per-provider P50/P95/P99 over a 200-sample circular buffer | **Not consumed by the router.** Per-provider only, not per-model. No temporal info |
| `telemetry.js` (509 LOC) | SQLite persistence with 30-day retention | **No analyzer reads it back.** Telemetry exists but the loop is open |

The summary is: **Lynkr has the data to be a great router, but doesn't use it.** Quality scores, latency stats, cost data, and telemetry are all recorded but never fed back into the scoring or tier selection. The optional embedding path is the only place ML is referenced, and it's a single hardcoded-reference comparison with ±10 score adjustment.

What the research literature has converged on (and what we should be doing):

1. **Simple kNN routers outperform complex learned ones** ([Rethinking Predictive Modeling for LLM Routing, arXiv:2505.12601, May 2025](https://arxiv.org/abs/2505.12601))
2. **Cascade routing is theoretically optimal** when you can estimate per-model performance ([de Koninck et al., NeurIPS 2024 / arXiv:2410.10347](https://arxiv.org/abs/2410.10347))
3. **Confidence-based deferral** with a small-first cascade gives 45-98% cost reduction ([FrugalGPT, arXiv:2305.05176](https://arxiv.org/abs/2305.05176); [GATEKEEPER, arXiv:2502.19335](https://arxiv.org/pdf/2502.19335))
4. **Encoder-based complexity classifiers** (DeBERTa-v3-base, ModernBERT, MIRT-BERT) outperform regex heuristics at <10ms latency
5. **Contextual bandits (LinUCB)** give provable sublinear regret for online LLM selection ([Online Multi-LLM Selection via Contextual Bandits, arXiv:2506.17670](https://arxiv.org/abs/2506.17670))
6. **Semantic caching** is orthogonal and cuts 60-86% of calls before the router even runs ([GPT Semantic Cache, arXiv:2411.05276](https://arxiv.org/abs/2411.05276))

The plan below applies these in order of effort-to-impact ratio.

---

## 1. Plan Overview

Four phases. Each phase is independently shippable. Phases 1-2 are pre-requisites for 3-4 but can run in parallel themselves.

| Phase | Theme | Effort | Expected Cost Reduction | Expected Quality Impact |
|---|---|---|---|---|
| **Phase 1 — Plug the open loops** | Activate the dead code: feed telemetry back, enforce context window, use cost-optimizer, fix tokenizer | 1-2 weeks | 10-20% | ±0% (no regression) |
| **Phase 2 — Pre-router primitives** | Semantic cache, accurate tokenizer, per-model latency, model-pricing freshness | 2-3 weeks | Additional 40-60% | Neutral-to-positive |
| **Phase 3 — Learned scoring** | Replace regex complexity with a kNN router; add small-first cascade with confidence-based deferral | 4-6 weeks | Additional 30-50% on remaining traffic | +3-8% quality at same cost |
| **Phase 4 — Online adaptation** | Contextual bandit (LinUCB) for intra-tier selection; closed-loop quality feedback; drift detection | 6-10 weeks | Adaptive, ongoing | Continual improvement |

Cumulative cost expectation: **a properly-tuned final system should land in the 5-15% range of always-Opus baseline**, matching what RouteLLM and FrugalGPT report in production benchmarks.

---

## 2. Phase 1 — Plug the Open Loops (1-2 weeks)

The cheapest improvements are the ones where the code already exists but isn't wired up. There are five of these and they should ship together.

### 1.1 Fix the token estimator

**Where**: `complexity-analyzer.js` line ~400 (the 4-chars-per-token approximation).

**Problem**: 4 chars/token is roughly correct for English prose but wildly wrong for code (closer to 3 chars/token) and even more wrong for non-Latin scripts (where BPE explodes character counts into many tokens). A 10,000-character TypeScript file gets estimated at 2,500 tokens; tiktoken reports closer to 3,500. The router under-routes complex code requests.

**Fix**: Use `js-tiktoken` (pure JS port of tiktoken) for OpenAI/Anthropic models. It's ~1MB bundled and runs in <5ms for a 100KB input. Cache the encoder instance.

**Files to change**:
- Add dependency in `package.json`: `"js-tiktoken": "^1.0.16"`
- Add `src/routing/tokenizer.js` exporting `countTokens(text, model)` with cached encoder per encoding family
- Replace `Math.ceil(totalChars / 4)` calls in `complexity-analyzer.js` and `api/router.js:estimateTokenCount`

**Expected impact**: 5-10% improvement in tier accuracy, especially on code-heavy requests.

### 1.2 Activate cost-optimizer for intra-tier selection

**Where**: `index.js` line ~297 (where TIER_* env vars become the final word).

**Problem**: `cost-optimizer.js:findCheapestForTier()` exists and computes the cheapest model that meets the tier requirement. It's never called from the routing path.

**Fix**: After tier selection, if multiple models qualify for the tier, call `costOptimizer.findCheapestForTier(tier)` to pick the cheapest. Keep the TIER_* env var as a *preference*, not a hard override — if both `TIER_COMPLEX=anthropic:claude-opus-4-7` and `anthropic:claude-sonnet-4-6` qualify for COMPLEX and the latter is 5x cheaper, prefer it unless the request risk level is high.

**Files to change**:
- `src/routing/index.js`: replace the `selectModel(tier)` call with a cost-aware wrapper
- `src/routing/model-tiers.js`: expose `getQualifyingModels(tier)` that returns *all* tier-capable models, not just the first

**Expected impact**: 10-15% cost reduction immediately, biggest impact on the MEDIUM and COMPLEX tiers where multiple models qualify.

### 1.3 Enforce context window

**Where**: `model-tiers.js:_getProviderModel()`.

**Problem**: A 60K-token request routed to a model with a 32K context window silently fails downstream. The router doesn't check.

**Fix**: After selecting a model, validate `estimatedTokens <= model.context * 0.85` (leave headroom for response). If not, escalate to the next tier with adequate context, or fall back to a context-rich model regardless of tier (e.g., always-on Sonnet for >150K).

**Files to change**:
- `src/routing/index.js`: add `validateContext(model, estimatedTokens)` after tier selection
- `src/routing/model-tiers.js`: add `findContextCapable(minContext)` for fallback path

**Expected impact**: Eliminates silent failures on long-context requests (current failure mode is a 4xx from the provider; users see "request too large").

### 1.4 Feed quality scores back into tier thresholds

**Where**: `quality-scorer.js` and `model-tiers.js`.

**Problem**: `quality-scorer.js` produces a [0-100] quality score per response but the score goes into telemetry and dies there. The thresholds in `model-tiers.js` are hardcoded [25/50/75].

**Fix**: Add a nightly job (`scripts/calibrate-thresholds.js`) that queries telemetry for the last 7 days, computes the median quality score per tier per complexity bucket, and adjusts thresholds. If SIMPLE tier shows quality < 60 for scores in [20-25], raise the SIMPLE upper bound from 25 to 22. Write the calibrated thresholds to `data/calibrated-thresholds.json` and have `model-tiers.js` prefer the calibrated values over the static config.

**Files to change**:
- Add `scripts/calibrate-thresholds.js`
- `src/routing/model-tiers.js`: read from calibrated config first, fall back to hardcoded
- Add a `lynkr calibrate` CLI subcommand

**Expected impact**: 5-15% accuracy improvement as the system learns where its boundaries actually lie.

### 1.5 Per-model latency tracking

**Where**: `latency-tracker.js`.

**Problem**: Tracks latency per *provider*, not per *model*. If `anthropic` has both Opus (slow) and Haiku (fast), the aggregate is meaningless.

**Fix**: Change the key from `provider` to `${provider}:${model}`. Expose per-model P95 to the router so it can avoid routing latency-sensitive requests to models currently degraded.

**Files to change**:
- `src/routing/latency-tracker.js`: change key scheme, expose `getModelLatency(provider, model)`
- `src/routing/index.js`: optionally bypass a model whose P95 exceeds a threshold (e.g., 2x its historical median)

**Expected impact**: Tail latency improvement during partial provider outages (Opus slow, Sonnet fine). 5-10% P99 improvement.

---

## 3. Phase 2 — Pre-router Primitives (2-3 weeks)

These are independent of the routing algorithm itself but reduce the number of requests the router has to handle.

### 2.1 Semantic cache layer

**Why**: [GPT Semantic Cache (arXiv:2411.05276)](https://arxiv.org/abs/2411.05276) reports 60-68.8% cache hit rate across categories; [Bifrost's production deployment](https://www.truefoundry.com/blog/semantic-caching) reports 86% cost reduction at 88% latency improvement. This is the single highest-ROI intervention in the literature.

**Design**:
- **Layer 1 — exact hash cache**: SHA256 of (system + messages) → response. Zero embedding cost when it hits.
- **Layer 2 — semantic cache**: Embed the user message via a local model (Ollama with `nomic-embed-text` or `bge-base`). Compare cosine similarity against last N=10,000 cached entries. If similarity >= 0.95, return cached response.
- **Cache key includes**: system prompt fingerprint, top-K most recent messages (last 3-5), and tool definitions hash. Different system prompts must not collide.
- **Cache invalidation**: TTL of 1 hour for general queries, shorter (5 min) for queries that contain "current", "today", "now" keywords.
- **Storage**: SQLite (already a dependency) for L1; sqlite-vec or hnswlib-node for L2.

**Files to add**:
- `src/cache/semantic-cache.js`
- `src/cache/embedding-client.js` (wraps the embedding endpoint, with batching)
- `src/api/middleware/semantic-cache.js` (Express middleware that wraps `/v1/messages`)

**Expected impact**: 40-70% cost reduction *before* the router runs. This stacks multiplicatively with routing improvements.

### 2.2 Model pricing freshness

**Where**: `model-registry.js`.

**Problem**: Pricing is fetched from LiteLLM JSON and models.dev, cached 24 hours, fallback is hardcoded. No version tracking; when Anthropic cuts Opus pricing, Lynkr keeps optimizing against stale numbers.

**Fix**: Add a daily refresh job. Store pricing with a `fetched_at` timestamp. If pricing changes by >5% between refreshes, log a warning and notify (the cost optimizer's decisions will shift). Add a CLI command `lynkr pricing diff` that shows what changed.

**Files to change**:
- `src/routing/model-registry.js`: add `verifyFreshness()`, log changes
- Add `scripts/refresh-pricing.js` cron-friendly entrypoint

**Expected impact**: Avoids cost-optimizer making bad decisions on stale prices. Small but cumulative.

### 2.3 Tokenizer-aware budget tracking

**Where**: `cost-optimizer.js`.

**Problem**: Output token estimation uses 0.5× input. This is wildly wrong for code generation (often 2-5× input) and even more wrong for summarization (often 0.1× input).

**Fix**: Train a small per-task-type output ratio. Telemetry already records actual input/output ratios per task type. Build `data/output-ratios.json` from telemetry: `{simple_qa: 0.3, code_gen: 2.1, summarization: 0.15, reasoning: 1.5}`. Use the matched ratio when estimating cost during routing.

**Files to change**:
- Add `scripts/learn-output-ratios.js` (one-off + nightly)
- `src/routing/cost-optimizer.js`: read from `data/output-ratios.json`

**Expected impact**: 10-20% improvement in cost prediction accuracy. Mostly matters for budget enforcement.

---

## 4. Phase 3 — Learned Scoring (4-6 weeks)

This is where the bigger architectural changes start.

### 3.1 kNN router for complexity scoring

**Why**: [Rethinking Predictive Modeling for LLM Routing (arXiv:2505.12601, May 2025)](https://arxiv.org/abs/2505.12601) showed that a well-tuned kNN router with query embeddings outperforms complex learned routers across instruction-following, QA, and reasoning benchmarks. Lower sample complexity, more interpretable, easier to debug.

**Design**:
- **Embedding model**: `bge-base-en-v1.5` via Ollama (or `nomic-embed-text`). ~300ms cold, ~30ms warm. Acceptable.
- **Index**: hnswlib-node, in-memory, with 10k-50k historical query embeddings + their observed (model, quality, cost, latency) outcomes from telemetry.
- **At inference**: embed the incoming query, find K=10 nearest neighbors, compute weighted-average performance per candidate model, pick the model that maximizes quality at cost ≤ budget. Use cosine similarity as the weight.
- **Cold start**: bootstrap with RouterBench or a synthetic dataset; the system improves as real telemetry accumulates.

**Files to add**:
- `src/routing/knn-router.js` (the index + lookup)
- `src/routing/embedding-cache.js` (caches embeddings for repeated queries within a session)
- `scripts/build-knn-index.js` (rebuild index from telemetry)

**Files to change**:
- `src/routing/index.js`: use kNN as the primary scorer; fall back to current heuristic if confidence is low (K=10 neighbors have <3 close matches)

**Expected impact**: 15-30% routing accuracy improvement (measured against ground-truth labels from telemetry). Replaces ~600 lines of regex heuristics in `complexity-analyzer.js`.

### 3.2 ModernBERT complexity classifier (alternative path)

**If you want a parametric model instead of kNN**, fine-tune a [ModernBERT](https://www.philschmid.de/fine-tune-modern-bert-in-2025) classifier on RouterBench data. ModernBERT has 8192-token context, <100M parameters, and runs at ~10-30ms per inference on CPU. The advantage over kNN is no index to maintain.

[NVIDIA's prompt-task-and-complexity-classifier](https://huggingface.co/nvidia/prompt-task-and-complexity-classifier) is publicly available — a DeBERTa-v3-base with multi-head outputs for task type and complexity dimensions. Worth evaluating as a drop-in before training from scratch.

**Decision criterion**: pick kNN if you can collect 5k+ labeled queries from telemetry within 4 weeks. Pick ModernBERT/DeBERTa if you can't — the supervised model generalizes better with less data.

### 3.3 Small-first cascade with confidence-based deferral

**Why**: [FrugalGPT (arXiv:2305.05176)](https://arxiv.org/abs/2305.05176) demonstrates 98% cost reduction by trying small models first and escalating only on low-confidence responses. [GATEKEEPER (arXiv:2502.19335)](https://arxiv.org/pdf/2502.19335) extends this with confidence tuning so smaller models actively reject queries they shouldn't answer.

**Design**:
- For tier-MEDIUM/COMPLEX requests, instead of going straight to Sonnet/Opus, first try a smaller model (e.g., the SIMPLE tier model).
- After response, score the response with a lightweight confidence estimator:
  - **For factoid queries**: check if response contains "I don't know" / "I'm not sure" / "I cannot" markers
  - **For code generation**: check for syntax validity (Tree-sitter parse), check for obvious markers of incompleteness ("// TODO", "...")
  - **For reasoning tasks**: use a separate small judge LLM to score "does this answer the question?" on a 1-5 scale
- If confidence >= 0.85, accept the small-model response and return.
- If confidence < 0.85, escalate to the originally-routed tier model. The small-model call is sunk cost but typically <5% of the big-model call.
- **Important**: cascade is *off by default* for streaming requests (you can't retry mid-stream cleanly). Cascade is *on by default* for non-streaming and tool-use requests where you have the full response before deciding.

**Files to add**:
- `src/routing/cascade.js`
- `src/routing/confidence-scorer.js` (heuristic + judge-LLM hybrid)

**Files to change**:
- `src/orchestrator/index.js`: wrap the model invocation in a cascade-aware loop

**Expected impact**: 30-50% cost reduction on the requests that reach this layer. This is the single biggest cost lever after semantic caching.

### 3.4 Replace regex risk analyzer with a small classifier

**Where**: `risk-analyzer.js`.

**Problem**: Substring matching on keywords like `auth` produces false positives on `authorize_payment` (matched twice), `author`, `authority`, etc. The risk path forces COMPLEX tier, which is expensive when wrong.

**Fix**: Train a binary classifier (logistic regression on bag-of-word features, or a tiny BERT model) on a few thousand labeled queries. Risk is a much easier classification problem than complexity scoring.

**Files to change**:
- Replace the regex logic in `risk-analyzer.js` with a model inference
- Add `data/risk-classifier.bin` (the trained model)
- Add `scripts/train-risk-classifier.js`

**Expected impact**: Reduces false-positive risk escalations by ~70%. The wins here are routing accuracy, not raw cost.

---

## 5. Phase 4 — Online Adaptation (6-10 weeks)

This phase turns Lynkr into an adaptive system that improves over time without manual retuning.

### 4.1 Contextual bandit for intra-tier model selection

**Why**: Within a tier, multiple models may qualify. Static selection ("always pick TIER_COMPLEX") wastes the opportunity to learn which model is best *for this kind of query*. [Online Multi-LLM Selection via Contextual Bandits (arXiv:2506.17670)](https://arxiv.org/abs/2506.17670) provides a LinUCB-based algorithm with provable sublinear regret for this exact problem.

**Design**:
- **Context features per request**: query embedding (reduced to 32-64 dims via PCA), task type one-hot, prompt length bucket, tool-count bucket, prior tool-result count, conversation depth.
- **Arms**: one arm per (provider, model) pair that qualifies for the tier.
- **Reward**: `quality_score - λ * normalized_cost - μ * normalized_latency`, where λ and μ are tunable knobs (start at λ=0.3, μ=0.1).
- **Algorithm**: LinUCB with α=1.5 initially, decay to α=0.5 over time as confidence builds.
- **Exploration**: 5% of requests routed randomly to a non-optimal arm, decaying to 1% over 30 days.

**Files to add**:
- `src/routing/bandit.js` (LinUCB implementation; can use [`contextual-bandits` npm package](https://github.com/singhsidhukuldeep/contextual-bandits) as reference)
- `src/routing/reward-pipeline.js` (constructs reward from quality, cost, latency)
- `data/bandit-state.json` (persisted weights, refreshed nightly)

**Files to change**:
- `src/routing/index.js`: replace `selectModel(tier)` with `bandit.pick(tier, context)`
- `src/routing/telemetry.js`: pipe quality scores into `reward-pipeline.js` after each completion

**Expected impact**: 5-15% cumulative improvement over Phase 3, plus the system continues improving as the bandit learns. The bigger benefit is *robustness to model changes* — when Anthropic releases a new Sonnet variant, the bandit auto-discovers whether it's better.

### 4.2 Closed-loop quality feedback

**Problem**: `quality-scorer.js` produces a score per response. Currently it's recorded and never read.

**Fix**:
- The reward pipeline (above) uses it directly.
- Add a **user feedback channel**: if the request includes an `x-feedback-score` header (e.g., from Open Cowork's thumbs up/down), it overrides the heuristic quality score.
- Add a **regret estimator** that periodically samples K requests, re-runs them through a strictly-better model (Opus), and compares quality. If the routed model consistently underperforms vs Opus by >10%, raise an alert and adjust tier thresholds.

**Files to add**:
- `src/routing/regret-estimator.js`
- `scripts/sample-regret.js` (runs nightly, samples 0.5% of yesterday's requests)

**Expected impact**: Confidence that the router isn't silently regressing quality. Catches drift before users do.

### 4.3 Drift detection

**Why**: Provider behavior changes silently. Anthropic ships a new Sonnet revision. Ollama updates a local model. The router's learned weights may become stale. [VentureBeat's drift monitoring piece](https://venturebeat.com/infrastructure/monitoring-llm-behavior-drift-retries-and-refusal-patterns) and [orq.ai's 2026 guide](https://orq.ai/blog/model-vs-data-drift) describe the production patterns.

**Design**:
- **Input drift**: track the distribution of query embeddings week-over-week. Compute population stability index (PSI) over coarse embedding buckets. PSI > 0.2 triggers a warning; > 0.3 triggers a full retrain of the kNN index.
- **Output drift**: track refusal rates, average output length, latency distribution per model. A 30%+ shift in any of these over a 7-day window flags the model for review.
- **Action**: drift detection writes to a `drift_alerts` table in the telemetry DB. The dashboard surfaces it. Auto-retraining is opt-in (set `LYNKR_AUTO_RETRAIN=true`).

**Files to add**:
- `src/routing/drift-monitor.js`
- `src/dashboard/drift-panel.js` (UI for the existing dashboard)

### 4.4 A/B routing policies (shadow mode)

**Why**: Any time you change the router, you risk regression. The safe pattern is to run the new policy in shadow mode: it picks a model, but the *production* policy is what actually serves the request. Compare predictions for N days, then promote.

**Design**:
- `src/routing/index.js` exposes both `policy_active` and `policy_shadow`.
- Shadow policy receives every request, makes its decision, logs it. Doesn't actually invoke the model.
- A weekly report compares: % of requests where shadow disagrees with active, projected cost delta, projected quality delta (using the regret estimator on the disagreed-on subset).
- Promote shadow to active when: agreement rate > 70% on cost-equivalent decisions, projected quality delta within ±2%, projected cost delta favorable.

**Files to add**:
- `src/routing/shadow-mode.js`
- `scripts/compare-policies.js`

**Expected impact**: Removes the fear factor from routing changes. Lets you ship Phase 3/4 changes safely.

---

## 6. Cross-cutting Concerns

### 6.1 Per-tenant policy customization

Today, Lynkr applies the same routing policy to every request. Different downstream tools have different cost tolerances:

- A **deepsec security scan** can afford to wait for Opus on auth-touching files.
- An **Open Cowork chat-turn** wants the lowest-latency option that maintains quality.
- A **Claude Code session** at 11pm probably wants to bias toward local.

**Fix**: Add `LYNKR_TENANT_ID` header support. Each tenant can override:
- Tier thresholds
- λ/μ reward weights (cost vs latency)
- Maximum acceptable latency
- Blocked models (e.g., "never route to OpenAI")

Store per-tenant config in `data/tenants/<id>.json`. Default to global config when absent.

### 6.2 Hierarchical budget controls

The current cost-optimizer tracks session spend in-memory. A real production system needs hierarchical budgets ([TrueFoundry's pattern](https://www.truefoundry.com/blog/observability-in-ai-gateway)):

- **Virtual key budget** (per API key)
- **Team budget** (per tenant)
- **Customer budget** (per downstream user)
- **Organization budget** (global ceiling)

Budget checks must be in-memory atomic ops (Redis `INCRBY` with TTL, or local Map with periodic disk flush). Adding a database query per request kills latency.

**Files to add**:
- `src/budget/hierarchical-budget.js`
- `src/api/middleware/budget-enforcer.js`

### 6.3 Latency budget enforcement

Every request should carry an effective deadline. If the user is paying $0.03 of latency budget, the router must avoid models with P95 > deadline.

**Fix**: Add `LYNKR_DEADLINE_MS` header support. The router reads `latency-tracker.js` for P95 per candidate model and excludes models whose P95 exceeds the deadline.

### 6.4 RouterArena evaluation

[RouterArena (arXiv:2510.00202)](https://arxiv.org/abs/2510.00202) is the canonical evaluation framework as of late 2025. It tests:
- Query-answer accuracy (uses Bloom's taxonomy for difficulty)
- Cost (using realistic price models)
- Routing optimality (vs. oracle router)
- Robustness (against noisy inputs)
- Latency overhead

**Action**: integrate RouterArena into the CI pipeline. After Phase 3 ships, every PR that touches `src/routing/` runs a subset of RouterArena and reports the delta. MIRT-BERT is currently the cost-leader on this benchmark — that's the target to beat.

---

## 7. Sequencing Recommendation

**Sprint 1 (1 week)**: Phase 1.1 (tokenizer), 1.2 (cost-optimizer activation), 1.3 (context check). These are pure code changes, no new dependencies. Ship together.

**Sprint 2 (1 week)**: Phase 1.4 (quality feedback to thresholds), 1.5 (per-model latency). Adds telemetry analysis but no model changes.

**Sprint 3 (2 weeks)**: Phase 2.1 (semantic cache). This is the biggest single-feature ROI in the plan. Build it carefully — cache invalidation bugs are nasty.

**Sprint 4 (1 week)**: Phase 2.2 (pricing freshness), 2.3 (output ratio learning). Polish.

**Sprint 5-6 (4 weeks)**: Phase 3.1 (kNN router) OR Phase 3.2 (ModernBERT) — pick one. Phase 3.3 (cascade) in parallel.

**Sprint 7 (2 weeks)**: Phase 3.4 (risk classifier). Lower priority but cleans up false positives.

**Sprint 8-10 (6 weeks)**: Phase 4 in order — bandit, then quality feedback loop, then drift detection, then shadow mode (which actually de-risks everything earlier so consider doing 4.4 first if your team is risk-averse).

Total: ~16-20 weeks for the full plan. The first 6 weeks deliver ~70% of the cost savings.

---

## 8. What to Measure

Track these metrics weekly. They're the ones that matter:

| Metric | Source | Target |
|---|---|---|
| Average cost per request | telemetry.js | Reduce by 60-85% from baseline |
| P95 routing decision latency | routing telemetry | < 50ms (current ~5-20ms) |
| Tier accuracy | regret-estimator | > 85% (vs. oracle) |
| Cache hit rate (post Phase 2) | semantic-cache.js | > 50% |
| Cascade acceptance rate (post Phase 3) | cascade.js | 60-80% on MEDIUM tier |
| Bandit regret (post Phase 4) | bandit.js | Sublinear; <5% vs oracle after 30 days |
| Provider failover events | latency-tracker | Track but don't optimize against |

---

## 9. Risks and Mitigation

**Risk 1 — kNN index gets stale.** Mitigation: rebuild nightly from telemetry. Fall back to ModernBERT classifier if index is unavailable.

**Risk 2 — Semantic cache returns wrong response.** Mitigation: high similarity threshold (0.95), short TTL on time-sensitive queries, opt-out header (`x-no-cache: 1`).

**Risk 3 — Cascade adds latency on hard queries.** Mitigation: skip cascade for queries the kNN router scores as confidently complex. Cascade only when uncertain.

**Risk 4 — Bandit explores too aggressively, hurts user-visible quality.** Mitigation: cap exploration rate at 5% (decaying to 1%). Only explore among models within a quality envelope (don't randomly route a hard query to a 7B model).

**Risk 5 — Per-tenant policies fragment the data — bandit can't learn.** Mitigation: tenants share global priors. Per-tenant adjustments are deltas on top of the global model.

---

## 10. References

### Routing & Cascading
- [Rethinking Predictive Modeling for LLM Routing: When Simple kNN Beats Complex Learned Routers (arXiv:2505.12601)](https://arxiv.org/abs/2505.12601)
- [A Unified Approach to Routing and Cascading for LLMs (arXiv:2410.10347)](https://arxiv.org/abs/2410.10347)
- [Dynamic Model Routing and Cascading for Efficient LLM Inference: A Survey (arXiv:2603.04445)](https://arxiv.org/abs/2603.04445)
- [FrugalGPT (arXiv:2305.05176)](https://arxiv.org/abs/2305.05176) + [GitHub](https://github.com/stanford-futuredata/FrugalGPT)
- [GATEKEEPER: Improving Model Cascades Through Confidence Tuning (arXiv:2502.19335)](https://arxiv.org/pdf/2502.19335)
- [Cost-Saving LLM Cascades with Early Abstention (arXiv:2502.09054)](https://arxiv.org/html/2502.09054v1)
- [C3PO: Optimized LLM Cascades with Probabilistic Cost Constraints (arXiv:2511.07396)](https://arxiv.org/html/2511.07396)
- [Speculative Cascades (Google Research)](https://research.google/blog/speculative-cascades-a-hybrid-approach-for-smarter-faster-llm-inference/)

### Benchmarks & Evaluation
- [RouteLLM (arXiv:2406.18665)](https://arxiv.org/pdf/2406.18665) + [LMSYS blog](https://www.lmsys.org/blog/2024-07-01-routellm/) + [GitHub](https://github.com/lm-sys/RouteLLM)
- [RouterBench (arXiv:2403.12031)](https://arxiv.org/abs/2403.12031) + [Martian GitHub](https://github.com/withmartian/routerbench)
- [RouterArena (arXiv:2510.00202)](https://arxiv.org/abs/2510.00202) + [HuggingFace blog](https://huggingface.co/blog/JerryPotter/who-routes-the-routers) + [GitHub](https://github.com/RouteWorks/RouterArena)

### Learned Routers
- [Anyscale: Building an LLM Router for High-Quality and Cost-Effective Responses](https://www.anyscale.com/blog/building-an-llm-router-for-high-quality-and-cost-effective-responses)
- [NVIDIA Prompt Task and Complexity Classifier](https://huggingface.co/nvidia/prompt-task-and-complexity-classifier)
- [ModernBERT fine-tuning guide](https://www.philschmid.de/fine-tune-modern-bert-in-2025)

### Bandits & Online Learning
- [Online Multi-LLM Selection via Contextual Bandits (arXiv:2506.17670)](https://arxiv.org/abs/2506.17670)
- [Contextual Bandits library](https://github.com/singhsidhukuldeep/contextual-bandits)

### Semantic Caching
- [GPT Semantic Cache (arXiv:2411.05276)](https://arxiv.org/abs/2411.05276)
- [Bifrost's semantic caching plugin](https://www.truefoundry.com/blog/semantic-caching)
- [Portkey's semantic cache](https://portkey.ai/blog/reducing-llm-costs-and-latency-semantic-cache/)

### Production Systems
- [Martian Model Router](https://diginomica.com/martian-model-router-jumpstarts-ai-cost-optimization)
- [NotDiamond awesome-ai-model-routing curated list](https://github.com/Not-Diamond/awesome-ai-model-routing)
- [LogRocket: LLM routing in production](https://blog.logrocket.com/llm-routing-right-model-for-requests/)
- [TrueFoundry: AI Gateway Observability](https://www.truefoundry.com/blog/observability-in-ai-gateway)
- [TrueFoundry: Hierarchical Budget Controls](https://dev.to/pranay_batta/building-hierarchical-budget-controls-for-multi-tenant-llm-gateways-ceo)

### Drift & Monitoring
- [VentureBeat: Monitoring LLM behavior](https://venturebeat.com/infrastructure/monitoring-llm-behavior-drift-retries-and-refusal-patterns)
- [Orq.ai: Model vs Data Drift in LLMs (2026 Guide)](https://orq.ai/blog/model-vs-data-drift)
