# Intelligent Routing & Model Tiering

Lynkr automatically routes each request to the right model based on complexity — no caller changes, no manual labels.

---

## Overview

```
Request → Thinking-Budget → Force Patterns → Risk → Anchor Score + LLM Classifier
        → Agentic Detection → Tier Selection → Cost Optimization → kNN/Bandit → Provider
```

**Benchmarked routing accuracy (July 15, 2026 — head-to-head vs LiteLLM Auto Router v2):**

11 routing scenarios, identical prompts to both proxies on the same backends, both judged against the same acceptable-tier sets (`MODE=routing node benchmark-tier-routing.js`):

| Router | Routing-correct | Notes |
|---|---|---|
| **Lynkr** | **11/11** | embedding intent score on cleaned user text + guards |
| LiteLLM v1.94 Auto Router v2, heuristic default | 4/11 | all misses under-routed hard work to the free local model |
| LiteLLM v1.94 Auto Router v2, LLM classifier | 6–8/11 | paid GPT-5.2 call per request; non-deterministic across runs |

Scenarios include the live-incident regressions (injected `<system-reminder>` immunity, suggestion-mode side requests, agentic detection, session pin escape, payload-envelope invariance). Caveat: the scenario set derives from Lynkr's own regression suite — see [BENCHMARK_REPORT.md](../BENCHMARK_REPORT.md) addendum for methodology and fairness notes.

**Key benefits:**
- Routes simple requests to cheap/local models automatically
- Escalates complex and risk-sensitive requests to capable cloud models
- Automatic agentic workflow detection with tier upgrades
- Anchor-embedding intent classification + LLM second-opinion classifier (Phase 6, 2026-07-19) fixes topic-vs-difficulty confounding — `list the exports from this file` now correctly routes MEDIUM instead of REASONING
- 15× reduction in expensive-tier over-routing vs anchor-only baseline (0.6% vs ~15% on eval set)

---

## 4-Tier Model System

Every request is mapped to one of four complexity tiers. Bands reflect the calibrated defaults (see `data/calibrated-thresholds.json`); score to tier is a straight lookup by band.

| Tier | Score Range | Description | Example Tasks |
|------|-----------|-------------|---------------|
| **SIMPLE** | 0-19 | Greetings, simple Q&A, confirmations | "Hello", "What is a variable?", "Yes" |
| **MEDIUM** | 20-50 | Code reading, simple edits, research | "Read this file", "Fix this typo", "List exports from X" |
| **COMPLEX** | 51-75 | Multi-file changes, debugging, architecture | "Refactor auth module", "Debug this race condition", "Architecture review" |
| **REASONING** | 76-100 | Formal proofs, security audits, novel algorithms | "Prove correctness", "Security audit", "Design BFT consensus variant" |

The scorer produces a continuous 0-100 value from anchor-embedding classification plus (optionally) an LLM classifier's tier hint (see [Anchor Intent Scoring](#anchor-intent-scoring-ws7) and [LLM Difficulty Classifier](#llm-difficulty-classifier-phase-6) below).

### Configuration

Tiers are configured via mandatory environment variables in `provider:model` format:

```bash
# Required - one per tier
TIER_SIMPLE=ollama:llama3.2
TIER_MEDIUM=openai:gpt-4o
TIER_COMPLEX=openai:o1-mini
TIER_REASONING=openai:o1

# Examples with other providers
TIER_SIMPLE=ollama:qwen2.5-coder
TIER_MEDIUM=databricks:databricks-claude-sonnet-4-5
TIER_COMPLEX=azure-openai:gpt-5.2-chat
TIER_REASONING=databricks:databricks-claude-opus-4-6
```

If a model name is given without a provider prefix, the default provider (`MODEL_PROVIDER`) is used.

### Routing Precedence

There are three routing-related settings. Here is exactly how they interact:

#### 1. `TIER_*` Environment Variables (Highest Priority)

When **all four** `TIER_*` vars are set (`TIER_SIMPLE`, `TIER_MEDIUM`, `TIER_COMPLEX`, `TIER_REASONING`), tiered routing is **active**. Every incoming request is scored for complexity (0-100), mapped to a tier, and routed to the `provider:model` specified in the matching `TIER_*` var.

In this mode, `MODEL_PROVIDER` is **not consulted** for routing decisions. The provider comes directly from the `TIER_*` value (e.g., `ollama:llama3.2` routes to Ollama, `openai:gpt-4o` routes to OpenAI).

If any of the four `TIER_*` vars are missing, tiered routing is **completely disabled** and the system falls back to `MODEL_PROVIDER`.

#### 2. `MODEL_PROVIDER` (Default / Fallback)

`MODEL_PROVIDER` controls routing in two scenarios:

- **When tiered routing is disabled** (any `TIER_*` var missing) — all requests go to the provider set in `MODEL_PROVIDER`, regardless of complexity. This is static routing.
- **When a `TIER_*` value has no provider prefix** (e.g., `TIER_SIMPLE=llama3.2` instead of `TIER_SIMPLE=ollama:llama3.2`) — `MODEL_PROVIDER` is used as the default provider for that tier.

