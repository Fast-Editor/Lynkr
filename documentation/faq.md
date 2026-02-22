# Frequently Asked Questions (FAQ)

Common questions about Lynkr, installation, configuration, and usage.

---

## General Questions

### What is Lynkr?

Lynkr is a self-hosted proxy server that enables Claude Code CLI and Cursor IDE to work with multiple LLM providers (Databricks, AWS Bedrock, OpenRouter, Ollama, Moonshot AI, etc.) instead of being locked to Anthropic's API.

**Key benefits:**
- 💰 **60-80% cost savings** through token optimization
- 🔓 **Provider flexibility** - Choose from 12+ providers
- 🔒 **Privacy** - Run 100% locally with Ollama or llama.cpp
- ✅ **Zero code changes** - Drop-in replacement for Anthropic backend

---

### Can I use Lynkr with the official Claude Code CLI?

**Yes!** Lynkr is designed as a drop-in replacement for Anthropic's backend. Simply set `ANTHROPIC_BASE_URL` to point to your Lynkr server:

```bash
export ANTHROPIC_BASE_URL=http://localhost:8081
export ANTHROPIC_API_KEY=dummy  # Required by CLI, but ignored by Lynkr
claude "Your prompt here"
```

All Claude Code CLI features work through Lynkr.

---

### Does Lynkr work with Cursor IDE?

**Yes!** Lynkr provides OpenAI-compatible endpoints that work with Cursor:

1. Start Lynkr: `lynkr start`
2. Configure Cursor Settings → Models:
   - **API Key:** `sk-lynkr` (any non-empty value)
   - **Base URL:** `http://localhost:8081/v1`
   - **Model:** Your provider's model (e.g., `claude-3.5-sonnet`)

All Cursor features work: chat (`Cmd+L`), inline edits (`Cmd+K`), and @Codebase search (with embeddings).

See [Cursor Integration Guide](cursor-integration.md) for details.

---

### How much does Lynkr cost?

Lynkr itself is **100% FREE** and open source (Apache 2.0 license).

**Costs depend on your provider:**
- **Ollama/llama.cpp**: 100% FREE (runs on your hardware)
- **OpenRouter**: ~$5-10/month (100+ models)
- **AWS Bedrock**: ~$10-20/month (100+ models)
- **Databricks**: Enterprise pricing (contact Databricks)
- **Azure/OpenAI**: Standard provider pricing

**With token optimization**, Lynkr reduces provider costs by **60-80%** through smart tool selection, prompt caching, and memory deduplication.

---

### What's the difference between Lynkr and native Claude Code?

| Feature | Native Claude Code | Lynkr |
|---------|-------------------|-------|
| **Providers** | Anthropic only | 12+ providers |
| **Cost** | Full Anthropic pricing | 60-80% cheaper |
| **Local models** | ❌ Cloud-only | ✅ Ollama, llama.cpp |
| **Privacy** | ☁️ Cloud | 🔒 Can run 100% locally |
| **Token optimization** | ❌ None | ✅ 6 optimization phases |
| **MCP support** | Limited | ✅ Full orchestration |
| **Enterprise features** | Limited | ✅ Circuit breakers, metrics, K8s-ready |
| **Cost transparency** | Hidden | ✅ Full tracking |
| **License** | Proprietary | ✅ Apache 2.0 (open source) |

---

## Installation & Setup

### How do I install Lynkr?

**Option 1: NPM (Recommended)**
```bash
npm install -g lynkr
lynkr start
```

**Option 2: Homebrew (macOS)**
```bash
brew tap vishalveerareddy123/lynkr
brew install lynkr
lynkr start
```

**Option 3: Git Clone**
```bash
git clone https://github.com/vishalveerareddy123/Lynkr.git
cd Lynkr && npm install && npm start
```

See [Installation Guide](installation.md) for all methods.

---

### Which provider should I use?

**Depends on your priorities:**

**For Privacy (100% Local, FREE):**
- ✅ **Ollama** - Easy setup, 100% private
- ✅ **llama.cpp** - Maximum performance, GGUF models
- **Setup:** 5-15 minutes
- **Cost:** $0 (runs on your hardware)

**For Simplicity (Easiest Cloud):**
- ✅ **OpenRouter** - One key for 100+ models
- **Setup:** 2 minutes
- **Cost:** ~$5-10/month

**For AWS Ecosystem:**
- ✅ **AWS Bedrock** - 100+ models, Claude + alternatives
- **Setup:** 5 minutes
- **Cost:** ~$10-20/month

