# Cursor IDE Integration Guide

Complete guide to using Cursor IDE with Lynkr for cost savings, provider flexibility, and local model support.

---

## Overview

Lynkr provides **full Cursor IDE support** through OpenAI-compatible API endpoints, enabling you to use Cursor with any provider (Databricks, Bedrock, OpenRouter, Ollama, etc.) while maintaining all Cursor features.

### Why Use Lynkr with Cursor?

- 💰 **60-80% cost savings** vs Cursor's default GPT-4 pricing
- 🔓 **Provider choice** - Use Claude, local models, or any supported provider
- 🏠 **Self-hosted** - Full control over your AI infrastructure
- ✅ **Full compatibility** - All Cursor features work (chat, autocomplete, @Codebase search)
- 🔒 **Privacy** - Option to run 100% locally with Ollama

---

## Quick Setup (5 Minutes)

### Step 1: Start Lynkr Server

```bash
# Navigate to Lynkr directory
cd /path/to/Lynkr

# Start with any provider (Databricks, Bedrock, OpenRouter, Ollama, etc.)
npm start

# Wait for: "Server listening at http://0.0.0.0:8081" (or your configured PORT)
```

**Note**: Lynkr runs on port **8081** by default (configured in `.env` as `PORT=8081`)

---

### Step 2: Configure Cursor

#### Detailed Configuration Steps

1. **Open Cursor Settings**
   - **Mac**: Click **Cursor** menu → **Settings** (or press `Cmd+,`)
   - **Windows/Linux**: Click **File** → **Settings** (or press `Ctrl+,`)

2. **Navigate to Models Section**
   - In the Settings sidebar, find **Features** section
   - Click on **Models**

3. **Configure OpenAI API Settings**

   Fill in these three fields:

   **API Key:**
   ```
   sk-lynkr
   ```
   *(Cursor requires a non-empty value, but Lynkr ignores it. You can use any text like "dummy" or "lynkr")*

   **Base URL:**
   ```
   http://localhost:8081/v1
   ```

   ⚠️ **Critical:**
   - Use port **8081** (or your configured PORT in .env)
   - **Must end with `/v1`**
   - Include `http://` prefix
   - ✅ Correct: `http://localhost:8081/v1`
   - ❌ Wrong: `http://localhost:8081` (missing `/v1`)
   - ❌ Wrong: `localhost:8081/v1` (missing `http://`)

   **Model:**

   Choose based on your `MODEL_PROVIDER` in `.env`:
   - **Bedrock**: `claude-3.5-sonnet` or `claude-sonnet-4.5`
   - **Databricks**: `claude-sonnet-4.5`
   - **OpenRouter**: `anthropic/claude-3.5-sonnet`
   - **Ollama**: `qwen2.5-coder:latest` (or your OLLAMA_MODEL)
   - **Azure OpenAI**: `gpt-4o` or your deployment name
   - **OpenAI**: `gpt-4o` or your model

4. **Save Settings** (auto-saves in Cursor)

#### Visual Setup Summary

```
┌─────────────────────────────────────────────────────────┐
│         Cursor Settings → Models → OpenAI API           │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  API Key:     sk-lynkr                                 │
│               (or any non-empty value)                  │
│                                                         │
│  Base URL:    http://localhost:8081/v1                │
│               ⚠️ Must include /v1                      │
│                                                         │
│  Model:       claude-3.5-sonnet                        │
│               (or your provider's model)                │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

---

### Step 3: Test the Integration

**Test 1: Basic Chat** (`Cmd+L` / `Ctrl+L`)
```
You: "Hello, can you see this?"
Expected: Response from your provider via Lynkr ✅
```

**Test 2: Inline Edits** (`Cmd+K` / `Ctrl+K`)
```
Select code → Press Cmd+K → "Add error handling"
Expected: Code modifications from your provider ✅
```

**Test 3: Verify Health**
```bash
curl http://localhost:8081/v1/health