Even when tiered routing is active and overrides it for request routing, `MODEL_PROVIDER` is still used for:
- **Startup checks** — e.g., if `MODEL_PROVIDER=ollama`, the server waits for Ollama to be reachable before accepting requests
- **Provider discovery API** (`/v1/providers`) — marks which provider is "primary" in the response
- **Embeddings routing** — the OpenAI-compatible router checks `MODEL_PROVIDER` for embedding provider selection

**Always set `MODEL_PROVIDER`** even when using tier routing.

#### 3. `PREFER_OLLAMA` (Removed)

`PREFER_OLLAMA` is **deprecated and has no effect**. If set, a warning is logged at startup:

```
[DEPRECATION] PREFER_OLLAMA is removed. Use TIER_* env vars for routing.
```

To route simple requests to Ollama, use `TIER_SIMPLE=ollama:<model>` instead.

#### Summary Table

| Configuration | Routing Behavior |
|---|---|
| All 4 `TIER_*` set | Tier routing active. Each request scored and routed to its tier's `provider:model`. `MODEL_PROVIDER` ignored for routing. |
| 1-3 `TIER_*` set | Tier routing **disabled**. All requests go to `MODEL_PROVIDER` (static). |
| No `TIER_*` set | Static routing. All requests go to `MODEL_PROVIDER`. |
| `TIER_*` value without provider prefix | `MODEL_PROVIDER` used as the default provider for that tier. |
| `PREFER_OLLAMA` set | No effect. Deprecation warning logged. |

#### Example: Mixed Local + Cloud Setup

```bash
MODEL_PROVIDER=ollama                        # Startup checks + default provider
TIER_SIMPLE=ollama:llama3.2                  # Score 0-19 → Ollama (free, local)
TIER_MEDIUM=openai:gpt-4o                    # Score 20-50 → OpenAI
TIER_COMPLEX=databricks:claude-sonnet-4-5    # Score 51-75 → Databricks
TIER_REASONING=databricks:claude-opus-4-6    # Score 76-100 → Databricks
```

In this setup, a "Hello" message (score 0, force_local) routes to Ollama. A "Refactor the auth module" message (score ~65) routes to Databricks. `MODEL_PROVIDER=ollama` ensures the server waits for Ollama at startup but does not affect where complex requests go.

#### Example: Config B — Local → Mid-Tier → Top-Tier Ladder

Real production ladder used with the classifier: local for cheap traffic, mid-tier for substantive work, top-tier reserved for genuine deep reasoning.

```bash
MODEL_PROVIDER=ollama
TIER_SIMPLE=ollama:minimax-m2.5:cloud             # Greetings, acks
TIER_MEDIUM=ollama:minimax-m2.5:cloud             # One-off tasks, focused Qs
TIER_COMPLEX=z.ai:GLM-5.2                         # Architecture, refactor, systemic
TIER_REASONING=azure-anthropic:claude-opus-4.8    # Proofs, security audits, formal reasoning
```