**For Affordable Cloud + Reasoning:**
- ✅ **Moonshot AI** - Kimi K2, thinking models
- **Setup:** 2 minutes
- **Cost:** ~$5-10/month

**For Enterprise:**
- ✅ **Databricks** - Claude 4.5, enterprise SLA
- **Setup:** 10 minutes
- **Cost:** Enterprise pricing

See [Provider Configuration Guide](providers.md) for detailed comparison.

---

### Can I use multiple providers?

**Yes!** Lynkr supports tier-based routing:

```bash
# Set all 4 TIER_* env vars to enable tier-based routing
export TIER_SIMPLE=ollama:llama3.2
export TIER_MEDIUM=openrouter:openai/gpt-4o-mini
export TIER_COMPLEX=azure-openai:gpt-4o
export TIER_REASONING=azure-openai:gpt-4o
export FALLBACK_ENABLED=true
export FALLBACK_PROVIDER=databricks
```

**How it works:**
- Each request is scored for complexity (0-100) and mapped to a tier
- **SIMPLE (0-25)**: Ollama (free, local, fast) or Moonshot (affordable cloud)
- **MEDIUM (26-50)**: OpenRouter or mid-range cloud model
- **COMPLEX (51-75)**: Capable cloud models
- **REASONING (76-100)**: Best available models
- **Provider failures**: Automatic transparent fallback

**Cost savings:** 65-100% for requests routed to local/cheap models.

---

### What is MODEL_PROVIDER and do I still need it?

`MODEL_PROVIDER` sets a single static provider for all requests. When you set `MODEL_PROVIDER=ollama`, every request goes to Ollama regardless of complexity.

**With TIER_\* vars configured:** `MODEL_PROVIDER` is not used for routing — the tier system picks the provider per-request. However, `MODEL_PROVIDER` is still read for startup checks (e.g. waiting for Ollama) and as a fallback default in edge cases. Keep it set to your most-used provider.

**Without TIER_\* vars:** `MODEL_PROVIDER` is the only thing that controls where requests go.

---

### How do MODEL_PROVIDER and TIER_\* work together?

They are two separate routing modes:

| Scenario | What happens |
|----------|-------------|
| `MODEL_PROVIDER` only | Static routing — all requests go to that provider |
| All 4 `TIER_*` set | Tier routing — TIER_\* **overrides** MODEL_PROVIDER for routing |
| Only 1-3 `TIER_*` set | Tier routing disabled — falls back to `MODEL_PROVIDER` |
| Both set | TIER_\* takes priority for routing; MODEL_PROVIDER is kept as a config default |

**Example:** If you have `MODEL_PROVIDER=ollama` and `TIER_COMPLEX=databricks:claude-sonnet`, complex requests go to Databricks even though MODEL_PROVIDER says ollama.

---

### What happens if I only set some TIER_\* vars?

All 4 must be set (`TIER_SIMPLE`, `TIER_MEDIUM`, `TIER_COMPLEX`, `TIER_REASONING`) for tier routing to activate. If any are missing, tier routing is disabled entirely and `MODEL_PROVIDER` is used for all requests.

This is intentional — partial tier config could lead to unexpected gaps where some complexity levels have no provider assigned.

---

### What is FALLBACK_PROVIDER?

The fallback provider is a safety net for when the tier-selected provider fails (timeout, connection refused, rate limit). If `FALLBACK_ENABLED=true` and the primary provider for a request fails, Lynkr retries the request against `FALLBACK_PROVIDER` transparently.

- Only triggers when tier routing is active
- Cannot be a local provider (ollama, llamacpp, lmstudio) — use cloud providers
- Defaults to `databricks`
- If you don't have cloud credentials, set `FALLBACK_ENABLED=false`

---

## Provider-Specific Questions

### Can I use Ollama models with Lynkr and Cursor?

**Yes!** Ollama works for both chat AND embeddings (100% local, FREE):

**Chat setup:**
```bash
export MODEL_PROVIDER=ollama
export OLLAMA_MODEL=llama3.1:8b  # or qwen2.5-coder, mistral, etc.
lynkr start
```

**Embeddings setup (for @Codebase):**
```bash
ollama pull nomic-embed-text
export OLLAMA_EMBEDDINGS_MODEL=nomic-embed-text
```

**Recommended models:**
- **Chat**: `llama3.1:8b` - Good balance, tool calling supported
- **Chat**: `qwen2.5:14b` - Better reasoning (7b struggles with tools)
- **Embeddings**: `nomic-embed-text` (137M) - Best all-around

**100% local, 100% private, 100% FREE!** 🔒

---