# Expected response:
{
  "status": "ok",
  "provider": "bedrock",
  "openai_compatible": true,
  "cursor_compatible": true,
  "timestamp": "2026-01-11T12:00:00.000Z"
}
```

---

## Feature Compatibility

### What Works Without Additional Setup

| Feature | Without Embeddings | With Embeddings |
|---------|-------------------|-----------------|
| **Cmd+L chat** | ✅ Works | ✅ Works |
| **Inline autocomplete** | ✅ Works | ✅ Works |
| **Cmd+K edits** | ✅ Works | ✅ Works |
| **Manual @file references** | ✅ Works | ✅ Works |
| **Terminal commands** | ✅ Works | ✅ Works |
| **@Codebase semantic search** | ❌ Requires embeddings | ✅ Works |
| **Automatic context** | ❌ Requires embeddings | ✅ Works |
| **Find similar code** | ❌ Requires embeddings | ✅ Works |

### Important Notes

**Autocomplete Behavior:**
- Cursor's inline autocomplete uses Cursor's built-in models (fast, local)
- Autocomplete does NOT go through Lynkr
- Only these features use Lynkr:
  - ✅ Chat (`Cmd+L` / `Ctrl+L`)
  - ✅ Cmd+K inline edits
  - ✅ @Codebase search (with embeddings)
  - ❌ Autocomplete (uses Cursor's models)

---

## Enabling @Codebase Semantic Search

For Cursor's @Codebase semantic search, you need embeddings support.

### ⚡ Already Using OpenRouter?

If you configured `MODEL_PROVIDER=openrouter`, embeddings **work automatically** with the same `OPENROUTER_API_KEY` - no additional setup needed! OpenRouter handles both chat AND embeddings with one key.

### 🔧 Using a Different Provider?

If you're using Databricks, Bedrock, Ollama, or other providers for chat, add ONE of these for embeddings (ordered by privacy):

#### Option A: Ollama (100% Local - Most Private) 🔒

**Best for:** Privacy, offline work, zero cloud dependencies

```bash
# Pull embedding model
ollama pull nomic-embed-text

# Add to .env
OLLAMA_EMBEDDINGS_MODEL=nomic-embed-text
OLLAMA_EMBEDDINGS_ENDPOINT=http://localhost:11434/api/embeddings
```

**Popular models:**
- `nomic-embed-text` (768 dim, 137M params) - **Recommended**, best all-around
- `mxbai-embed-large` (1024 dim, 335M params) - Higher quality
- `all-minilm` (384 dim, 23M params) - Fastest/smallest

**Cost:** **100% FREE** 🔒
**Privacy:** All data stays on your machine

---

#### Option B: llama.cpp (100% Local - Maximum Performance) 🔒

**Best for:** Performance, GGUF models, GPU acceleration

```bash
# Download embedding model (example: nomic-embed-text GGUF)
wget https://huggingface.co/nomic-ai/nomic-embed-text-v1.5-GGUF/resolve/main/nomic-embed-text-v1.5.Q4_K_M.gguf

# Start llama-server with embedding model
./llama-server -m nomic-embed-text-v1.5.Q4_K_M.gguf --port 8080 --embedding

