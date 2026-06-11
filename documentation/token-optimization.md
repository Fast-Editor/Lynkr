# Token Optimization Guide

Comprehensive guide to Lynkr's token optimization strategies — benchmarked on real agentic coding workloads.

---

## Overview

Lynkr reduces tokens sent to the model through multiple independent mechanisms. Benchmarked results on Claude Code / Cursor sessions:

| Optimization | Measured Reduction | Scenario |
|---|---|---|
| **Smart tool selection** | **47–60%** | 14-tool request (read or write task) |
| **TOON JSON compression** | **87.6%** | Large grep/file-read tool result (60-item array) |
| **Tool-result compression (RTK)** | up to **87.6%** | grep/test/git/lint/build/log/JSON tool output |
| **Semantic cache** | **100% on hit, 171ms** | Paraphrased repeat query |
| MCP Code Mode | **96%** | 100+ MCP tool schemas → 4 meta-tools |
| History compression | up to 80% | Long multi-turn sessions |

At 100,000 requests/month on a tool-heavy agentic workload, this translates to **$77k–$115k annual savings**.

---

## Benchmarked Savings Breakdown

**Measured on identical prompts, same backend provider (June 2026):**

| Scenario | Tokens without Lynkr | Tokens with Lynkr | Reduction |
|---|---|---|---|
| 14-tool read request | 1,042 | **547** | **47%** |
| 14-tool write request | 1,043 | **412** | **60%** |
| JSON grep result (60 items) | 3,458 | **427** | **87.6%** |
| Semantic cache (2nd call) | 2,857 | **0** | **100%** |

---

## Estimated Savings at Scale

**Scenario:** 100,000 requests/month, 50k input tokens, 2k output tokens per request

| Provider | Without Lynkr | With Lynkr | Monthly Savings | Annual Savings |
|----------|---------------|-------------------------|-----------------|----------------|
| **Claude Sonnet 4.5** | $16,000 | $6,400 | **$9,600** | **$115,200** |
| **GPT-4o** | $12,000 | $4,800 | **$7,200** | **$86,400** |
| **Ollama (Local)** | API costs | **$0** | **$12,000+** | **$144,000+** |

---

## Optimization Phases

### Phase 0: MCP Code Mode (96% reduction for MCP tools)

**Problem:** Sending 100+ MCP tool schemas consumes massive tokens (~17,500 tokens).

**Solution:** Replace all MCP tool schemas with 4 meta-tools that enable lazy tool discovery.

**How it works:**
- **Without Code Mode:** Every MCP tool schema sent on every request
- **With Code Mode:** Only 4 meta-tools sent (~700 tokens)
  - `mcp_list_tools` → Discover available tools (compact listing)
  - `mcp_tool_info` → Load full schema for one specific tool
  - `mcp_tool_docs` → Get usage examples + parameters
  - `mcp_execute` → Execute a tool by name with JSON args

**Example workflow:**
```
Turn 1: mcp_list_tools({ server_id: "github" })
  → Returns: ["create_issue", "list_prs", "merge_pr", ...]

Turn 2: mcp_tool_info({ server_id: "github", tool_name: "create_issue" })
  → Returns: { inputSchema: { title: string, body: string, ... } }

Turn 3: mcp_execute({
    server_id: "github",
    tool_name: "create_issue",
    arguments: { title: "Bug", body: "..." }
  })
```

**Token savings:**
```
Without Code Mode: 100 tools × 175 tokens = 17,500 tokens
With Code Mode: 4 meta-tools × 175 tokens = 700 tokens
Savings: 96% (16,800 tokens saved)
```

**Trade-off:** Requires 3 sequential tool calls (discover → inspect → execute) instead of 1 direct call. This adds latency but saves massive context in MCP-heavy setups.

**Configuration:**
```bash
# Enable MCP Code Mode
CODE_MODE_ENABLED=true

# Tool list cache TTL in milliseconds (default: 60000 = 1 minute)
CODE_MODE_CACHE_TTL=60000
```

**Inspired by:** Bifrost's Code Mode architecture.

---

### Phase 1: Smart Tool Selection (47–60% measured reduction)

**Problem:** Sending all tool schemas on every request wastes tokens. A read-only query doesn't need Write, Edit, Bash, or Git schemas.

