# Token Optimization Guide

Comprehensive guide to Lynkr's token optimization strategies that achieve 60-80% cost reduction.

---

## Overview

Lynkr reduces token usage by **60-80%** through 6 intelligent optimization phases. At 100,000 requests/month, this translates to **$77k-$115k annual savings**.

---

## Cost Savings Breakdown

### Real-World Example

**Scenario:** 100,000 requests/month, 50k input tokens, 2k output tokens per request

| Provider | Without Lynkr | With Lynkr (60% savings) | Monthly Savings | Annual Savings |
|----------|---------------|-------------------------|-----------------|----------------|
| **Claude Sonnet 4.5** | $16,000 | $6,400 | **$9,600** | **$115,200** |
| **GPT-4o** | $12,000 | $4,800 | **$7,200** | **$86,400** |
| **Ollama (Local)** | API costs | **$0** | **$12,000+** | **$144,000+** |

---

## 6 Optimization Phases

### Phase 1: Smart Tool Selection (50-70% reduction)

**Problem:** Sending all tools to every request wastes tokens.

**Solution:** Intelligently filter tools based on request type.

**How it works:**
- **Chat queries** → Only send Read tool
- **File operations** → Send Read, Write, Edit tools
- **Git operations** → Send git_* tools
- **Code execution** → Send Bash tool

**Example:**
```
Original: 30 tools × 150 tokens = 4,500 tokens
Optimized: 3 tools × 150 tokens = 450 tokens
Savings: 90% (4,050 tokens saved)
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

### Phase 6: Conversation Compression (15-25% reduction)

**Problem:** Long conversation history accumulates tokens.

**Solution:** Compress old messages while keeping recent ones detailed.

**How it works:**
- Last 5 messages: Full detail
- Messages 6-20: Summarized
- Messages 21+: Archived (not sent)

**Example:**
```
20-turn conversation without compression: 100,000 tokens
With compression: 25,000 tokens (last 5 full + 15 summarized)
Savings: 75% (75,000 tokens saved)
```

**Configuration:**
```bash
# Automatic - no configuration needed
# Lynkr manages conversation history
```

---

## Combined Savings

When all 6 phases work together:

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

- **[GitHub Discussions](https://github.com/vishalveerareddy123/Lynkr/discussions)** - Ask questions
- **[GitHub Issues](https://github.com/vishalveerareddy123/Lynkr/issues)** - Report issues
