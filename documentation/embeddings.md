# Embeddings Configuration Guide

Complete guide to configuring embeddings for Cursor @Codebase semantic search and code understanding.

---

## Overview

**Embeddings** enable semantic code search in Cursor IDE's @Codebase feature. Instead of keyword matching, embeddings understand the *meaning* of your code, allowing you to search for functionality, concepts, or patterns.

### What Are Embeddings?

Embeddings convert text (code, comments, documentation) into high-dimensional vectors that capture semantic meaning. Similar code gets similar vectors, enabling:

- **@Codebase Search** - Find relevant code by describing what you need
- **Automatic Context** - Cursor automatically includes relevant files in conversations
- **Find Similar Code** - Discover code patterns and examples in your codebase

### Why Use Embeddings?

**Without embeddings:**
- ❌ Keyword-only search (`grep`, exact string matching)
- ❌ No semantic understanding
- ❌ Can't find code by describing its purpose

**With embeddings:**
- ✅ Semantic search ("find authentication logic")
- ✅ Concept-based discovery ("show me error handling patterns")
- ✅ Similar code detection ("code like this function")

---

## Supported Embedding Providers

Lynkr supports 4 embedding providers with different tradeoffs:

| Provider | Cost | Privacy | Setup | Quality | Best For |
|----------|------|---------|-------|---------|----------|
| **Ollama** | **FREE** | 🔒 100% Local | Easy | Good | Privacy, offline, no costs |
| **llama.cpp** | **FREE** | 🔒 100% Local | Medium | Good | Performance, GPU, GGUF models |
| **OpenRouter** | $0.01-0.10/mo | ☁️ Cloud | Easy | Excellent | Simplicity, quality, one key |
| **OpenAI** | $0.01-0.10/mo | ☁️ Cloud | Easy | Excellent | Best quality, direct access |

---

## Option 1: Ollama (Recommended for Privacy)

### Overview

- **Cost:** 100% FREE 🔒
- **Privacy:** All data stays on your machine
- **Setup:** Easy (5 minutes)
- **Quality:** Good (768-1024 dimensions)
- **Best for:** Privacy-focused teams, offline work, zero cloud dependencies

### Installation & Setup

```bash
# 1. Install Ollama (if not already installed)
brew install ollama  # macOS
# Or download from: https://ollama.ai/download

# 2. Start Ollama service
ollama serve

# 3. Pull embedding model (in separate terminal)
ollama pull nomic-embed-text

# 4. Verify model is available
ollama list
# Should show: nomic-embed-text  ...
```

### Configuration

Add to `.env`:

```env
# Ollama embeddings configuration
OLLAMA_EMBEDDINGS_MODEL=nomic-embed-text
OLLAMA_EMBEDDINGS_ENDPOINT=http://localhost:11434/api/embeddings
```

### Available Models

**nomic-embed-text** (Recommended) ⭐
```bash
ollama pull nomic-embed-text
```
- **Dimensions:** 768
- **Parameters:** 137M
- **Quality:** Excellent for code search
- **Speed:** Fast (~50ms per query)
- **Best for:** General purpose, best all-around choice

**mxbai-embed-large** (Higher Quality)
```bash
ollama pull mxbai-embed-large
```
- **Dimensions:** 1024
- **Parameters:** 335M
- **Quality:** Higher quality than nomic-embed-text
- **Speed:** Slower (~100ms per query)
- **Best for:** Large codebases where quality matters most

**all-minilm** (Fastest)
```bash
ollama pull all-minilm
```
- **Dimensions:** 384
- **Parameters:** 23M
- **Quality:** Good for simple searches
- **Speed:** Very fast (~20ms per query)
- **Best for:** Small codebases, speed-critical applications

### Testing

```bash
# Test embedding generation
curl http://localhost:11434/api/embeddings \
  -d '{"model":"nomic-embed-text","prompt":"function to sort array"}'

# Should return JSON with embedding vector
```

