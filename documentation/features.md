# Core Features & Architecture

Complete guide to Lynkr's architecture, request flow, and core capabilities.

---

## Benchmarked Capabilities

Results from a live benchmark on real agentic coding workloads (June 2026):

| Feature | Result |
|---|---|
| TOON JSON compression | **87.6% reduction** on large JSON tool results |
| Semantic cache hit | **171ms response, 0 tokens billed** |
| Tier routing accuracy | Correctly escalated 4/4 test requests to the right tier |

→ [Full benchmark report](../BENCHMARK_REPORT.md)

---

## Architecture Overview

```
┌─────────────────┐
│ Claude Code CLI │  or  Cursor IDE
└────────┬────────┘
         │ Anthropic/OpenAI Format
         ↓
┌──────────────────────────────┐
│  Lynkr Proxy  (Port: 8081)   │
│                              │
│ • Compress JSON tool results │  ← up to 87.6% (TOON)
│ • Semantic cache lookup      │  ← 171ms hits, 0 tokens
│ • Route by complexity tier   │  ← 13-dimension scorer
│ • Format conversion          │
└────────┬─────────────────────┘
         │
         ├──→ Databricks (Claude 4.5)
         ├──→ AWS Bedrock (100+ models)
         ├──→ OpenRouter (100+ models)
         ├──→ Moonshot AI (Kimi K2)
         ├──→ Ollama (local, free)
         ├──→ llama.cpp (local, free)
         ├──→ Azure OpenAI (GPT-4o, o1)
         ├──→ OpenAI (GPT-4o, o3)
         └──→ Azure Anthropic (Claude)
```

---

## Request Flow

### 1. Request Reception

**Entry Points:**
- `/v1/messages` - Anthropic format (Claude Code CLI)
- `/v1/chat/completions` - OpenAI format (Cursor IDE)

**Middleware Stack:**
1. Load shedding (reject if overloaded)
2. Request logging (with correlation ID)
3. Validation (schema check)
4. Metrics collection
5. Route to orchestrator

### 2. Provider Routing

**4-Tier Intelligent Routing:**

Lynkr uses a multi-phase complexity analysis to route each request to the optimal model tier:

| Tier | Score | Routes To |
|------|-------|-----------|
| SIMPLE (0-25) | Greetings, simple Q&A | Cheap/local models (Ollama, llama.cpp) |
| MEDIUM (26-50) | Code reading, simple edits | Mid-range models (GPT-4o, Claude Sonnet) |
| COMPLEX (51-75) | Multi-file changes, debugging | Capable models (o1-mini, Claude Sonnet) |
| REASONING (76-100) | Security audits, architecture | Best models (o1, Claude Opus) |

Includes agentic workflow detection, 13-dimension weighted scoring, Graphify structural analysis, and cost optimization.
See **[Routing & Model Tiering](routing.md)** for full details.

**Automatic Fallback:**
- If primary provider fails → Use FALLBACK_PROVIDER
- Transparent to client
- No request failures due to provider issues

### 3. Format Conversion

**Anthropic → Provider:**
```javascript
{
  model: "claude-3-5-sonnet",
  messages: [...],
  tools: [...]
}
↓
Provider-specific format
(Databricks, Bedrock, OpenRouter, etc.)
```

**Provider → Anthropic:**
```javascript
Provider response
↓
{
  id: "msg_...",
  type: "message",
  role: "assistant",
  content: [{type: "text", text: "..."}],
  usage: {input_tokens: 123, output_tokens: 456}
}
```

### 4. Token Optimization

**6 Phases Applied:**
1. Prompt caching
2. Memory deduplication
3. Tool response truncation (Distill-powered)
4. Dynamic system prompts
5. Conversation compression with structural dedup
6. Headroom context compression (optional sidecar)

**Result:** 60-80% token reduction