# Add to .env
LLAMACPP_EMBEDDINGS_ENDPOINT=http://localhost:8080/embeddings
```

**Popular models:**
- `nomic-embed-text-v1.5.Q4_K_M.gguf` - **Recommended**, 768 dim
- `all-MiniLM-L6-v2.Q4_K_M.gguf` - Smallest, fastest, 384 dim
- `bge-large-en-v1.5.Q4_K_M.gguf` - Highest quality, 1024 dim

**Cost:** **100% FREE** 🔒
**Privacy:** All data stays on your machine
**Performance:** Faster than Ollama, optimized C++

---

#### Option C: OpenRouter (Cloud - Simplest)

**Best for:** Simplicity, quality, one key for everything

```bash
# Add to .env (uses same key as chat if you're already using OpenRouter)
OPENROUTER_API_KEY=sk-or-v1-your-key
OPENROUTER_EMBEDDINGS_MODEL=openai/text-embedding-3-small
```

**Popular models:**
- `openai/text-embedding-3-small` - $0.02 per 1M tokens (80% cheaper!) **Recommended**
- `openai/text-embedding-ada-002` - $0.10 per 1M tokens (standard)
- `openai/text-embedding-3-large` - $0.13 per 1M tokens (best quality, 3072 dim)
- `voyage/voyage-code-2` - $0.12 per 1M tokens (specialized for code)

**Cost:** ~$0.01-0.10/month for typical usage
**Privacy:** Cloud-based

---

#### Option D: OpenAI (Cloud - Direct)

**Best for:** Best quality, direct OpenAI access

```bash
# Add to .env
OPENAI_API_KEY=sk-your-openai-api-key
# Optionally specify model (defaults to text-embedding-ada-002)
# OPENAI_EMBEDDINGS_MODEL=text-embedding-3-small
```

**Popular models:**
- `text-embedding-3-small` - $0.02 per 1M tokens **Recommended**
- `text-embedding-ada-002` - $0.10 per 1M tokens
- `text-embedding-3-large` - $0.13 per 1M tokens (best quality)

**Cost:** ~$0.01-0.10/month for typical usage
**Privacy:** Cloud-based

---

### Embeddings Provider Override

By default, Lynkr uses the same provider as `MODEL_PROVIDER` for embeddings. To use a different provider:

```env
# Use Databricks for chat, but Ollama for embeddings (privacy + cost savings)
MODEL_PROVIDER=databricks
DATABRICKS_API_BASE=https://your-workspace.databricks.com
DATABRICKS_API_KEY=your-key