### Benefits

- ✅ **100% FREE** - No API costs ever
- ✅ **100% Private** - All data stays on your machine
- ✅ **Offline** - Works without internet
- ✅ **Easy Setup** - Install → Pull model → Configure
- ✅ **Good Quality** - Excellent for code search
- ✅ **Multiple Models** - Choose speed vs quality tradeoff

---

## Option 2: llama.cpp (Maximum Performance)

### Overview

- **Cost:** 100% FREE 🔒
- **Privacy:** All data stays on your machine
- **Setup:** Medium (15 minutes, requires compilation)
- **Quality:** Good (same as Ollama models, GGUF format)
- **Best for:** Performance optimization, GPU acceleration, GGUF models

### Installation & Setup

```bash
# 1. Clone and build llama.cpp
git clone https://github.com/ggerganov/llama.cpp
cd llama.cpp

# Build with GPU support (optional):
# For CUDA (NVIDIA): make LLAMA_CUDA=1
# For Metal (Apple Silicon): make LLAMA_METAL=1
# For CPU only: make
make

# 2. Download embedding model (GGUF format)
# Example: nomic-embed-text GGUF
wget https://huggingface.co/nomic-ai/nomic-embed-text-v1.5-GGUF/resolve/main/nomic-embed-text-v1.5.Q4_K_M.gguf

# 3. Start llama-server with embedding model
./llama-server \
  -m nomic-embed-text-v1.5.Q4_K_M.gguf \
  --port 8080 \
  --embedding

# 4. Verify server is running
curl http://localhost:8080/health
# Should return: {"status":"ok"}
```

### Configuration

Add to `.env`:

```env
# llama.cpp embeddings configuration
LLAMACPP_EMBEDDINGS_ENDPOINT=http://localhost:8080/embeddings
```

### Available Models (GGUF)

**nomic-embed-text-v1.5** (Recommended) ⭐
- **File:** `nomic-embed-text-v1.5.Q4_K_M.gguf`
- **Download:** https://huggingface.co/nomic-ai/nomic-embed-text-v1.5-GGUF
- **Dimensions:** 768
- **Size:** ~80MB
- **Quality:** Excellent for code
- **Best for:** Best all-around choice

**all-MiniLM-L6-v2** (Fastest)
- **File:** `all-MiniLM-L6-v2.Q4_K_M.gguf`
- **Download:** https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2-GGUF
- **Dimensions:** 384
- **Size:** ~25MB
- **Quality:** Good for simple searches
- **Best for:** Speed-critical applications

**bge-large-en-v1.5** (Highest Quality)
- **File:** `bge-large-en-v1.5.Q4_K_M.gguf`
- **Download:** https://huggingface.co/BAAI/bge-large-en-v1.5-GGUF
- **Dimensions:** 1024
- **Size:** ~350MB
- **Quality:** Best quality for embeddings
- **Best for:** Large codebases, quality-critical applications

### GPU Support

llama.cpp supports multiple GPU backends for faster embedding generation:

**NVIDIA CUDA:**
```bash
make LLAMA_CUDA=1
./llama-server -m model.gguf --embedding --n-gpu-layers 32
```

**Apple Silicon Metal:**
```bash
make LLAMA_METAL=1
./llama-server -m model.gguf --embedding --n-gpu-layers 32
```

**AMD ROCm:**
```bash
make LLAMA_ROCM=1
./llama-server -m model.gguf --embedding --n-gpu-layers 32
```

**Vulkan (Universal):**
```bash
make LLAMA_VULKAN=1
./llama-server -m model.gguf --embedding --n-gpu-layers 32
```

### Testing

```bash
# Test embedding generation
curl http://localhost:8080/embeddings \
  -H "Content-Type: application/json" \
  -d '{"content":"function to sort array"}'

# Should return JSON with embedding vector
```

### Benefits

