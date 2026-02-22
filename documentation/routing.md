# Intelligent Routing & Model Tiering

Lynkr's intelligent routing system automatically selects the optimal model and provider for each request based on complexity analysis, agentic workflow detection, and cost optimization.

---

## Overview

```
Request → Force Patterns → Tool Thresholds → Complexity Analysis → Agentic Detection → Tier Selection → Cost Optimization → Provider
```

The routing pipeline evaluates every incoming request through multiple stages to determine which model tier and provider should handle it. Simple requests go to cheap/local models, complex ones go to powerful cloud models.

**Key benefits:**
- 60-80% cost reduction by routing simple tasks to cheaper models
- Better quality on complex tasks by using capable models when needed
- Automatic agentic workflow detection with tier upgrades
- Multi-source pricing for optimal cost decisions

---

## 4-Tier Model System

Every request is mapped to one of four complexity tiers:

| Tier | Score Range | Description | Example Tasks |
|------|-----------|-------------|---------------|
| **SIMPLE** | 0-25 | Greetings, simple Q&A, confirmations | "Hello", "What is a variable?", "Yes" |
| **MEDIUM** | 26-50 | Code reading, simple edits, research | "Read this file", "Fix this typo", "Search for X" |
| **COMPLEX** | 51-75 | Multi-file changes, debugging, architecture | "Refactor auth module", "Debug this race condition" |
| **REASONING** | 76-100 | Complex analysis, security audits, novel problems | "Security audit", "Design microservices architecture" |

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
TIER_SIMPLE=ollama:llama3.2                  # Score 0-25 → Ollama (free, local)
TIER_MEDIUM=openai:gpt-4o                    # Score 26-50 → OpenAI
TIER_COMPLEX=databricks:claude-sonnet-4-5    # Score 51-75 → Databricks
TIER_REASONING=databricks:claude-opus-4-6    # Score 76-100 → Databricks
```

In this setup, a "Hello" message (score ~5) routes to Ollama. A "Refactor the auth module" message (score ~65) routes to Databricks. `MODEL_PROVIDER=ollama` ensures the server waits for Ollama at startup but does not affect where complex requests go.

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

## Complexity Scoring Algorithm

The complexity analyzer implements 4 phases to produce a score from 0-100.

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

When `ROUTING_WEIGHTED_SCORING=true`, the analyzer uses a 15-dimension weighted scoring system instead of the standard additive scoring:

```
Score = Sum of (dimension_value * weight) for all 15 dimensions
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

Certain requests bypass the scoring algorithm entirely:

### Force Local (always local model)
- Greetings: "hi", "hello", "thanks", "bye"
- Time queries: "what time is it"
- Confirmations: "yes", "no", "ok", "sure"
- Help requests: "help", "commands"

### Force Cloud (always cloud model)
- Security audits/reviews
- Architecture design/review
- Complete codebase refactoring
- Code/PR reviews
- Complex debugging
- Production incidents

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
| `ROUTING_WEIGHTED_SCORING` | `false` | Enable 15-dimension weighted scoring |
| `ROUTING_AGENTIC_DETECTION` | `true` | Enable agentic workflow detection |
| `ROUTING_COST_OPTIMIZATION` | `false` | Enable cost-based model selection |
| `OLLAMA_MAX_TOOLS_FOR_ROUTING` | `3` | Max tools before routing away from Ollama |
| `OPENROUTER_MAX_TOOLS_FOR_ROUTING` | `15` | Max tools before routing away from OpenRouter |
| `OLLAMA_EMBEDDINGS_MODEL` | *(none)* | Embeddings model for Phase 4 similarity |

### Smart Tool Selection Modes

| Mode | Threshold | Behavior |
|------|-----------|----------|
| `aggressive` | 60 | More requests go to local (saves cost) |
| `heuristic` | 40 | Balanced local/cloud split |
| `conservative` | 25 | More requests go to cloud (better quality) |

---

## Routing Decision Flow

```
1. Are all 4 TIER_* env vars configured?
   └─ No → Return static provider (MODEL_PROVIDER), skip all routing

2. Does content match FORCE_LOCAL patterns?
   └─ Yes → Route to local provider

3. Does content match FORCE_CLOUD patterns?
   └─ Yes → Route to best cloud provider (requires FALLBACK_ENABLED)

4. Analyze complexity:
   └─ Calculate score 0-100 (standard or weighted mode)

5. Optional: Embeddings adjustment:
   └─ Adjust score by -10 to +10 based on semantic similarity

6. Agentic detection:
   └─ If agentic → Boost score, enforce minimum tier
   └─ If AUTONOMOUS → Force cloud provider

7. Map score to tier (SIMPLE/MEDIUM/COMPLEX/REASONING)

8. Select provider:model from matching TIER_* env var

9. Optional: Cost optimization
   └─ Check for cheaper model that can handle the tier

10. Return { provider, model, tier, score, method }
```

---

## Source Files

| File | Description |
|------|-------------|
| `src/routing/index.js` | Main routing orchestrator (`determineProviderSmart()`) |
| `src/routing/complexity-analyzer.js` | 4-phase complexity analysis, 15-dimension weighted scoring |
| `src/routing/agentic-detector.js` | Agentic workflow detection and classification |
| `src/routing/model-tiers.js` | Tier definitions, model selection from `TIER_*` env vars |
| `src/routing/model-registry.js` | Multi-source pricing (LiteLLM, models.dev, Databricks fallback) |
| `src/routing/cost-optimizer.js` | Cost tracking, cheapest model finder, savings calculation |

---

## Next Steps

- **[Features Overview](features.md)** - Architecture and request flow
- **[Token Optimization](token-optimization.md)** - Cost reduction strategies
- **[Provider Configuration](providers.md)** - Setting up providers
- **[Production Guide](production.md)** - Deploy with routing enabled