# Override embeddings provider
EMBEDDINGS_PROVIDER=ollama
OLLAMA_EMBEDDINGS_MODEL=nomic-embed-text
```

**Recommended setups:**
- **100% Local/Private**: Ollama chat + Ollama embeddings (zero cloud dependencies)
- **Hybrid**: Databricks/Bedrock chat + Ollama embeddings (private search, cloud chat)
- **Simple Cloud**: OpenRouter chat + OpenRouter embeddings (one key for both)

**After configuration, restart Lynkr** and @Codebase will work!

---

## Available Endpoints

Lynkr implements all 4 OpenAI API endpoints for full Cursor compatibility:

### 1. POST /v1/chat/completions

Chat with streaming support
- Handles all chat/completion requests
- Converts OpenAI format ↔ Anthropic format automatically
- Full tool calling support
- Streaming responses

### 2. GET /v1/models

List available models
- Returns models based on configured provider
- Updates dynamically when you change providers

### 3. POST /v1/embeddings

Generate embeddings for @Codebase search
- Supports 4 providers: Ollama, llama.cpp, OpenRouter, OpenAI
- Automatic provider detection
- Falls back gracefully if not configured (returns 501)

### 4. GET /v1/health

Health check
- Verify Lynkr is running
- Check provider status
- Returns status, provider info, and compatibility flags

---

## Cost Comparison

**Scenario:** 100K requests/month, typical Cursor usage

| Setup | Monthly Cost | Embeddings Setup | Features | Privacy |
|-------|--------------|------------------|----------|---------|
| **Cursor native (GPT-4)** | $20-50 | Built-in | All features | Cloud |
| **Lynkr + OpenRouter** | $5-10 | ⚡ **Same key for both** | All features, simplest setup | Cloud |
| **Lynkr + Databricks** | $15-30 | +Ollama/OpenRouter | All features | Cloud chat, local/cloud search |
| **Lynkr + Ollama + Ollama embeddings** | **100% FREE** 🔒 | Ollama (local) | All features, 100% local | 100% Local |
| **Lynkr + Ollama + llama.cpp embeddings** | **100% FREE** 🔒 | llama.cpp (local) | All features, 100% local | 100% Local |
| **Lynkr + Ollama + OpenRouter embeddings** | $0.01-0.10 | OpenRouter (cloud) | All features, hybrid | Local chat, cloud search |
| **Lynkr + Ollama (no embeddings)** | **FREE** | None | Chat/Cmd+K only, no @Codebase | 100% Local |

---

## Provider Recommendations

### Best for Privacy (100% Local) 🔒

**Ollama + Ollama embeddings**
- **Cost:** 100% FREE
- **Privacy:** All data stays on your machine
- **Features:** Full @Codebase support with local embeddings
- **Perfect for:** Sensitive codebases, offline work, privacy requirements

```env
MODEL_PROVIDER=ollama
OLLAMA_MODEL=llama3.1:8b
OLLAMA_EMBEDDINGS_MODEL=nomic-embed-text
```

---

### Best for Simplicity (Recommended for Most Users)

**OpenRouter**
- **Cost:** $5-10/month
- **Setup:** ONE key for chat + embeddings, no extra setup
- **Features:** 100+ models, automatic fallbacks
- **Perfect for:** Easy setup, flexibility, cost optimization

```env
MODEL_PROVIDER=openrouter
OPENROUTER_API_KEY=sk-or-v1-your-key
OPENROUTER_MODEL=anthropic/claude-3.5-sonnet
# Embeddings work automatically with same key!
```

---

### Best for Enterprise

**Databricks or Azure Anthropic**
- **Cost:** $15-30/month (enterprise pricing)
- **Features:** Claude Sonnet 4.5, enterprise SLA
- **Perfect for:** Production use, enterprise compliance

```env
MODEL_PROVIDER=databricks
DATABRICKS_API_BASE=https://your-workspace.databricks.com
DATABRICKS_API_KEY=your-key
# Add Ollama embeddings for privacy
OLLAMA_EMBEDDINGS_MODEL=nomic-embed-text
```

---

### Best for AWS Ecosystem

**AWS Bedrock**
- **Cost:** $10-20/month (100+ models)
- **Features:** Claude + DeepSeek + Qwen + Nova + Titan + Llama
- **Perfect for:** AWS integration, multi-model flexibility

```env
MODEL_PROVIDER=bedrock
AWS_BEDROCK_API_KEY=your-bearer-token
AWS_BEDROCK_REGION=us-east-1
AWS_BEDROCK_MODEL_ID=anthropic.claude-3-5-sonnet-20241022-v2:0
```

---

### Best for Speed

**Ollama or llama.cpp**
- **Latency:** 100-500ms (local inference)
- **Cost:** 100% FREE
- **Perfect for:** Fast iteration, local development

---

## Troubleshooting

### Connection Refused or Network Error

**Symptoms:** Cursor shows connection errors, can't reach Lynkr

**Solutions:**

1. **Verify Lynkr is running:**
   ```bash
   # Check if Lynkr process is running on port 8081
   lsof -i :8081
   # Should show node process
   ```

2. **Test health endpoint:**
   ```bash
   curl http://localhost:8081/v1/health
   # Should return: {"status":"ok"}
   ```

3. **Check port number:**
   - Verify Cursor Base URL uses correct port: `http://localhost:8081/v1`
   - Check `.env` file: `PORT=8081`
   - If you changed PORT, update Cursor settings to match

4. **Verify URL format:**
   - ✅ Correct: `http://localhost:8081/v1`
   - ❌ Wrong: `http://localhost:8081` (missing `/v1`)
   - ❌ Wrong: `localhost:8081/v1` (missing `http://`)

---

### Invalid API Key or Unauthorized

**Symptoms:** Cursor says API key is invalid

**Solutions:**
- Lynkr doesn't validate API keys from Cursor
- This error means Cursor isn't reaching Lynkr at all
- Double-check Base URL in Cursor: `http://localhost:8081/v1`
- Make sure you included `/v1` at the end
- Try clearing and re-entering the Base URL

---

### Model Not Found or Invalid Model

**Symptoms:** Cursor can't find the model you specified

**Solutions:**

1. **Match model name to your provider:**
   - **Bedrock**: Use `claude-3.5-sonnet` or `claude-sonnet-4.5`
   - **Databricks**: Use `claude-sonnet-4.5`
   - **OpenRouter**: Use `anthropic/claude-3.5-sonnet`
   - **Ollama**: Use your actual model name like `qwen2.5-coder:latest`