### How do I enable @Codebase search in Cursor with Lynkr?

@Codebase semantic search requires embeddings. Choose ONE option:

**Option 1: Ollama (100% Local, FREE)** 🔒
```bash
ollama pull nomic-embed-text
export OLLAMA_EMBEDDINGS_MODEL=nomic-embed-text
```

**Option 2: llama.cpp (100% Local, FREE)** 🔒
```bash
./llama-server -m nomic-embed-text.gguf --port 8080 --embedding
export LLAMACPP_EMBEDDINGS_ENDPOINT=http://localhost:8080/embeddings
```

**Option 3: OpenRouter (Cloud, ~$0.01-0.10/month)**
```bash
export OPENROUTER_API_KEY=sk-or-v1-your-key
# Works automatically if you're already using OpenRouter for chat!
```

**Option 4: OpenAI (Cloud, ~$0.01-0.10/month)**
```bash
export OPENAI_API_KEY=sk-your-key
```

**After configuring, restart Lynkr.** @Codebase will then work in Cursor!

See [Embeddings Guide](embeddings.md) for details.

---

### What are the performance differences between providers?

| Provider | Latency | Cost | Tool Support | Best For |
|----------|---------|------|--------------|----------|
| **Ollama** | 100-500ms | **FREE** | Good | Local, privacy, offline |
| **llama.cpp** | 50-300ms | **FREE** | Good | Performance, GPU |
| **OpenRouter** | 500ms-2s | $-$$ | Excellent | Flexibility, 100+ models |
| **Databricks/Azure** | 500ms-2s | $$$ | Excellent | Enterprise, Claude 4.5 |
| **AWS Bedrock** | 500ms-2s | $-$$$ | Excellent* | AWS, 100+ models |
| **Moonshot AI** | 500ms-2s | $ | Good | Affordable, thinking models |
| **OpenAI** | 500ms-2s | $$ | Excellent | GPT-4o, o1, o3 |

_* Tool calling only supported by Claude models on Bedrock_

---

### Does AWS Bedrock support tool calling?

**Only Claude models support tool calling on Bedrock.**

✅ **Supported (with tools):**
- `anthropic.claude-3-5-sonnet-20241022-v2:0`
- `anthropic.claude-3-opus-20240229-v1:0`
- `us.anthropic.claude-sonnet-4-5-20250929-v1:0`

❌ **Not supported (no tools):**
- Amazon Titan models
- Meta Llama models
- Mistral models
- Cohere models
- AI21 models

Other models work via Converse API but won't use Read/Write/Bash tools.

See [BEDROCK_MODELS.md](../BEDROCK_MODELS.md) for complete model catalog.

---

## Features & Capabilities

### What is token optimization and how does it save costs?

Lynkr includes **6 token optimization phases** that reduce costs by **60-80%**:

1. **Smart Tool Selection** (50-70% reduction)
   - Filters tools based on request type
   - Only sends relevant tools to model
   - Example: Chat query doesn't need git tools

2. **Prompt Caching** (30-45% reduction)
   - Caches repeated prompts
   - Reuses system prompts
   - Reduces redundant token usage

3. **Memory Deduplication** (20-30% reduction)
   - Removes duplicate memories
   - Compresses conversation history
   - Eliminates redundant context

4. **Tool Response Truncation** (15-25% reduction)
   - Truncates long tool outputs
   - Keeps only relevant portions
   - Reduces tool result tokens

5. **Dynamic System Prompts** (10-20% reduction)
   - Adapts prompts to request type
   - Shorter prompts for simple queries
   - Longer prompts only when needed

6. **Conversation Compression** (15-25% reduction)
   - Summarizes old messages
   - Keeps recent context full
   - Compresses historical turns

**At 100k requests/month, this translates to $6,400-9,600/month savings ($77k-115k/year).**

See [Token Optimization Guide](token-optimization.md) for details.

---

### What is the memory system?

Lynkr includes a **Titans-inspired long-term memory system** that remembers important context across conversations:

**Key features:**
- 🧠 **Surprise-Based Updates** - Only stores novel, important information
- 🔍 **Semantic Search** - Full-text search with Porter stemmer
- 📊 **Multi-Signal Retrieval** - Ranks by recency, importance, relevance
- ⚡ **Automatic Integration** - Zero latency overhead (<50ms retrieval)
- 🛠️ **Management Tools** - `memory_search`, `memory_add`, `memory_forget`

**What gets remembered:**
- ✅ User preferences ("I prefer Python")
- ✅ Important decisions ("Decided to use React")
- ✅ Project facts ("This app uses PostgreSQL")
- ✅ New entities (first mention of files, functions)
- ❌ Greetings, confirmations, repeated info