- ✅ **100% FREE** - No API costs
- ✅ **100% Private** - All data stays local
- ✅ **Faster than Ollama** - Optimized C++ implementation
- ✅ **GPU Acceleration** - CUDA, Metal, ROCm, Vulkan
- ✅ **Lower Memory** - Quantization options (Q4, Q5, Q8)
- ✅ **Any GGUF Model** - Use any embedding model from HuggingFace

### llama.cpp vs Ollama

| Feature | Ollama | llama.cpp |
|---------|--------|-----------|
| **Setup** | Easy (app) | Manual (compile) |
| **Model Format** | Ollama-specific | Any GGUF model |
| **Performance** | Good | **Better** (optimized C++) |
| **GPU Support** | Yes | Yes (more options) |
| **Memory Usage** | Higher | **Lower** (more quantization options) |
| **Flexibility** | Limited models | **Any GGUF** from HuggingFace |

---

## Option 3: OpenRouter (Simplest Cloud)

### Overview

- **Cost:** ~$0.01-0.10/month (typical usage)
- **Privacy:** Cloud-based
- **Setup:** Very easy (2 minutes)
- **Quality:** Excellent (best-in-class models)
- **Best for:** Simplicity, quality, one key for chat + embeddings

### Configuration

Add to `.env`:

```env
# OpenRouter configuration (if not already set)
OPENROUTER_API_KEY=sk-or-v1-your-key-here

# Embeddings model (optional, defaults to text-embedding-ada-002)
OPENROUTER_EMBEDDINGS_MODEL=openai/text-embedding-3-small
```

**Note:** If you're already using `MODEL_PROVIDER=openrouter`, embeddings work automatically with the same key! No additional configuration needed.

### Getting OpenRouter API Key