**Solution:** Classifies each request and strips irrelevant tool definitions before forwarding.

**How it works:**
- **Chat queries** → Only Read tool
- **File operations** → Read, Write, Edit tools
- **Git operations** → git_* tools
- **Code execution** → Bash tool

**Benchmarked on 14-tool Claude Code session:**
```
Read task:  1,042 tokens raw → 547 tokens after selection  (−47%)
Write task: 1,043 tokens raw → 412 tokens after selection  (−60%)
```

**Configuration:**
```bash
# Automatic - no configuration needed
# Lynkr detects request type and filters tools
```

---

### Phase 2: Prompt Caching (30-45% reduction)

**Problem:** Repeated system prompts consume tokens.

**Solution:** Cache and reuse prompts across requests.

**How it works:**
- SHA-256 hash of prompt
- LRU cache with TTL (default: 5 minutes)
- Cache hit = free tokens

**Example:**
```
First request: 2,000 token system prompt
Subsequent requests: 0 tokens (cache hit)
10 requests: Save 18,000 tokens (90% reduction)
```

**Configuration:**
```bash
# Enable prompt caching (default: enabled)
PROMPT_CACHE_ENABLED=true

# Cache TTL in milliseconds (default: 300000 = 5 minutes)
PROMPT_CACHE_TTL_MS=300000

# Max cached entries (default: 64)
PROMPT_CACHE_MAX_ENTRIES=64
```

---

### Phase 3: Memory Deduplication (20-30% reduction)

**Problem:** Duplicate memories inject redundant context.

**Solution:** Deduplicate memories before injection.

**How it works:**
- Track last N memories injected
- Skip if same memory was in last 5 requests
- Only inject novel context

**Example:**
```
Original: 5 memories × 200 tokens × 10 requests = 10,000 tokens
With dedup: 5 memories × 200 tokens + 3 new × 200 = 1,600 tokens
Savings: 84% (8,400 tokens saved)
```

**Configuration:**
```bash
# Enable memory deduplication (default: enabled)
MEMORY_DEDUP_ENABLED=true

# Lookback window for dedup (default: 5)
MEMORY_DEDUP_LOOKBACK=5
```

---

### Phase 4: Tool Response Truncation (15-25% reduction)

**Problem:** Long tool outputs (file contents, bash output) waste tokens.

**Solution:** Intelligently truncate tool responses.

**How it works:**
- File Read: Limit to 2,000 lines
- Bash output: Limit to 1,000 lines
- Keep most relevant portions
- Add truncation indicator

**Example:**
```
Original file read: 10,000 lines = 50,000 tokens
Truncated: 2,000 lines = 10,000 tokens
Savings: 80% (40,000 tokens saved)
```

**Configuration:**
```bash
# Automatic - no configuration needed
# Built into Read and Bash tools
```

---

### Phase 5: Dynamic System Prompts (10-20% reduction)

**Problem:** Long system prompts for simple queries.

**Solution:** Adapt prompt complexity to request type.

**How it works:**
- **Simple chat**: Minimal system prompt (500 tokens)
- **File operations**: Medium prompt (1,000 tokens)
- **Complex multi-tool**: Full prompt (2,000 tokens)

**Example:**
```
10 simple queries with full prompt: 10 × 2,000 = 20,000 tokens
10 simple queries with minimal: 10 × 500 = 5,000 tokens
Savings: 75% (15,000 tokens saved)
```

**Configuration:**
```bash
# Automatic - no configuration needed
# Lynkr detects request complexity
```

---

### Phase 6: Conversation Compression with Distill (20-40% reduction)

**Problem:** Long conversation history accumulates tokens, especially with repetitive tool outputs.

**Solution:** Compress old messages using Distill algorithms while keeping recent ones detailed.

**How it works:**
- Last 5 messages: Full detail
- Messages 6-20: Summarized
- Messages 21+: Archived (not sent)
- **Distill structural dedup**: Repetitive tool results across history are collapsed
- **Delta rendering**: Sequential similar tool outputs show only changes
- **ANSI/whitespace normalization**: Cleans up noisy terminal output