**Configuration:**
```bash
export MEMORY_ENABLED=true                  # Enable/disable
export MEMORY_RETRIEVAL_LIMIT=5             # Memories per request
export MEMORY_SURPRISE_THRESHOLD=0.3        # Min score to store
```

See [Memory System Guide](memory-system.md) for details.

---

### What are tool execution modes?

Lynkr supports two tool execution modes:

**Server Mode (Default)**
```bash
export TOOL_EXECUTION_MODE=server
```
- Tools run on the machine running Lynkr
- Good for: Standalone proxy, shared team server
- File operations access server filesystem

**Client Mode (Passthrough)**
```bash
export TOOL_EXECUTION_MODE=client
```
- Tools run on Claude Code CLI side (your local machine)
- Good for: Local development, accessing local files
- Full integration with local environment

---

### Does Lynkr support MCP (Model Context Protocol)?

**Yes!** Lynkr includes full MCP orchestration:

- 🔍 **Automatic Discovery** - Scans `~/.claude/mcp` for manifests
- 🚀 **JSON-RPC 2.0 Client** - Communicates with MCP servers
- 🛠️ **Dynamic Tool Registration** - Exposes MCP tools in proxy
- 🔒 **Docker Sandbox** - Optional container isolation

**Configuration:**
```bash
export MCP_MANIFEST_DIRS=~/.claude/mcp
export MCP_SANDBOX_ENABLED=true
```

MCP tools integrate seamlessly with Claude Code CLI and Cursor.

---

## Deployment & Production

### Can I deploy Lynkr to production?

**Yes!** Lynkr includes 14 production-hardening features:

- **Reliability:** Circuit breakers, exponential backoff, load shedding
- **Observability:** Prometheus metrics, structured logging, health checks
- **Security:** Input validation, policy enforcement, sandboxing
- **Performance:** Prompt caching, token optimization, connection pooling
- **Deployment:** Kubernetes-ready health checks, graceful shutdown, Docker support

See [Production Hardening Guide](production.md) for details.

---

### How do I deploy with Docker?

**docker-compose (Recommended):**
```bash
git clone https://github.com/vishalveerareddy123/Lynkr.git
cd Lynkr
cp .env.example .env
# Edit .env with your credentials
docker-compose up -d
```

**Standalone Docker:**
```bash
docker build -t lynkr .
docker run -d -p 8081:8081 -e MODEL_PROVIDER=databricks -e DATABRICKS_API_KEY=your-key lynkr
```

See [Docker Deployment Guide](docker.md) for advanced options (GPU, K8s, volumes).

---

### What metrics does Lynkr collect?

Lynkr collects comprehensive metrics in Prometheus format:

**Request Metrics:**
- Request rate (requests/sec)
- Latency percentiles (p50, p95, p99)
- Error rate and types
- Status code distribution

**Token Metrics:**
- Token usage per request
- Token cost per request
- Cumulative token usage
- Cache hit rate

**System Metrics:**
- Memory usage
- CPU usage
- Active connections
- Circuit breaker state

**Access metrics:**
```bash
curl http://localhost:8081/metrics
# Returns Prometheus-format metrics
```

See [Production Guide](production.md) for metrics configuration.

---

## Troubleshooting

### Lynkr won't start - what should I check?

1. **Missing credentials:**
   ```bash
   echo $MODEL_PROVIDER
   echo $DATABRICKS_API_KEY  # or other provider key
   ```

2. **Port already in use:**
   ```bash
   lsof -i :8081
   kill -9 <PID>
   # Or use different port: export PORT=8082
   ```

3. **Missing dependencies:**
   ```bash
   npm install
   # Or: npm install -g lynkr --force
   ```

See [Troubleshooting Guide](troubleshooting.md) for more issues.

---

### Why is my first request slow?

**This is normal:**
- **Ollama/llama.cpp:** Model loading (1-5 seconds)
- **Cloud providers:** Cold start (2-5 seconds)
- **Subsequent requests are fast**

**Solutions:**

1. **Keep Ollama running:**
   ```bash
   ollama serve  # Keep running in background
   ```

2. **Warm up after startup:**
   ```bash
   curl http://localhost:8081/health/ready?deep=true
   ```

---

### How do I enable debug logging?

```bash
export LOG_LEVEL=debug
lynkr start

# Check logs for detailed request/response info
```

---

## Cost & Pricing

### How much can I save with Lynkr?