Traffic distribution on this ladder after enabling the LLM classifier: most day-to-day coding traffic stays on Ollama (SIMPLE + MEDIUM), architectural / systemic work goes to GLM (COMPLEX), and only genuinely deep or governance-critical work reaches Claude (REASONING via force patterns or high confidence classifier calls). See [LLM Difficulty Classifier](#llm-difficulty-classifier-phase-6).

### Tier Config File

Additional tier preferences (fallback models per provider) can be defined in `config/model-tiers.json`:

```json
{
  "tiers": {
    "SIMPLE": { "preferred": { "ollama": ["llama3.2"], "openai": ["gpt-4o-mini"] } },
    "MEDIUM": { "preferred": { "openai": ["gpt-4o"], "anthropic": ["claude-sonnet-4-20250514"] } },
    "COMPLEX": { "preferred": { "openai": ["o1-mini"], "anthropic": ["claude-sonnet-4-20250514"] } },
    "REASONING": { "preferred": { "openai": ["o1"], "anthropic": ["claude-opus-4-20250514"] } }
  },
  "localProviders": {
    "ollama": { "free": true, "defaultTier": "SIMPLE" },
    "llamacpp": { "free": true, "defaultTier": "SIMPLE" },
    "lmstudio": { "free": true, "defaultTier": "SIMPLE" }
  }
}
```

---

## Anchor Intent Scoring (WS7)

The primary scorer since WS7 (2026-07). Solves the "envelope inflation" problem where the same semantic ask scored 31 offline vs 56 live once tools/history/system-reminders were attached.

**Mechanism** (`src/routing/intent-score.js`):

1. **Extract cleaned user text** — strip `<system-reminder>`, `<turn-context>`, `<task-notification>`, harness continuation summaries, Lynkr's own injected notices. Walk back through the message history until we find text the user actually authored this turn.
2. **Embed** the cleaned text with nomic-embed-text (via local Ollama).
3. **Classify** by cosine similarity against per-class anchor centroids loaded from `config/difficulty-anchors.json` (or `data/difficulty-anchors.json` if present):

   | Class | Value | Band | Anchors are examples of |
   |---|---|---|---|
   | `trivial` | 10 | `[0, 25]` | greetings, one-word acks, trivial factoids |
   | `substantive` | 45 | `[26, 50]` | one specific mechanical task, focused explanation |
   | `heavyweight` | 68 | `[51, 75]` | systemic design, multi-file review, architecture |
   | `frontier` | 85 | `[76, 100]` | formal proof, security audit, novel algorithm (added 2026-07-19) |

4. **Softmax-blend** the class similarities into a continuous score with `temperature = 0.05`.
5. **Frontier safety floor** — the `frontier` class only participates in the blend if its similarity clears `FRONTIER_MIN_SIM = 0.50`. Below the floor, scoring behaves like the 3-class baseline and the score can't reach REASONING via text alone (still reachable via triggers).

**Contracts** (tested in `test/intent-score.test.js`):

- **Envelope invariance**: `score(text) === score(text + fat tool schemas + reminders + long history)`. The lexical scorer can never pass this; it's the whole reason WS7 exists.
- **Rung containment**: text-only score can only reach REASONING via the frontier class + min-sim floor. Lexical fallback path stays clamped at ≤75.
- **Paraphrase stability**: embeddings close in cosine space produce scores within a small band.

**Failure fallback**: if the embedder is down or centroids can't be built, falls back to a lexical score of the SAME cleaned text (still envelope-invariant, just noisier, clamped ≤75).

---

## LLM Difficulty Classifier (Phase 6)

Added 2026-07-19. A second-opinion classifier that catches anchor-embedding false positives. The core problem it solves: embeddings measure *topical similarity*, not difficulty — `list the exports from this file` embedded near frontier examples because it shares technical vocabulary, and got score 76 (REASONING) even though the underlying task is trivially easy for a small model.

**Mechanism** (`src/routing/difficulty-classifier.js`):

1. Reads cleaned user text (same extraction as the anchor scorer).
2. Sends a 4-way classification prompt to a small local model via Ollama with `format: 'json'`.
3. Model returns `{"tier": "SIMPLE|MEDIUM|COMPLEX|REASONING", "confidence": 0.0-1.0}`.
4. `_reconcile()` in `intent-score.js` combines the anchor score with the classifier's tier:

   | Anchor's implied tier vs classifier | Action |
   |---|---|
   | Agree | Use anchor score as-is |
   | Classifier lower, `confidence ≥ 0.6` | Trust classifier — set score to midpoint of classifier's target band (fixes over-routing) |
   | Classifier higher, `confidence ≥ 0.8` | Trust classifier — safety-gated escalation |
   | Classifier higher, `confidence < 0.8` | Keep anchor (don't escalate on weak signal) |

**Model** — hardcoded to `qwen2.5:3b` on ollama (`CLASSIFIER_MODEL` constant in `difficulty-classifier.js`). Decoupled from the SIMPLE tier model so SIMPLE traffic can run a more capable generalist while the classifier stays fast and cheap. Latency: ~500ms warm, cache-hit 0ms.

**Skip conditions** (return null, anchor-only mode):

- Text length < 15 chars
- Caller matched a `FORCE_*` regex already (deterministic path wins)
- `risk.level === 'high'` (already forced upstream)
- Cache hit (LRU, 500 entries, keyed by `sha256(text.trim().toLowerCase())`)
- Ollama unavailable / model call fails / 10s timeout

**Kill-switch**: `CLASSIFIER_ENABLED = true` constant at the top of `difficulty-classifier.js`. Set to `false` to fall back to anchor-only scoring. No env var per project policy.

**Validation** (`scripts/validate-difficulty-classifier.js` on 381-prompt eval set):

| Model | Hand-labeled accuracy | MEDIUM→REASONING misroutes | Latency |
|---|---|---|---|
| minimax-m2.5 (thinking model) | 85.1% | 1 (0.3%) | 4.6s |
| qwen 1.5b (too small) | 60.6% | 24 (7.5%) | 330ms |
| **qwen 3b (shipped)** | **87.3%** | **0 on hand-labeled** | **500ms warm** |
| Anchor-only baseline (no classifier) | 65.7% | ~15% | 0ms |

The eval set (`data/difficulty-eval.jsonl`, gitignored) is built from RouterArena + gpt4_dataset unused rows plus 85 hand-labeled coding-agent prompts. Per-source accuracy varies dramatically (hand: 87%, gpt4_dataset: 46%, RouterArena: 14%) because benchmark difficulty labels don't map cleanly to routing intent — hand labels are the trustworthy signal.

**Building the eval set**: `node scripts/build-eval-set.js` (fetches HF datasets via public datasets-server API, no API key or LLM judge required).

**Running validation**: `node scripts/validate-difficulty-classifier.js` — persists per-row results to `data/difficulty-eval-results.jsonl` for manual review.

### Auto-provisioning (`lynkr init` + server boot)

`src/routing/classifier-setup.js` handles ollama + model detection so users don't have to know the plumbing.

- **`lynkr init`** — interactive: detects `ollama` on PATH; if missing, prints the platform-specific install command (brew on macOS, curl on Linux, direct download on Windows) and exits cleanly. Never auto-runs `curl | sh` — that's a supply-chain footgun. If ollama is present, prompts the user to `ollama pull qwen2.5:3b`, then warms it up.
- **Server boot** — non-blocking: runs the same detect-and-check after `app.listen()`, but never blocks startup. If ollama or the model is missing, logs a warning and lets the classifier fall through to null (anchor-only scoring). Users see one line telling them exactly which command to run.

**Deferred to a follow-up (per user directive):**

- Fine-tuning `qwen2.5:3b` on labeled classification data (LoRA infra, GPU, curated training set)
- Canary verification on every startup (assert known-good classifications succeed before accepting traffic)

---

## Complexity Scoring Algorithm

The legacy 5-phase scorer runs on the FULL payload and is retained as the fallback path when the anchor scorer can't run (Ollama down, no centroids). In anchor mode (default), the score from `scoreIntent()` overwrites the lexical score.

### Phase 1: Basic Scoring

Three components scored independently:

**Token Count (0-20 points):**

| Tokens | Score |
|--------|-------|
| < 500 | 0 |
| 500-999 | 4 |
| 1,000-1,999 | 8 |
| 2,000-3,999 | 12 |
| 4,000-7,999 | 16 |
| 8,000+ | 20 |

**Tool Count (0-20 points):**

| Tools | Score |
|-------|-------|
| 0 | 0 |
| 1-3 | 4 |
| 4-6 | 8 |
| 7-10 | 12 |
| 11-15 | 16 |
| 16+ | 20 |

**Task Type (0-25 points):**
- Greetings / yes-no: 0-2
- Simple questions: 3
- General non-technical: 5
- Technical content: 10
- Refactoring: 16
- New implementation: 18
- From scratch: 20
- Entire codebase scope: 22
- Force cloud patterns (security audit, architecture review): 25

### Phase 2: Advanced Classification

Additional scoring on top of Phase 1:

**Code Complexity (0-20 points):**

| Pattern | Points |
|---------|--------|
| Multi-file operations | +5 |
| Architecture concerns | +5 |
| Security | +4 |
| Concurrency | +3 |
| Performance | +3 |
| Database operations | +3 |
| Testing | +2 |

**Reasoning Requirements (0-15 points):**

| Pattern | Points |
|---------|--------|
| Step-by-step reasoning | +4 |
| Trade-off analysis | +4 |
| General analysis | +3 |
| Planning | +3 |
| Edge cases | +2 |

**Conversation Bonus:**
- 6-10 messages: +2
- 11+ messages: +5

The standard score is the sum of all components, capped at 100.

### Weighted Scoring Mode (15 Dimensions)

When `ROUTING_WEIGHTED_SCORING=true`, the analyzer uses a 13-dimension weighted scoring system instead of the standard additive scoring:

```
Score = Sum of (dimension_value * weight) for all 13 dimensions
```

#### Dimension Weights

**Content Analysis (35% total):**

| Dimension | Weight | Measures |
|-----------|--------|----------|
| tokenCount | 0.08 | Request size (token estimate) |
| promptComplexity | 0.10 | Sentence structure, average length |
| technicalDepth | 0.10 | Technical keyword density |
| domainSpecificity | 0.07 | Number of specialized domains (security, ML, distributed, database, frontend, devops) |

**Tool Analysis (25% total):**

| Dimension | Weight | Measures |
|-----------|--------|----------|
| toolCount | 0.08 | Number of tools in request |
| toolComplexity | 0.10 | Weighted average of tool complexity (Bash=0.9, Write=0.8, Edit=0.7, Read=0.3, Glob/Grep=0.2) |
| toolChainPotential | 0.07 | Sequential operation indicators ("then", "after", "step 1") |

**Reasoning Requirements (25% total):**

| Dimension | Weight | Measures |
|-----------|--------|----------|
| multiStepReasoning | 0.10 | Step-by-step / planning patterns |
| codeGeneration | 0.08 | Code creation requests |
| analysisDepth | 0.07 | Trade-off / analysis patterns |

**Context Factors (15% total):**

| Dimension | Weight | Measures |
|-----------|--------|----------|
| conversationDepth | 0.05 | Message count in conversation |
| priorToolUsage | 0.05 | Tool results already in conversation |
| ambiguity | 0.05 | Inverse of request specificity |

Each dimension is scored 0-100 independently, then multiplied by its weight. The final score is the rounded sum.

### Phase 3: Metrics Tracking

Every routing decision is recorded in-memory (last 1,000 decisions) for analytics:
- Total decisions, local vs. cloud split
- Average complexity score
- Per-provider and per-tier distribution

Metrics are exposed via the `/metrics` endpoint and `X-Lynkr-*` response headers.

### Phase 4: Embeddings-Based Similarity (Optional)

When an embeddings model is configured (`OLLAMA_EMBEDDINGS_MODEL`), the analyzer can compare request content against reference embeddings for complex and simple tasks using cosine similarity. This produces a score adjustment of -10 to +10 points.

### Phase 5: Structural Analysis via Graphify (Optional)

When [Graphify](https://github.com/safishamsi/graphify) is enabled (`CODE_GRAPH_ENABLED=true`), the analyzer extracts file paths from the request and queries Graphify's knowledge graph for structural complexity signals.

**How it works:**
1. File paths are extracted from tool_use blocks, system prompts, and message text (supports both Anthropic and OpenAI formats)
2. Three parallel queries are sent to Graphify: `get_neighbors` (blast radius), `god_nodes`, and `graph_stats`
3. Results are scored and added to the complexity score

**Scoring (capped at +35):**

| Signal | Points | Condition |
|--------|--------|-----------|
| High blast radius | +15 | > 30 affected files |
| Medium blast radius | +10 | > 10 affected files |
| Low blast radius | +5 | > 5 affected files |
| Deep dependencies | +5 | Dependency depth > 4 |
| Infrastructure file | +10 | Editing Docker, CI/CD, config files |
| Low test coverage | +5 | < 30% test files in affected set |
| God node touched | +10 | Editing a hub class many things depend on |
| Low community cohesion | +5 | Cohesion < 0.15 with multiple communities |

**God node detection:** Graphify identifies the most-connected entities in the codebase (hub classes, central modules). Editing these has outsized impact — the router upgrades the request to a stronger model.

**Community cohesion:** Graphify uses Leiden clustering to group related code. Low cohesion means loosely-coupled code where changes are harder to reason about safely.

**Configuration:**
```bash
CODE_GRAPH_ENABLED=true
CODE_GRAPH_COMMAND=graphify           # CLI command (default: graphify)
CODE_GRAPH_WORKSPACE=/path/to/repo    # Optional — auto-detected from file paths
CODE_GRAPH_TIMEOUT=10000              # Query timeout in ms (default: 10000)
```

**Workspace auto-detection:** You don't need to set `CODE_GRAPH_WORKSPACE`. Lynkr automatically detects the workspace from absolute file paths in the request by finding their common directory prefix. This works per-request, so different conversations about different repos route correctly.

---

## Agentic Workflow Detection

The agentic detector identifies multi-step tool chains and autonomous agent patterns, boosting the complexity tier accordingly.

### Agent Types

| Type | Score Boost | Min Tier | Description |
|------|------------|----------|-------------|
| **SINGLE_SHOT** | +0 | SIMPLE | Simple request-response, no tool chains |
| **TOOL_CHAIN** | +15 | MEDIUM | Sequential tool usage (read -> edit -> test) |
| **ITERATIVE** | +25 | COMPLEX | Retry loops, debugging cycles, iterative refinement |
| **AUTONOMOUS** | +35 | REASONING | Open-ended tasks, full autonomy, complex decision making |

### Detection Signals

The detector evaluates 6 signal categories:

**1. Tool Count**
- 4-5 tools: +8
- 6-10 tools: +15
- 11+ tools: +25

**2. Agentic Tools Present** (Bash, Write, Edit, Task, Git, Test)
- 1 agentic tool: +8
- 2-3 agentic tools: +15
- 4+ agentic tools: +25

**3. Prior Tool Results** (already in an agentic loop)
- 1-2 tool results: +10
- 3-5 tool results: +20
- 6+ tool results: +30

**4. Content Pattern Matching**
- Autonomous patterns ("figure out", "solve", "make it work"): +25
- Iterative patterns ("keep trying", "debug", "retry"): +20
- Tool chain patterns ("then use", "next step", "step 1"): +15
- Multi-file work: +15
- Planning required: +10
- Implementation + testing: +15

**5. Conversation Depth**
- 5-8 messages: +6
- 9-15 messages: +12
- 16+ messages: +20

**6. Content Length**
- 2,000+ characters: +10

### Classification Thresholds

| Agent Type | Score Threshold | Additional Conditions |
|------------|----------------|----------------------|
| AUTONOMOUS | >= 60 | or autonomous pattern + score >= 40 |
| ITERATIVE | >= 40 | or deep tool loop + score >= 30 |
| TOOL_CHAIN | >= 20 | or many agentic tools present |
| SINGLE_SHOT | < 20 | Default |

When an agentic workflow is detected (`score >= 25`), the complexity score is boosted by the agent type's `scoreBoost` value, and the tier is upgraded to at least the agent type's `minTier`.

---

## Force Patterns

Certain requests bypass the scoring algorithm entirely. Priority order (highest first):

### Force REASONING (added 2026-07-19)

Deterministic escalation to the REASONING tier. Checked before force_cloud. `src/routing/complexity-analyzer.js:FORCE_REASONING_PATTERNS`:

| Trigger | Regex | Rationale |
|---|---|---|
| `security audit`, `penetration test`, `vulnerability scan` | `/\b(security\s+(audit\|review\|assessment)\|penetration\s+test\|vulnerability\s+scan)\b/i` | Security/governance work belongs on the trusted top-tier provider |
| `ultrathink`, `ultra think`, `ultra-think` | `/\b(ultrathink\|ultra[\s-]?think)\b/i` | Claude Code's think/ultrathink modes; matches all common spellings |
| `think hard/deeply/carefully/step-by-step/through this` | `/\b(think\s+(hard\|deeply\|carefully\|step[\s-]by[\s-]step\|through\s+this))/i` | Explicit user request for deep reasoning |
| `prove`, `proof`, `formal proof`, `verify`, `verification` | `/\b(prove\|proof\|formal\s+proof\|verify\|verification)\b/i` | Formal reasoning tasks |
| `from first principles` | `/\b(from\s+first\s+principles)\b/i` | First-principles reasoning |
| `reason through/about/from the/this` | `/\b(reason\s+(through\|about\|from)\s+(the\|this))/i` | Multi-step reasoning phrasing |

### Thinking-Budget Trigger — removed 2026-07-19

**Not used for routing.** Claude Code Enterprise on Haiku 4.5 attaches `thinking.budget_tokens = 31999` to *every* request as its default extended-thinking behavior; it's a model-level setting, not a user routing intent. A threshold-based trigger dragged every casual `"hi"` into REASONING and out through subscription passthrough. The value is now logged at debug level only, purely informational. Explicit deep-reasoning intent is caught unambiguously by `FORCE_REASONING_PATTERNS` on the message text (`ultrathink`, `prove`, `security audit`, `from first principles`, …).

### Force Local (always SIMPLE model)
- Greetings: "hi", "hello", "thanks", "bye"
- Time queries: "what time is it"
- Confirmations: "yes", "no", "ok", "sure"
- Help requests: "help", "commands"

### Force Cloud (always COMPLEX tier)
- Architecture design/review
- Complete codebase refactoring
- Code/PR reviews
- Complex debugging
- Production incidents

(`security audit` moved to Force REASONING as of 2026-07-19 — security/governance goes to the trusted top-tier provider under config B.)

### Risk-Based Escalation

High-risk requests (detected by `src/routing/risk-classifier.js` — auth/middleware paths, credential handling, unsafe eval patterns) route to REASONING under config B, not COMPLEX. Config-B rationale: security-critical asks belong on the trusted top-tier provider, not the mid-tier general model. See `src/routing/index.js:_determineProviderSmartInner` risk override branch.

---

## Cost Optimization

When `ROUTING_COST_OPTIMIZATION=true`, the router checks if a cheaper model can handle the determined tier.

### Model Registry

Pricing data is fetched from three sources (in priority order):

1. **LiteLLM** (highest priority) - Community-maintained pricing from [BerriAI/litellm](https://github.com/BerriAI/litellm)
2. **models.dev** - API pricing aggregator
3. **Databricks Fallback** - Hardcoded pricing for common models (Claude, Llama, GPT, Gemini, DBRX)

Pricing data is cached locally in `data/model-prices-cache.json` with a 24-hour TTL. Background refresh happens automatically when the cache is stale.

### Cost Tracking

The optimizer tracks costs at both session and global levels:
- Per-request cost recording (input + output tokens)
- Per-model, per-provider, per-tier breakdowns
- Savings calculation when routing to cheaper alternatives

### Pricing Lookup

The registry supports flexible model name lookup:
- Direct match: `gpt-4o`
- Provider prefix stripping: `databricks-claude-sonnet-4-5` -> `claude-sonnet-4-5`
- Fuzzy matching for partial names

---

## Routing Headers

Every response includes routing metadata in `X-Lynkr-*` headers:

| Header | Description | Example |
|--------|-------------|---------|
| `X-Lynkr-Routing-Method` | How the decision was made | `tier_config`, `force`, `tool_threshold`, `agentic`, `cost_optimized` |
| `X-Lynkr-Provider` | Selected provider | `databricks`, `ollama`, `openrouter` |
| `X-Lynkr-Complexity-Score` | Complexity score (0-100) | `42` |
| `X-Lynkr-Complexity-Threshold` | Score threshold for cloud routing | `40` |
| `X-Lynkr-Routing-Reason` | Human-readable reason | `force_local_pattern`, `autonomous_workflow` |
| `X-Lynkr-Tier` | Selected model tier | `SIMPLE`, `MEDIUM`, `COMPLEX`, `REASONING` |
| `X-Lynkr-Model` | Selected model | `llama3.2`, `gpt-4o`, `claude-opus-4-6` |
| `X-Lynkr-Agentic` | Agentic workflow type (if detected) | `TOOL_CHAIN`, `ITERATIVE`, `AUTONOMOUS` |
| `X-Lynkr-Cost-Optimized` | Whether cost optimization was applied | `true` |

---

## Configuration Reference

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `TIER_SIMPLE` | *required* | Model for simple tier (`provider:model`) |
| `TIER_MEDIUM` | *required* | Model for medium tier (`provider:model`) |
| `TIER_COMPLEX` | *required* | Model for complex tier (`provider:model`) |
| `TIER_REASONING` | *required* | Model for reasoning tier (`provider:model`) |
| `SMART_TOOL_SELECTION_MODE` | `heuristic` | Scoring mode: `aggressive` (threshold=60), `heuristic` (threshold=40), `conservative` (threshold=25) |
| `ROUTING_WEIGHTED_SCORING` | `false` | Enable 13-dimension weighted scoring |
| `ROUTING_AGENTIC_DETECTION` | `true` | Enable agentic workflow detection |
| `ROUTING_COST_OPTIMIZATION` | `false` | Enable cost-based model selection |
| `OLLAMA_MAX_TOOLS_FOR_ROUTING` | `3` | Max tools before routing away from Ollama |
| `OPENROUTER_MAX_TOOLS_FOR_ROUTING` | `15` | Max tools before routing away from OpenRouter |
| `OLLAMA_EMBEDDINGS_MODEL` | *(none)* | Embeddings model for Phase 4 similarity |
| `CODE_GRAPH_ENABLED` | `false` | Enable Graphify structural analysis (Phase 5) |
| `CODE_GRAPH_COMMAND` | `graphify` | Graphify CLI command |
| `CODE_GRAPH_WORKSPACE` | `process.cwd()` | Default workspace (auto-detected per request) |
| `CODE_GRAPH_TIMEOUT` | `10000` | Graphify query timeout in ms |

### Smart Tool Selection Modes

| Mode | Threshold | Behavior |
|------|-----------|----------|
| `aggressive` | 60 | More requests go to local (saves cost) |
| `heuristic` | 40 | Balanced local/cloud split |
| `conservative` | 25 | More requests go to cloud (better quality) |

---

## Routing Safety Features

### Vision Capability Guard

Automatically upgrades to vision-capable models when images are detected in the request.

**When it activates:**
- Payload contains `type: 'image'` or `type: 'image_url'` content blocks
- Selected model lacks `vision: true` capability in model registry

**What it does:**
1. Searches for cheapest vision-capable model at or above current tier
2. Upgrades model and tier if necessary
3. Tags routing method with `+vision_guard`

**Example:**
```
Request: Image + "What's in this screenshot?"
Initial: MEDIUM → ollama:llama3.2 (no vision)
After guard: MEDIUM → anthropic:claude-sonnet-4-6 (vision: true)
```

**Tier escalation:** If no vision model exists at current tier, escalates to next tier up (SIMPLE→MEDIUM→COMPLEX→REASONING). If REASONING tier has no vision model, logs warning and keeps original selection (request will likely fail upstream).

**No configuration needed** — automatic based on model registry vision field.

---

### kNN Ambiguous Confidence Escalation

When kNN neighbor voting is split (no clear model winner), escalates tier to prioritize quality over cost.

**Confidence thresholds:**
- **>0.7 (high):** Trust kNN model recommendation, override heuristic
- **0.4-0.7 (ambiguous):** Escalate tier one step for safety
- **≤0.4 (low):** Ignore kNN, use heuristic selection

**What it does (ambiguous range):**
1. Current tier bumped one step: SIMPLE→MEDIUM→COMPLEX→REASONING
2. Select model from upgraded tier
3. Tag routing method with `+knn_ambiguous_escalate`

**Example:**
```
Request: "Refactor the auth module"
Heuristic: MEDIUM → openai:gpt-4o-mini (score 42)
kNN: confidence=0.55 (neighbors split)
Result: COMPLEX → anthropic:claude-opus-4-7
```

**REASONING ceiling:** REASONING tier never escalates (already at top).

**Graceful fallback:** If upgraded tier is unconfigured (e.g., missing `TIER_COMPLEX`), keeps current tier.

**Requires:** kNN enabled (`ROUTING_KNN_ENABLED=true`) with index of 1000+ samples at `data/knn/index.hnsw`.

---

## Routing Decision Flow

```
1. Are all 4 TIER_* env vars configured?
   └─ No → Return static provider (MODEL_PROVIDER), skip all routing

2. Thinking-budget trigger (OAuth intent path):
   └─ thinking.budget_tokens ≥ 10000 → REASONING tier (bypass scoring)

3. Risk analysis:
   └─ High risk → REASONING tier (config B — was COMPLEX pre-2026-07-19)

4. Force patterns (priority order):
   a. FORCE_REASONING (ultrathink / prove / security audit / …) → REASONING tier
   b. FORCE_LOCAL (hi / thanks / yes) → SIMPLE tier
   c. FORCE_CLOUD (architecture review / code review / …) → COMPLEX tier

5. Anchor intent scoring (WS7):
   └─ Extract cleaned user text (strip envelope: reminders, tool_results, harness)
   └─ Embed with nomic-embed-text
   └─ Cosine-classify vs 4 anchor centroids (trivial/substantive/heavyweight/frontier)
   └─ Softmax-blend → continuous 0-100 score
   └─ frontier requires similarity ≥ FRONTIER_MIN_SIM (0.50) to participate

6. LLM difficulty classifier (Phase 6):
   └─ Call qwen2.5:3b via Ollama, get {tier, confidence}
   └─ Reconcile with anchor score:
        agree → keep anchor score
        classifier lower + conf ≥ 0.6 → trust classifier (fix over-routing)
        classifier higher + conf ≥ 0.8 → trust classifier (gated escalation)
   └─ Skipped if: text<15 chars, force-matched, risk=high, cache hit

7. Fallback path if anchor scorer failed:
   └─ Lexical clean-text score (envelope-invariant, clamped ≤75)

8. Optional: Graphify structural analysis:
   └─ Query knowledge graph for blast radius, god nodes, community cohesion
   └─ Adjust score by up to +35

9. Agentic detection:
   └─ If agentic → Enforce minimum tier via base_tier + escalation ledger
   └─ If AUTONOMOUS → Force REASONING tier

10. Map score to tier via CLASS_BANDS (SIMPLE 0-19, MEDIUM 20-50, COMPLEX 51-75, REASONING 76-100)

11. Select provider:model from matching TIER_* env var

12. De-escalation (evidence-based):
    └─ If lower tier has ≥30 rows / avg quality ≥70 / errors <5% in last 7d → demote

13. Cost optimization:
    └─ If enabled + not high-risk → find cheaper qualifying model

14. Context window escalation:
    └─ If estimated tokens > model context → escalate to larger-context model

15. Vision capability guard:
    └─ If payload has images + model lacks vision → upgrade to vision model

16. kNN routing:
    └─ If confidence > 0.7 → override with kNN model
    └─ If confidence 0.4-0.7 → escalate tier (ambiguous — evidence-leashed)
    └─ If confidence ≤ 0.4 → ignore kNN

17. LinUCB bandit:
    └─ If multiple candidates → pick best via UCB score

18. Deadline filter:
    └─ If LYNKR-Deadline-Ms header → pick fastest qualifying model

19. Tenant policy override:
    └─ If tenant blocks model → replace via cost optimizer

20. Session affinity write / tier fallback chain wraps around all of the above
    (see src/routing/session-affinity.js and src/routing/tier-fallback.js)

21. Record telemetry (provider, tier, latency, quality score, classifier hint)

22. Return { provider, model, tier, score, method }
```

---

## Routing Telemetry

Every routing decision is recorded in a SQLite telemetry store (`.lynkr/telemetry.db`) for analysis and continuous improvement.

### Telemetry Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /v1/routing/stats` | Aggregated stats with latency percentiles per provider |
| `GET /v1/routing/stats/:provider` | Per-provider statistics |
| `GET /v1/routing/telemetry` | Raw telemetry records with query filters |
| `GET /v1/routing/accuracy` | Over/under-provisioned routing percentage |

### Recorded Fields

Each telemetry record captures 20+ fields including: request ID, provider, tier, complexity score, latency, quality score (0-100), token usage, whether fallback was used, retry count, error type, and Graphify signals (blast radius, god node, cohesion).

### Quality Scoring

Every response is scored 0-100 for quality using heuristic signals:

| Signal | Points |
|--------|--------|
| HTTP 200 status | +10 |
| Output tokens > 100 | +5 |
| Tools used in response | +10 |
| No fallback triggered | +5 |
| No retries needed | +5 |
| Error occurred | -30 |
| Fallback was used | -10 |
| Multiple retries | -10 |
| Latency > 30s | -10 |
| Tier mismatch (REASONING request got low output) | -15 |

### Latency Tracking

Per-provider latency is tracked in a 200-sample circular buffer. Statistics exposed:
- P50, P95, P99 latency
- Average latency
- Latency-based score penalty (-5 to +10 points)

---

## Source Files

| File | Description |
|------|-------------|
| `src/routing/index.js` | Main routing orchestrator (`determineProviderSmart()`) |
| `src/routing/intent-score.js` | WS7 anchor-embedding intent scorer + reconcile logic with classifier |
| `src/routing/difficulty-classifier.js` | Phase 6 LLM difficulty classifier (qwen2.5:3b via Ollama) |
| `src/routing/complexity-analyzer.js` | Legacy 5-phase complexity analysis (fallback path when anchor fails); `FORCE_*_PATTERNS` including `FORCE_REASONING_PATTERNS` |
| `src/routing/agentic-detector.js` | Agentic workflow detection and classification |
| `src/routing/model-tiers.js` | Tier definitions, model selection from `TIER_*` env vars |
| `src/routing/model-registry.js` | Multi-source pricing (LiteLLM, models.dev, Databricks fallback) |
| `src/routing/cost-optimizer.js` | Cost tracking, cheapest model finder, savings calculation |
| `src/routing/knn-router.js` | HNSW-based nearest-historical-query router |
| `src/routing/bandit.js` | LinUCB contextual bandit for intra-tier model selection |
| `src/routing/telemetry.js` | SQLite-backed routing telemetry store |
| `src/routing/quality-scorer.js` | Response quality scoring (0-100) |
| `src/routing/latency-tracker.js` | Per-provider latency tracking with percentiles |
| `src/routing/session-affinity.js` | Session pin (sticky provider) + drift-based re-decision |
| `src/routing/tier-fallback.js` | Tier fallback chain when primary provider errors |
| `config/difficulty-anchors.json` | Bundled hand-curated anchor set (13 anchors, 3 classes) |
| `data/difficulty-anchors.json` | Local override anchor set (gitignored, wins over `config/`) |
| `data/difficulty-anchors.vectors.json` | Embedding cache for anchor centroids |
| `data/difficulty-eval.jsonl` | 381-prompt eval set for classifier validation (gitignored) |
| `scripts/build-eval-set.js` | Builds `data/difficulty-eval.jsonl` from HF datasets |
| `scripts/validate-difficulty-classifier.js` | Runs classifier against eval set, per-source accuracy report |
| `scripts/mine-difficulty-anchors.js` | Mines RouterArena/gpt4_dataset for candidate anchor prompts |
| `scripts/validate-intent-anchors.js` | Compares anchor sets on a small hand-labeled eval |
| `src/tools/code-graph.js` | Graphify integration — knowledge graph queries for structural analysis |

---

## Next Steps

- **[Features Overview](features.md)** - Architecture and request flow
- **[Token Optimization](token-optimization.md)** - Cost reduction strategies
- **[Provider Configuration](providers.md)** - Setting up providers
- **[Production Guide](production.md)** - Deploy with routing enabled