**Distill Algorithms (ported from [samuelfaj/distill](https://github.com/samuelfaj/distill)):**

| Algorithm | What it does | Savings |
|-----------|-------------|---------|
| Structural similarity | Jaccard index on normalized line signatures — detects near-duplicate tool results | 30-50% on repetitive outputs |
| Delta rendering | Only sends added/removed lines between sequential results | 60-90% when re-reading same files |
| Block deduplication | Collapses consecutive similar sections within a single output | 20-40% on verbose logs |
| Bad distillation detection | Prevents compression when it would lose too much information | Quality guard |
| Text normalization | Strips ANSI codes, normalizes whitespace and line endings | 5-10% on terminal output |

**Example:**
```
20-turn conversation without compression: 100,000 tokens
With Distill compression: 20,000 tokens
  - Old messages summarized: -60,000 tokens
  - Duplicate tool results collapsed: -15,000 tokens
  - Delta rendering on re-reads: -5,000 tokens
Savings: 80% (80,000 tokens saved)
```

**Configuration:**
```bash
# Automatic - no configuration needed
# Distill algorithms are built into the compression pipeline
HISTORY_COMPRESSION_ENABLED=true     # Enable conversation compression (default: true)
HISTORY_KEEP_RECENT_TURNS=10         # Keep last N turns verbatim (default: 10)
HISTORY_SUMMARIZE_OLDER=true         # Summarize older turns (default: true)
```

---

### Phase 7: Tool-Result Compression (up to 87.6% on tool output)

**Problem:** Tool results dominate agentic token usage. A single `grep`, test run, `git diff`, or JSON API response can be thousands of tokens — most of it boilerplate the model doesn't need to reason over.

Lynkr compresses `tool_result` blocks **in-process before forwarding** (no added latency), via two complementary mechanisms.

#### 7a. RTK pattern compression

Detects the *shape* of a tool result and rewrites it to a compact, information-preserving summary. Each detector only fires when it recognizes the format; unrecognized text passes through unchanged.

| Detector | What it compresses | Example outcome |
|----------|--------------------|-----------------|
| `test_output` | jest/vitest/pytest/cargo/go test logs | Keep the summary line + failures, drop passing-test noise |
| `git_diff` | `git diff` | Per-file `+adds/-dels` with capped change lines |
| `git_status` | `git status` | Branch + staged/modified/untracked lists |
| `git_log` | `git log` | One line per commit (`<sha7> <subject> (author, date)`) |
| `lint_output` | eslint/tsc/ruff/clippy/biome | Counts grouped by rule, not every occurrence |
| `build_output` | npm/cargo/webpack | Errors + capped warnings + success line |
| `container_output` | docker/kubectl tables | Header + first N rows + “+M more” |
| `json_response` | large JSON objects | Structural skeleton (search/fetch results preserved) |
| `grep_output` | `grep`/`rg` (`file:line:content`) | Grouped by file, capped at 10 matches/file |
| `directory_listing` | `ls`/`find`/`tree` | Grouped by directory with counts |
| `large_file` | long source files | Imports + signatures skeleton |
| `dedup_log` | repetitive logs | Collapses consecutive duplicate lines |
| `smart_truncate` | very long unmatched output | Keeps head + tail, drops the middle |

**Tier-aware thresholds** — compression only kicks in above a size that scales with the routing tier, so cheap models get aggressive compression and reasoning models get the full picture:

| Tier | Compress if result exceeds |
|------|----------------------------|
| SIMPLE | 300 chars |
| MEDIUM | 800 chars |
| COMPLEX | 2,000 chars |
| REASONING | never |

**Lossless recovery (tee):** the full original is stashed for 5 minutes and a pointer (`[full: tee_…]`) is appended to the compressed result. The model — or you — can fetch the original via `GET /tee/:id` if the detail is actually needed.

Always on (no configuration). Metrics: `GET /metrics/tool-compression`.

#### 7b. TOON compression (binary JSON encoding)

For large JSON tool results (arrays of objects, API payloads), TOON re-encodes the structure into a far denser representation than pretty-printed JSON — **87.6% reduction** on a 60-item grep array in benchmarks. Plain text and small payloads are left untouched.

```bash
TOON_ENABLED=true        # opt-in (default: false)
TOON_MIN_BYTES=4096      # only compress payloads larger than this
TOON_FAIL_OPEN=true      # on any encode error, forward the original (default: true)
TOON_LOG_STATS=true      # log per-call compression stats
```

---

### Phase 8: Headroom Context Compression (Optional, 47-92% reduction)

**Problem:** Even with all other optimizations, large requests can still exceed context limits.

**Solution:** [Headroom](headroom.md) is a Python sidecar that applies ML-based compression.

**How it works:**
- Smart Crusher: Statistical JSON field compression
- Cache Aligner: Stabilizes dynamic content for provider cache hits
- CCR: Reversible compression with on-demand retrieval
- Rolling Window: Token budget enforcement
- LLMLingua (optional): BERT-based 20x compression

**Auto-rebuild:** When you run `npm start`, Lynkr automatically rebuilds the Headroom Docker image if source files changed — ensuring you always run the latest code.

**Configuration:**
```bash
HEADROOM_ENABLED=true
# See headroom.md for full configuration reference
```

---

## Combined Savings

When all phases work together:

**Example Request Flow:**

1. **Original request**: 50,000 input tokens
   - System prompt: 2,000 tokens
   - Tools: 4,500 tokens (30 tools)
   - Memories: 1,000 tokens (5 memories)
   - Conversation: 20,000 tokens (20 messages)
   - User query: 22,500 tokens

2. **After optimization**: 12,500 input tokens
   - System prompt: 0 tokens (cache hit)
   - Tools: 450 tokens (3 relevant tools)
   - Memories: 200 tokens (deduplicated)
   - Conversation: 5,000 tokens (compressed)
   - User query: 22,500 tokens (same)

3. **Savings**: 75% reduction (37,500 tokens saved)

---

## Monitoring Token Usage

### Real-Time Tracking

```bash
# Check metrics endpoint
curl http://localhost:8081/metrics | grep lynkr_tokens

# Output:
# lynkr_tokens_input_total{provider="databricks"} 1234567
# lynkr_tokens_output_total{provider="databricks"} 234567
# lynkr_tokens_cached_total 500000
```

### Per-Request Logging

```bash
# Enable token logging
LOG_LEVEL=info

# Logs show:
# {"level":"info","tokens":{"input":1250,"output":234,"cached":750}}
```

---

## Best Practices

### 1. Enable All Optimizations

```bash
# All optimizations are enabled by default
# No configuration needed
```

### 2. Use Tier-Based Routing

```bash
# Route simple requests to free Ollama, complex to cloud
# Set all 4 TIER_* env vars to enable tier-based routing
TIER_SIMPLE=ollama:llama3.2
TIER_MEDIUM=openrouter:openai/gpt-4o-mini
TIER_COMPLEX=azure-openai:gpt-4o
TIER_REASONING=azure-openai:gpt-4o
FALLBACK_ENABLED=true
FALLBACK_PROVIDER=databricks
```

### 3. Monitor and Tune

```bash
# Check cache hit rate
curl http://localhost:8081/metrics | grep cache_hits

# Adjust cache size if needed
PROMPT_CACHE_MAX_ENTRIES=128  # Increase for more caching
```

---

## ROI Calculator

Calculate your potential savings:

**Formula:**
```
Monthly Requests = 100,000
Avg Input Tokens = 50,000
Avg Output Tokens = 2,000
Cost per 1M Input = $3.00
Cost per 1M Output = $15.00

Without Lynkr:
Input Cost = (100,000 × 50,000 ÷ 1,000,000) × $3 = $15,000
Output Cost = (100,000 × 2,000 ÷ 1,000,000) × $15 = $3,000
Total = $18,000/month

With Lynkr (60% savings):
Total = $7,200/month

Savings = $10,800/month = $129,600/year
```

**Your numbers:**
- Monthly requests: _____
- Avg input tokens: _____
- Avg output tokens: _____
- Provider cost: _____

**Result:** $_____ saved per year

---

## Next Steps

- **[Installation Guide](installation.md)** - Install Lynkr
- **[Provider Configuration](providers.md)** - Configure providers
- **[Production Guide](production.md)** - Deploy to production
- **[FAQ](faq.md)** - Common questions

---

## Getting Help

- **[GitHub Discussions](https://github.com/Fast-Editor/Lynkr/discussions)** - Ask questions
- **[GitHub Issues](https://github.com/Fast-Editor/Lynkr/issues)** - Report issues