**Scenario:** 100,000 requests/month, average 50k input tokens, 2k output tokens

| Provider | Without Lynkr | With Lynkr (60% savings) | Monthly Savings |
|----------|---------------|-------------------------|-----------------|
| **Claude Sonnet 4.5** | $16,000 | $6,400 | **$9,600** |
| **GPT-4o** | $12,000 | $4,800 | **$7,200** |
| **Ollama (Local)** | API costs | $0 | **$12,000+** |

**ROI:** $77k-115k/year in savings.

**Token optimization breakdown:**
- Smart tool selection: 50-70% reduction
- Prompt caching: 30-45% reduction
- Memory deduplication: 20-30% reduction
- Tool truncation: 15-25% reduction

---

### What's the cheapest setup?

**100% FREE Setup:**
```bash
# Chat: Ollama (local, free)
export MODEL_PROVIDER=ollama
export OLLAMA_MODEL=llama3.1:8b

# Embeddings: Ollama (local, free)
export OLLAMA_EMBEDDINGS_MODEL=nomic-embed-text
```

**Total cost: $0/month** 🔒
- 100% private (all data stays on your machine)
- Works offline
- Full Claude Code CLI + Cursor support

**Hardware requirements:**
- 8GB+ RAM for 7-8B models
- 16GB+ RAM for 14B models
- Optional: GPU for faster inference

---

## Security & Privacy

### Is Lynkr secure for production use?

**Yes!** Lynkr includes multiple security features:

- **Input Validation:** Zero-dependency schema validation
- **Policy Enforcement:** Git, test, web fetch policies
- **Sandboxing:** Optional Docker isolation for MCP tools
- **Authentication:** API key support (provider-level)
- **Rate Limiting:** Load shedding during overload
- **Logging:** Structured logs with request ID correlation

**Best practices:**
- Run behind reverse proxy (nginx, Caddy)
- Use HTTPS for external access
- Rotate API keys regularly
- Enable policy restrictions
- Monitor metrics and logs

---

### Can I run Lynkr completely offline?

**Yes!** Use local providers:

**Option 1: Ollama**
```bash
export MODEL_PROVIDER=ollama
export OLLAMA_MODEL=llama3.1:8b
export OLLAMA_EMBEDDINGS_MODEL=nomic-embed-text
```

**Option 2: llama.cpp**
```bash
export MODEL_PROVIDER=llamacpp
export LLAMACPP_ENDPOINT=http://localhost:8080
export LLAMACPP_EMBEDDINGS_ENDPOINT=http://localhost:8080/embeddings
```

**Result:**
- ✅ Zero internet required
- ✅ 100% private (all data stays local)
- ✅ Works in air-gapped environments
- ✅ Full Claude Code CLI + Cursor support

---

### Where is my data stored?

**Local data (on machine running Lynkr):**
- **SQLite databases:** `data/` directory
  - `memories.db` - Long-term memories
  - `sessions.db` - Conversation history
  - `workspace-index.db` - Workspace metadata
- **Configuration:** `.env` file
- **Logs:** stdout (or log file if configured)

**Provider data:**
- **Cloud providers:** Sent to provider (Databricks, Bedrock, OpenRouter, etc.)
- **Local providers:** Stays on your machine (Ollama, llama.cpp)

**Privacy recommendation:**
Use Ollama or llama.cpp for 100% local, private operation.

---

## Getting Help

### Where can I get help?

- **[Troubleshooting Guide](troubleshooting.md)** - Common issues and solutions
- **[GitHub Discussions](https://github.com/vishalveerareddy123/Lynkr/discussions)** - Community Q&A
- **[GitHub Issues](https://github.com/vishalveerareddy123/Lynkr/issues)** - Report bugs
- **[Documentation](README.md)** - Complete guides

### How do I report a bug?

1. Check [GitHub Issues](https://github.com/vishalveerareddy123/Lynkr/issues) for existing reports
2. If new, create an issue with:
   - Lynkr version
   - Provider being used
   - Full error message
   - Steps to reproduce
   - Debug logs (with `LOG_LEVEL=debug`)

### How can I contribute?

See [Contributing Guide](contributing.md) for:
- Code contributions
- Documentation improvements
- Bug reports
- Feature requests

---

## License

### What license is Lynkr under?

**Apache 2.0** - Free and open source.

You can:
- ✅ Use commercially
- ✅ Modify the code
- ✅ Distribute
- ✅ Sublicense
- ✅ Use privately

**No restrictions for:**
- Personal use
- Commercial use
- Internal company use
- Redistribution

See [LICENSE](../LICENSE) file for details.