1. Visit [openrouter.ai](https://openrouter.ai)
2. Sign in with GitHub, Google, or email
3. Go to [openrouter.ai/keys](https://openrouter.ai/keys)
4. Create a new API key
5. Add credits (pay-as-you-go, no subscription)

### Available Models

**openai/text-embedding-3-small** (Recommended) ⭐
```env
OPENROUTER_EMBEDDINGS_MODEL=openai/text-embedding-3-small
```
- **Dimensions:** 1536
- **Cost:** $0.02 per 1M tokens (80% cheaper than ada-002!)
- **Quality:** Excellent
- **Best for:** Best balance of quality and cost

**openai/text-embedding-ada-002** (Standard)
```env
OPENROUTER_EMBEDDINGS_MODEL=openai/text-embedding-ada-002
```
- **Dimensions:** 1536
- **Cost:** $0.10 per 1M tokens
- **Quality:** Excellent (widely supported standard)
- **Best for:** Compatibility

**openai/text-embedding-3-large** (Best Quality)
```env
OPENROUTER_EMBEDDINGS_MODEL=openai/text-embedding-3-large
```
- **Dimensions:** 3072
- **Cost:** $0.13 per 1M tokens
- **Quality:** Best quality available
- **Best for:** Large codebases where quality matters most

**voyage/voyage-code-2** (Code-Specialized)
```env
OPENROUTER_EMBEDDINGS_MODEL=voyage/voyage-code-2
```
- **Dimensions:** 1024
- **Cost:** $0.12 per 1M tokens
- **Quality:** Optimized specifically for code
- **Best for:** Code search (better than general models)

**voyage/voyage-2** (General Purpose)
```env
OPENROUTER_EMBEDDINGS_MODEL=voyage/voyage-2
```
- **Dimensions:** 1024
- **Cost:** $0.12 per 1M tokens
- **Quality:** Best for general text
- **Best for:** Mixed code + documentation

### Benefits

- ✅ **ONE Key** - Same key for chat + embeddings
- ✅ **No Setup** - Works immediately after adding key
- ✅ **Best Quality** - State-of-the-art embedding models
- ✅ **Automatic Fallbacks** - Switches providers if one is down
- ✅ **Competitive Pricing** - Often cheaper than direct providers

---

## Option 4: OpenAI (Direct)

### Overview

- **Cost:** ~$0.01-0.10/month (typical usage)
- **Privacy:** Cloud-based
- **Setup:** Easy (5 minutes)
- **Quality:** Excellent (best-in-class, direct from OpenAI)
- **Best for:** Best quality, direct OpenAI access

### Configuration

Add to `.env`:

```env
# OpenAI configuration (if not already set)
OPENAI_API_KEY=sk-your-openai-api-key

# Embeddings model (optional, defaults to text-embedding-ada-002)
# Recommended: Use text-embedding-3-small for 80% cost savings
# OPENAI_EMBEDDINGS_MODEL=text-embedding-3-small
```

### Getting OpenAI API Key

1. Visit [platform.openai.com](https://platform.openai.com)
2. Sign up or log in
3. Go to [API Keys](https://platform.openai.com/api-keys)
4. Create a new API key
5. Add credits to your account (pay-as-you-go)

### Available Models

**text-embedding-3-small** (Recommended) ⭐
```env
OPENAI_EMBEDDINGS_MODEL=text-embedding-3-small
```
- **Dimensions:** 1536
- **Cost:** $0.02 per 1M tokens (80% cheaper!)
- **Quality:** Excellent
- **Best for:** Best balance of quality and cost

**text-embedding-ada-002** (Standard)
```env
OPENAI_EMBEDDINGS_MODEL=text-embedding-ada-002
```
- **Dimensions:** 1536
- **Cost:** $0.10 per 1M tokens
- **Quality:** Excellent (standard, widely used)
- **Best for:** Compatibility

**text-embedding-3-large** (Best Quality)
```env
OPENAI_EMBEDDINGS_MODEL=text-embedding-3-large
```
- **Dimensions:** 3072
- **Cost:** $0.13 per 1M tokens
- **Quality:** Best quality available
- **Best for:** Maximum quality for large codebases

### Benefits

- ✅ **Best Quality** - Direct from OpenAI, best-in-class
- ✅ **Lowest Latency** - No intermediaries
- ✅ **Simple Setup** - Just one API key
- ✅ **Organization Support** - Use org-level API keys for teams

---

## Provider Comparison

### Feature Comparison

| Feature | Ollama | llama.cpp | OpenRouter | OpenAI |
|---------|--------|-----------|------------|--------|
| **Cost** | **FREE** | **FREE** | $0.01-0.10/mo | $0.01-0.10/mo |
| **Privacy** | 🔒 Local | 🔒 Local | ☁️ Cloud | ☁️ Cloud |
| **Setup** | Easy | Medium | Easy | Easy |
| **Quality** | Good | Good | **Excellent** | **Excellent** |
| **Speed** | Fast | **Faster** | Fast | Fast |
| **Offline** | ✅ Yes | ✅ Yes | ❌ No | ❌ No |
| **GPU Support** | Yes | **Yes (more options)** | N/A | N/A |
| **Model Choice** | Limited | **Any GGUF** | Many | Few |
| **Dimensions** | 384-1024 | 384-1024 | 1024-3072 | 1536-3072 |

### Cost Comparison (100K embeddings/month)

| Provider | Model | Monthly Cost |
|----------|-------|--------------|
| **Ollama** | Any | **$0** (100% FREE) 🔒 |
| **llama.cpp** | Any | **$0** (100% FREE) 🔒 |
| **OpenRouter** | text-embedding-3-small | **$0.02** |
| **OpenRouter** | text-embedding-ada-002 | $0.10 |
| **OpenRouter** | voyage-code-2 | $0.12 |
| **OpenAI** | text-embedding-3-small | **$0.02** |
| **OpenAI** | text-embedding-ada-002 | $0.10 |
| **OpenAI** | text-embedding-3-large | $0.13 |

---

## Embeddings Provider Override

By default, Lynkr uses the same provider as `MODEL_PROVIDER` for embeddings (if supported). To use a different provider for embeddings:

```env
# Use Databricks for chat, but Ollama for embeddings (privacy + cost savings)
MODEL_PROVIDER=databricks
DATABRICKS_API_BASE=https://your-workspace.databricks.com
DATABRICKS_API_KEY=your-key

# Override embeddings provider
EMBEDDINGS_PROVIDER=ollama
OLLAMA_EMBEDDINGS_MODEL=nomic-embed-text
```

**Smart provider detection:**
- Uses same provider as chat (if embeddings supported)
- Or automatically selects first available embeddings provider
- Or use `EMBEDDINGS_PROVIDER` to force a specific provider

---

## Recommended Configurations

### 1. Privacy-First (100% Local, FREE)

**Best for:** Sensitive codebases, offline work, zero cloud dependencies

```env
# Chat: Ollama (local)
MODEL_PROVIDER=ollama
OLLAMA_MODEL=llama3.1:8b

# Embeddings: Ollama (local)
OLLAMA_EMBEDDINGS_MODEL=nomic-embed-text

# Everything 100% local, 100% private, 100% FREE!
```

**Benefits:**
- ✅ Zero cloud dependencies
- ✅ All data stays on your machine
- ✅ Works offline
- ✅ 100% FREE

---

### 2. Simplest (One Key for Everything)

**Best for:** Easy setup, flexibility, quality

```env
# Chat + Embeddings: OpenRouter with ONE key
MODEL_PROVIDER=openrouter
OPENROUTER_API_KEY=sk-or-v1-your-key
OPENROUTER_MODEL=anthropic/claude-3.5-sonnet

# Embeddings work automatically with same key!
# Optional: Specify model for cost savings
OPENROUTER_EMBEDDINGS_MODEL=openai/text-embedding-3-small
```

**Benefits:**
- ✅ ONE key for everything
- ✅ Best quality embeddings
- ✅ 100+ chat models available
- ✅ ~$5-10/month total cost

---

### 3. Hybrid (Best of Both Worlds)

**Best for:** Privacy + Quality + Cost Optimization

```env
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

# Result: Free + private embeddings, mostly free chat, cloud for complex tasks
```

**Benefits:**
- ✅ 70-80% of chat requests FREE (Ollama via TIER_SIMPLE)
- ✅ 100% private embeddings (local)
- ✅ Cloud quality for complex tasks
- ✅ Intelligent automatic tier-based routing

---

### 4. Enterprise (Best Quality)

**Best for:** Large teams, quality-critical applications

```env
# Chat: Databricks (enterprise SLA)
MODEL_PROVIDER=databricks
DATABRICKS_API_BASE=https://your-workspace.databricks.com
DATABRICKS_API_KEY=your-key

# Embeddings: OpenRouter (best quality)
OPENROUTER_API_KEY=sk-or-v1-your-key
OPENROUTER_EMBEDDINGS_MODEL=voyage/voyage-code-2  # Code-specialized
```

**Benefits:**
- ✅ Enterprise chat (Claude 4.5)
- ✅ Best embedding quality (code-specialized)
- ✅ Separate billing/limits for chat vs embeddings
- ✅ Production-ready reliability

---

## Testing & Verification

### Test Embeddings Endpoint

```bash
# Test embedding generation
curl http://localhost:8081/v1/embeddings \
  -H "Content-Type: application/json" \
  -d '{
    "input": "function to sort an array",
    "model": "text-embedding-ada-002"
  }'

# Should return JSON with embedding vector
# Example response:
# {
#   "object": "list",
#   "data": [{
#     "object": "embedding",
#     "embedding": [0.123, -0.456, 0.789, ...],  # 768-3072 dimensions
#     "index": 0
#   }],
#   "model": "text-embedding-ada-002",
#   "usage": {"prompt_tokens": 7, "total_tokens": 7}
# }
```

### Test in Cursor

1. **Open Cursor IDE**
2. **Open a project**
3. **Press Cmd+L** (or Ctrl+L)
4. **Type:** `@Codebase find authentication logic`
5. **Expected:** Cursor returns relevant files

If @Codebase doesn't work:
- Check embeddings endpoint: `curl http://localhost:8081/v1/embeddings` (should not return 501)
- Restart Lynkr after adding embeddings config
- Restart Cursor to re-index codebase

---

## Troubleshooting

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

2. **Check embeddings provider in .env:**
   ```bash
   # Verify ONE of these is set:
   OLLAMA_EMBEDDINGS_MODEL=nomic-embed-text
   # OR
   LLAMACPP_EMBEDDINGS_ENDPOINT=http://localhost:8080/embeddings
   # OR
   OPENROUTER_API_KEY=sk-or-v1-your-key
   # OR
   OPENAI_API_KEY=sk-your-key
   ```

3. **Restart Lynkr** after adding embeddings config

4. **Restart Cursor** to re-index codebase

---

### Poor Search Results

**Symptoms:** @Codebase returns irrelevant files

**Solutions:**

1. **Upgrade to better embedding model:**
   ```bash
   # Ollama: Use larger model
   ollama pull mxbai-embed-large
   OLLAMA_EMBEDDINGS_MODEL=mxbai-embed-large

   # OpenRouter: Use code-specialized model
   OPENROUTER_EMBEDDINGS_MODEL=voyage/voyage-code-2
   ```

2. **Switch to cloud embeddings:**
   - Local models (Ollama/llama.cpp): Good quality
   - Cloud models (OpenRouter/OpenAI): Excellent quality

3. **This may be a Cursor indexing issue:**
   - Close and reopen workspace in Cursor
   - Wait for Cursor to re-index

---

### Ollama Model Not Found

**Symptoms:** `Error: model "nomic-embed-text" not found`

**Solutions:**

```bash
# List available models
ollama list

# Pull the model
ollama pull nomic-embed-text

# Verify it's available
ollama list
# Should show: nomic-embed-text  ...
```

---

### llama.cpp Connection Refused

**Symptoms:** `ECONNREFUSED` when accessing llama.cpp endpoint

**Solutions:**

1. **Verify llama-server is running:**
   ```bash
   lsof -i :8080
   # Should show llama-server process
   ```

2. **Start llama-server with embedding model:**
   ```bash
   ./llama-server -m nomic-embed-text-v1.5.Q4_K_M.gguf --port 8080 --embedding
   ```

3. **Test endpoint:**
   ```bash
   curl http://localhost:8080/health
   # Should return: {"status":"ok"}
   ```

---

### Rate Limiting (Cloud Providers)

**Symptoms:** Too many requests error (429)

**Solutions:**

1. **Switch to local embeddings:**
   ```env
   # Ollama (no rate limits, 100% FREE)
   OLLAMA_EMBEDDINGS_MODEL=nomic-embed-text
   ```

2. **Use OpenRouter** (pooled rate limits):
   ```env
   OPENROUTER_API_KEY=sk-or-v1-your-key
   ```

---

## Next Steps

- **[Cursor Integration](cursor-integration.md)** - Full Cursor IDE setup guide
- **[Provider Configuration](providers.md)** - Configure all providers
- **[Installation Guide](installation.md)** - Install Lynkr
- **[Troubleshooting](troubleshooting.md)** - More troubleshooting tips

---

## Getting Help

- **[GitHub Discussions](https://github.com/vishalveerareddy123/Lynkr/discussions)** - Community Q&A
- **[GitHub Issues](https://github.com/vishalveerareddy123/Lynkr/issues)** - Report bugs
- **[FAQ](faq.md)** - Frequently asked questions