2. **Try generic names:**
   - Lynkr translates generic names, so try:
   - `claude-3.5-sonnet`
   - `gpt-4o`
   - These work across most providers

3. **Check provider logs:**
   ```bash
   # In Lynkr terminal
   # Look for "Unknown model" errors
   ```

---

### @Codebase Doesn't Work

**Symptoms:** @Codebase doesn't return results or shows error

**Solutions:**

1. **Verify embeddings are configured:**
   ```bash
   curl http://localhost:8081/v1/embeddings \
     -H "Content-Type: application/json" \
     -d '{"input":"test","model":"text-embedding-ada-002"}'

   # Should return embeddings, not 501 error
   ```

2. **Check embeddings provider:**
   ```bash
   # In .env, verify one of these is set:
   OLLAMA_EMBEDDINGS_MODEL=nomic-embed-text
   # OR
   LLAMACPP_EMBEDDINGS_ENDPOINT=http://localhost:8080/embeddings
   # OR
   OPENROUTER_API_KEY=sk-or-v1-your-key
   # OR
   OPENAI_API_KEY=sk-your-key
   ```

3. **Restart Lynkr** after adding embeddings config

4. **This is a Cursor indexing issue, not Lynkr:**
   - Cursor needs to re-index your codebase
   - Try closing and reopening the workspace

---

### Slow Responses

**Symptoms:** Responses take 5+ seconds

**Solutions:**

1. **Check provider latency:**
   - **Local** (Ollama/llama.cpp): Should be 100-500ms
   - **Cloud** (OpenRouter/Databricks): Should be 500ms-2s
   - **Distant regions**: Can be 2-5s

2. **Enable tier-based routing** for speed:
   ```env
   # Use Ollama for simple requests (fast), cloud for complex requests
   # Set all 4 TIER_* env vars to enable tier-based routing
   TIER_SIMPLE=ollama:llama3.2
   TIER_MEDIUM=openrouter:openai/gpt-4o-mini
   TIER_COMPLEX=azure-openai:gpt-4o
   TIER_REASONING=azure-openai:gpt-4o
   FALLBACK_ENABLED=true
   ```

3. **Check Lynkr logs:**
   - Look for actual response times
   - Example: `Response time: 2500ms`

---

### Embeddings Work But Search Results Are Poor

**Symptoms:** @Codebase returns irrelevant files

**Solutions:**

1. **Try better embedding models:**
   ```bash
   # For Ollama - upgrade to larger model
   ollama pull mxbai-embed-large  # Better quality than nomic-embed-text
   OLLAMA_EMBEDDINGS_MODEL=mxbai-embed-large
   ```

2. **Use cloud embeddings for better quality:**
   ```bash
   # OpenRouter has excellent embeddings
   OPENROUTER_API_KEY=sk-or-v1-your-key
   OPENROUTER_EMBEDDINGS_MODEL=voyage/voyage-code-2
   ```

3. **This is a Cursor indexing issue, not Lynkr:**
   - Cursor needs to re-index your codebase
   - Try closing and reopening the workspace

---

### Too Many Requests or Rate Limiting

**Symptoms:** Provider returns 429 errors

**Solutions:**

1. **Enable fallback provider:**
   ```env
   FALLBACK_ENABLED=true
   FALLBACK_PROVIDER=databricks
   ```

2. **Switch to Ollama** (no rate limits):
   ```env
   MODEL_PROVIDER=ollama
   OLLAMA_MODEL=llama3.1:8b
   ```

3. **Use OpenRouter** (pooled rate limits across providers):
   ```env
   MODEL_PROVIDER=openrouter
   ```

---

### Enable Debug Logging

For detailed troubleshooting:

```bash
# In .env
LOG_LEVEL=debug

# Restart Lynkr
npm start

# Check logs for detailed request/response info
```

---

## Architecture