**Distill Algorithms:** Lynkr ports core algorithms from [samuelfaj/distill](https://github.com/samuelfaj/distill) for intelligent compression:
- **Structural similarity** (Jaccard on normalized line signatures) — detects repetitive tool outputs
- **Delta rendering** — only sends changed content between sequential tool results
- **Bad distillation detection** — heuristics to detect when compression is worse than original
- **History dedup** — collapses structurally similar tool results across conversation history

### 5. Tool Execution

Tools always execute on the client (Claude Code CLI/Cursor) — Lynkr forwards `tool_use` blocks and the client sends results back:
- Tools execute on CLI side
- Access client filesystem
- Client-side command execution

### 6. Response Streaming

**Token-by-Token Streaming:**
```javascript
// SSE format
event: message
data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello"}}

event: message  
data: {"type":"content_block_delta","delta":{"type":"text_delta","text":" world"}}

event: done
data: {}
```

**Benefits:**
- Real-time user feedback
- Lower perceived latency
- Better UX for long responses

---

## Core Components

### API Layer (`src/api/`)

**router.js** - Main routes
- `/v1/messages` - Anthropic format
- `/v1/chat/completions` - OpenAI format
- `/v1/models` - List models
- `/v1/embeddings` - Generate embeddings
- `/health/*` - Health checks
- `/metrics` - Prometheus metrics

**Middleware:**
- `load-shedding.js` - Overload protection
- `request-logging.js` - Structured logging
- `metrics.js` - Metrics collection
- `validation.js` - Input validation
- `error-handling.js` - Error formatting

### Provider Clients (`src/clients/`)

**databricks.js** - Main invocation function
- `invokeModel()` - Route to provider
- `invokeDatabricks()` - Databricks API
- `invokeAzureAnthropic()` - Azure Anthropic
- `invokeOpenRouter()` - OpenRouter
- `invokeOllama()` - Ollama local
- `invokeLlamaCpp()` - llama.cpp
- `invokeBedrock()` - AWS Bedrock
- `invokeMoonshot()` - Moonshot AI (Kimi)
- `invokeZai()` - Z.AI (Zhipu AI)

**Format converters:**
- `openrouter-utils.js` - OpenAI format conversion
- `bedrock-utils.js` - Bedrock format conversion

**Reliability:**
- `circuit-breaker.js` - Circuit breaker pattern
- `retry.js` - Exponential backoff with jitter
- `resilience.js` - Combined resilience middleware

**Code Intelligence:**
- `code-graph.js` - Graphify knowledge graph integration (blast radius, god nodes, community cohesion)

### Orchestrator (`src/orchestrator/`)

**Request Loop:**
1. Receive request
2. Inject memories
3. Call provider
4. Forward tool_use blocks to the client (client executes and sends results back)
5. Extract memories
6. Return final response

**Features:**
- Policy enforcement
- Memory injection/extraction
- Token optimization

### MCP Tools (`src/mcp/`)

- Dynamic tool registration
- JSON-RPC 2.0 communication
- Sandbox isolation (optional)

### Caching (`src/cache/`)

**Prompt Cache:**
- LRU cache with TTL
- SHA-256 keying
- Hit rate tracking

**Memory Cache:**
- In-memory storage
- TTL-based eviction
- Automatic cleanup

### Database (`src/db/`)

**SQLite Databases:**
- `memories.db` - Long-term memories
- `sessions.db` - Conversation history
- `workspace-index.db` - Workspace metadata

**Operations:**
- Memory CRUD
- Session tracking
- FTS5 search

### Observability (`src/observability/`)

**Metrics:**
- Request rate, latency, errors
- Token usage, cache hits
- Circuit breaker state
- System resources

**Logging:**
- Structured JSON logs (pino)
- Request ID correlation
- Error tracking
- Performance profiling

### Configuration (`src/config/`)

**Environment Variables:**
- Provider configuration
- Feature flags
- Policy settings
- Performance tuning

**Validation:**
- Required field checks
- Type validation
- Value constraints
- Provider-specific validation

---

## Key Features

### 1. Multi-Provider Support

**12+ Providers:**
- Cloud: Databricks, Bedrock, OpenRouter, Azure, OpenAI, Moonshot AI, Z.AI, Vertex AI
- Local: Ollama, llama.cpp, LM Studio

**Hybrid Routing:**
- [4-tier intelligent routing](routing.md) with complexity scoring
- Automatic provider selection and transparent failover
- Agentic workflow detection with tier upgrades
- Cost optimization with multi-source pricing

### 2. Token Optimization

**60-80% Cost Reduction:**
- 6 optimization phases (including Distill-powered compression)
- $77k-$115k annual savings
- Automatic optimization
- Structural dedup of repetitive tool outputs
- Delta rendering for sequential similar results

### 3. Long-Term Memory

**Titans-Inspired:**
- Surprise-based storage
- Semantic search (FTS5)
- Multi-signal retrieval
- Automatic extraction

### 4. Graphify Code Intelligence

**Knowledge Graph-Powered Routing:**
- [Graphify](https://github.com/safishamsi/graphify) integration for AST-based code understanding
- 19-language support via tree-sitter
- God node detection — identifies hub classes that many things depend on
- Leiden community detection with cohesion scoring
- Blast radius analysis — how many files are affected by a change
- Per-request workspace auto-detection from file paths

### 5. Routing Telemetry

**Data-Driven Routing Improvement:**
- SQLite-backed telemetry store records every routing decision
- Response quality scoring (0-100) with 10+ heuristic signals
- Per-provider latency tracking (P50/P95/P99)
- Routing accuracy analysis (over/under-provisioned detection)
- REST API endpoints for querying telemetry data

### 6. Production Hardening

**14 Features:**
- Circuit breakers
- Load shedding
- Graceful shutdown
- Prometheus metrics
- Health checks
- Error resilience

### 7. MCP Integration

**Model Context Protocol:**
- Automatic discovery
- JSON-RPC 2.0 client
- Dynamic tool registration
- Sandbox isolation

### 8. IDE Compatibility

**Works With:**
- Claude Code CLI (native)
- Cursor IDE (OpenAI format)
- Continue.dev (OpenAI format)
- Any OpenAI-compatible client

### 9. Streaming

**End-to-End SSE Through the Tier Router:**
- Native passthrough for Anthropic-format upstreams (Anthropic endpoints, Z.AI, Ollama v0.14+ with `LYNKR_OLLAMA_BUFFER_RESPONSES=false`) — upstream bytes piped straight through with backpressure
- OpenAI-format upstreams (openai, azure-openai, openrouter, databricks, llamacpp, lmstudio) transformed to Anthropic SSE in flight, including reassembly of split tool-call argument fragments into complete `tool_use` blocks
- `LYNKR_VISIBLE_ROUTING` badge injected into live streams as the first content block after `message_start`
- If the upstream fails before the first byte, the request falls back to the buffered path; after the first byte, errors surface as SSE error events
- Telemetry (latency, tokens, tool calls) recorded by a stream-close finalizer
- Kill switches: `LYNKR_NATIVE_PASSTHROUGH=false`, `LYNKR_STREAM_TRANSFORM=false` — only `MARKDOWN_RENDER_ANSI=true` forces buffering (ANSI rendering rewrites whole text blocks)

---

## Performance

### Benchmarks

**Request Throughput:**
- **140,000 requests/second** capacity
- **~7μs overhead** per request
- Minimal performance impact

**Latency:**
- Local providers: 100-500ms
- Cloud providers: 500ms-2s
- Caching: <1ms (cache hits)

**Memory Usage:**
- Base: ~100MB
- Per connection: ~1MB
- Caching: ~50MB

**Token Optimization:**
- Average reduction: 60-80%
- Cache hit rate: 70-90%
- Dedup effectiveness: 85%

---

## Scaling

### Horizontal Scaling

```bash
# Run multiple instances
PM2_INSTANCES=4 pm2 start lynkr

# Behind load balancer (nginx, HAProxy)
# Shared database for memories
```

### Vertical Scaling

```bash
# Increase cache size
PROMPT_CACHE_MAX_ENTRIES=256

# Increase connection pool
# (provider-specific)
```

### Database Optimization

```bash
# Enable WAL mode (better concurrency)
# Automatic vacuum
# Index optimization
```

---

## Next Steps

- **[Routing & Model Tiering](routing.md)** - Intelligent routing and scoring algorithm
- **[Memory System](memory-system.md)** - Long-term memory details
- **[Token Optimization](token-optimization.md)** - Cost reduction strategies
- **[Production Guide](production.md)** - Deploy to production
- **[Tools Guide](tools.md)** - Tool calling

---

## Getting Help

- **[GitHub Discussions](https://github.com/Fast-Editor/Lynkr/discussions)** - Ask questions
- **[GitHub Issues](https://github.com/Fast-Editor/Lynkr/issues)** - Report issues