```
Cursor IDE
    ↓ OpenAI API format
Lynkr Proxy
    ↓ Converts to Anthropic format
Your Provider (Databricks/Bedrock/OpenRouter/Ollama/etc.)
    ↓ Returns response
Lynkr Proxy
    ↓ Converts back to OpenAI format
Cursor IDE (displays result)
```

---

## Advanced Configuration Examples

### Setup 1: Simplest (One Key for Everything - OpenRouter)

```bash
# Chat + Embeddings: OpenRouter handles both with ONE key
MODEL_PROVIDER=openrouter
OPENROUTER_API_KEY=sk-or-v1-your-key-here

# Done! Everything works with one key
```

**Benefits:**
- ✅ ONE key for chat + embeddings
- ✅ 100+ models available
- ✅ Automatic fallbacks
- ✅ Competitive pricing

---

### Setup 2: Privacy-First (100% Local)

```bash
# Chat: Ollama (local)
MODEL_PROVIDER=ollama
OLLAMA_MODEL=llama3.1:8b

# Embeddings: Ollama (local)
OLLAMA_EMBEDDINGS_MODEL=nomic-embed-text

# Everything runs on your machine, zero cloud dependencies
```

**Benefits:**
- ✅ 100% FREE
- ✅ 100% private (all data stays local)
- ✅ Works offline
- ✅ Full @Codebase support

---

### Setup 3: Hybrid (Best of Both Worlds)

```bash
# Chat: Tier-based routing (set all 4 to enable)
TIER_SIMPLE=ollama:llama3.2
TIER_MEDIUM=openrouter:openai/gpt-4o-mini
TIER_COMPLEX=databricks:databricks-claude-sonnet-4-5
TIER_REASONING=databricks:databricks-claude-sonnet-4-5
FALLBACK_ENABLED=true
FALLBACK_PROVIDER=databricks
DATABRICKS_API_BASE=https://your-workspace.databricks.com
DATABRICKS_API_KEY=your-key

# Embeddings: Ollama (local, private)
OLLAMA_EMBEDDINGS_MODEL=nomic-embed-text

# Cost: Mostly FREE (Ollama handles 70-80% of simple requests)
#       Only complex/reasoning requests go to Databricks
```

**Benefits:**
- ✅ Mostly FREE (70-80% of requests on Ollama via TIER_SIMPLE)
- ✅ Private embeddings (local search)
- ✅ Cloud quality for complex tasks
- ✅ Automatic intelligent tier-based routing

---

## Cursor vs Native Comparison

| Aspect | Cursor Native | Lynkr + Cursor |
|--------|---------------|----------------|
| **Providers** | OpenAI only | 12+ providers (Bedrock, Databricks, OpenRouter, Ollama, llama.cpp, Moonshot, etc.) |
| **Costs** | OpenAI pricing | 60-80% cheaper (or 100% FREE with Ollama) |
| **Privacy** | Cloud-only | Can run 100% locally (Ollama + local embeddings) |
| **Embeddings** | Built-in (cloud) | 4 options: Ollama (local), llama.cpp (local), OpenRouter (cloud), OpenAI (cloud) |
| **Control** | Black box | Full observability, logs, metrics |
| **Features** | All Cursor features | All Cursor features (chat, Cmd+K, @Codebase) |
| **Flexibility** | Fixed setup | Mix providers (e.g., Bedrock chat + Ollama embeddings) |

---

## Next Steps

- **[Embeddings Configuration](embeddings.md)** - Detailed embeddings setup guide
- **[Provider Configuration](providers.md)** - Configure all providers
- **[Installation Guide](installation.md)** - Install Lynkr
- **[Troubleshooting](troubleshooting.md)** - More troubleshooting tips
- **[FAQ](faq.md)** - Frequently asked questions

---

## Getting Help

- **[GitHub Discussions](https://github.com/vishalveerareddy123/Lynkr/discussions)** - Community Q&A
- **[GitHub Issues](https://github.com/vishalveerareddy123/Lynkr/issues)** - Report bugs
- **[Troubleshooting Guide](troubleshooting.md)** - Common issues and solutions
