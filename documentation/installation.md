# Installation Guide

Complete installation instructions for all supported methods. Choose the option that best fits your workflow.

---

## Prerequisites

Before installing Lynkr, ensure you have:

- **Node.js 18+** (required for the global `fetch` API)
- **npm** (bundled with Node.js)
- At least one of the following:
  - **Databricks account** with Claude serving endpoint
  - **AWS account** with Bedrock access
  - **OpenRouter API key** (get from [openrouter.ai/keys](https://openrouter.ai/keys))
  - **Azure OpenAI** or **Azure Anthropic** subscription
  - **OpenAI API key** (get from [platform.openai.com/api-keys](https://platform.openai.com/api-keys))
  - **Moonshot AI API key** (get from [platform.moonshot.ai](https://platform.moonshot.ai))
  - **Ollama** installed locally (for free local models)
- Optional: **Docker** for containerized deployment or MCP sandboxing
- Optional: **Claude Code CLI** (latest release) for CLI usage

---

## Installation Methods

### Method 1: NPM Package (Recommended)

**Fastest way to get started:**

```bash
# Install globally
npm install -g lynkr

# Verify installation
lynkr --version
```

**Start the server:**
```bash
lynkr start
# Or simply:
lynkr
```

**Benefits:**
- ✅ Global `lynkr` command available everywhere
- ✅ Automatic updates via `npm update -g lynkr`
- ✅ No repository cloning required
- ✅ Works immediately after install

---

### Method 2: Quick Install Script (curl)

**One-line installation:**

```bash
curl -fsSL https://raw.githubusercontent.com/vishalveerareddy123/Lynkr/main/install.sh | bash
```

This will:
- Clone Lynkr to `~/.lynkr`
- Install dependencies
- Create a default `.env` file
- Set up the `lynkr` command

**Custom installation directory:**
```bash
curl -fsSL https://raw.githubusercontent.com/vishalveerareddy123/Lynkr/main/install.sh | bash -s -- --dir /opt/lynkr
```

---

### Method 3: Git Clone (For Development)

**Clone from source:**

```bash
# Clone repository
git clone https://github.com/vishalveerareddy123/Lynkr.git
cd Lynkr

# Install dependencies
npm install

# Create .env from example
cp .env.example .env

# Edit .env with your provider credentials
nano .env

# Start server
npm start
```

**Development mode (auto-restart on changes):**
```bash
npm run dev
```

**Benefits:**
- ✅ Full source code access
- ✅ Easy to contribute changes
- ✅ Run latest development version
- ✅ Auto-restart in dev mode

---

### Method 4: Homebrew (macOS/Linux)

**Install via Homebrew:**

```bash
# Add the Lynkr tap
brew tap vishalveerareddy123/lynkr

# Install Lynkr
brew install lynkr

# Verify installation
lynkr --version

# Start server
lynkr start
```

**Update Lynkr:**
```bash
brew upgrade lynkr
```

**Benefits:**
- ✅ Native macOS/Linux package management
- ✅ Automatic dependency resolution
- ✅ Easy updates via Homebrew
- ✅ System-wide installation

---

### Method 5: Docker (Production)

**Docker Compose (Recommended for Production):**

```bash
# Clone repository
git clone https://github.com/vishalveerareddy123/Lynkr.git
cd Lynkr

# Copy environment template
cp .env.example .env

# Edit .env with your credentials
nano .env

# Start services (Lynkr + Ollama)
docker-compose up -d

# Pull Ollama model (if using Ollama)
docker exec ollama ollama pull llama3.1:8b

# Verify it's running
curl http://localhost:8081/health/live
```

**Standalone Docker:**

```bash
# Build image
docker build -t lynkr:latest .

# Run container
docker run -d \
  --name lynkr \
  -p 8081:8081 \
  -e MODEL_PROVIDER=databricks \
  -e DATABRICKS_API_BASE=https://your-workspace.databricks.com \
  -e DATABRICKS_API_KEY=your-key \
  -v $(pwd)/data:/app/data \
  lynkr:latest
```

**Benefits:**
- ✅ Isolated environment
- ✅ Easy deployment to Kubernetes/cloud
- ✅ Bundled with Ollama (docker-compose)
- ✅ Volume persistence for data
- ✅ Production-ready configuration

See [Docker Deployment Guide](docker.md) for advanced options (GPU support, K8s, health checks).

---

## Configuration

After installation, configure Lynkr for your chosen provider:

### Creating Configuration File

**Option A: Environment Variables (Recommended for Quick Start)**
```bash
export MODEL_PROVIDER=databricks
export DATABRICKS_API_BASE=https://your-workspace.databricks.com
export DATABRICKS_API_KEY=your-key
lynkr start
```

**Option B: .env File (Recommended for Production)**
```bash
# Copy example file
cp .env.example .env

# Edit with your credentials
nano .env
```

Example `.env` file:
```env
# Core Configuration
MODEL_PROVIDER=databricks
PORT=8081
LOG_LEVEL=info
WORKSPACE_ROOT=/path/to/your/projects

# Databricks Configuration
DATABRICKS_API_BASE=https://your-workspace.cloud.databricks.com
DATABRICKS_API_KEY=dapi1234567890abcdef

# Tool Execution
TOOL_EXECUTION_MODE=server

# Memory System (optional)
MEMORY_ENABLED=true
MEMORY_RETRIEVAL_LIMIT=5
```

---

## Understanding Provider Selection

Lynkr has two modes for selecting which AI provider handles your requests:

| Mode | Config | How it works | Best for |
|------|--------|-------------|----------|
| **Static** | `MODEL_PROVIDER=ollama` | All requests go to one provider | Simple setups, single provider |
| **Tier-based** | All 4 `TIER_*` vars set | Requests route by complexity score | Cost optimization, multi-provider |

**Static mode** — Set `MODEL_PROVIDER` to your provider. Every request goes there. Simple and predictable.

**Tier-based mode** — Set all 4 `TIER_*` env vars (`TIER_SIMPLE`, `TIER_MEDIUM`, `TIER_COMPLEX`, `TIER_REASONING`). Each request is scored for complexity and routed to the appropriate tier's provider. When all 4 are set, they **override** `MODEL_PROVIDER` for routing decisions.

> **Note:** If only some `TIER_*` vars are set (not all 4), tier routing is disabled and `MODEL_PROVIDER` is used instead. `MODEL_PROVIDER` is always required as a fallback default even when tiers are configured.

See [Tier-Based Routing](#tier-based-routing-cost-optimization) below for full setup, or pick a single provider from the Quick Start examples to get running immediately.

---

## Quick Start Examples

Choose your provider and follow the setup steps:

### 1. Databricks (Production)

**Best for:** Enterprise production use, Claude Sonnet 4.5, Claude Opus 4.5

```bash
# Install
npm install -g lynkr

# Configure
export MODEL_PROVIDER=databricks
export DATABRICKS_API_BASE=https://your-workspace.cloud.databricks.com
export DATABRICKS_API_KEY=dapi1234567890abcdef

# Start
lynkr start
```

**Get Databricks credentials:**
1. Log in to your Databricks workspace
2. Go to **Settings** → **User Settings**
3. Click **Generate New Token**
4. Copy the token (this is your `DATABRICKS_API_KEY`)
5. Your workspace URL is like `https://your-workspace.cloud.databricks.com`

---

### 2. AWS Bedrock (100+ Models)

**Best for:** AWS ecosystem, multi-model flexibility, Claude + alternatives

```bash
# Install
npm install -g lynkr

# Configure
export MODEL_PROVIDER=bedrock
export AWS_BEDROCK_API_KEY=ABSK...your-bedrock-api-key
export AWS_BEDROCK_REGION=us-east-1
export AWS_BEDROCK_MODEL_ID=us.anthropic.claude-3-5-sonnet-20241022-v2:0

# Start
lynkr start
```

**Get AWS Bedrock credentials:**
1. Log in to AWS Console
2. Navigate to **IAM** → **Security Credentials**
3. Create new access key
4. Enable Bedrock in your region (us-east-1, us-west-2, etc.)
5. Request model access in Bedrock console

**Popular Bedrock models:**
- `anthropic.claude-3-5-sonnet-20241022-v2:0` - Claude 3.5 Sonnet
- `us.anthropic.claude-sonnet-4-5-20250929-v1:0` - Claude 4.5 Sonnet
- `amazon.titan-text-express-v1` - Amazon Titan
- `meta.llama3-70b-instruct-v1:0` - Llama 3
- See [BEDROCK_MODELS.md](../BEDROCK_MODELS.md) for complete list

---

### 3. OpenRouter (Simplest Cloud)

**Best for:** Quick setup, 100+ models, cost flexibility

```bash
# Install
npm install -g lynkr

# Configure
export MODEL_PROVIDER=openrouter
export OPENROUTER_API_KEY=sk-or-v1-your-key
export OPENROUTER_MODEL=anthropic/claude-3.5-sonnet

# Start
lynkr start
```

**Get OpenRouter API key:**
1. Visit [openrouter.ai](https://openrouter.ai)
2. Sign in with GitHub, Google, or email
3. Go to [openrouter.ai/keys](https://openrouter.ai/keys)
4. Create a new API key
5. Add credits (pay-as-you-go, no subscription)

**Popular OpenRouter models:**
- `anthropic/claude-3.5-sonnet` - Claude 3.5 Sonnet
- `openai/gpt-4o` - GPT-4o
- `openai/gpt-4o-mini` - GPT-4o mini (affordable)
- `google/gemini-pro-1.5` - Gemini Pro
- `meta-llama/llama-3.1-70b-instruct` - Llama 3.1
- See [openrouter.ai/models](https://openrouter.ai/models) for complete list

---

### 4. Ollama (100% Local, FREE)

**Best for:** Local development, privacy, offline use, no API costs

```bash
# Install Ollama first
brew install ollama  # macOS
# Or download from: https://ollama.ai/download

# Start Ollama service
ollama serve

# Pull a model (in separate terminal)
ollama pull llama3.1:8b

# Install Lynkr
npm install -g lynkr

# Configure
export MODEL_PROVIDER=ollama
export OLLAMA_MODEL=llama3.1:8b

# Start
lynkr start
```

**Recommended Ollama models for Claude Code:**
- `llama3.1:8b` - Good balance (tool calling supported)
- `llama3.2` - Latest Llama (tool calling supported)
- `qwen2.5:14b` - Strong reasoning (larger model, 7b struggles with tools)
- `mistral:7b-instruct` - Fast and capable

**Model sizes:**
- 7B models: ~4-5GB download
- 8B models: ~4.7GB download
- 14B models: ~8GB download
- 32B models: ~18GB download

---

### 5. llama.cpp (Maximum Performance)

**Best for:** Custom GGUF models, maximum control, optimized inference

```bash
# Install and build llama.cpp
git clone https://github.com/ggerganov/llama.cpp
cd llama.cpp && make

# Download a GGUF model
wget https://huggingface.co/Qwen/Qwen2.5-Coder-7B-Instruct-GGUF/resolve/main/qwen2.5-coder-7b-instruct-q4_k_m.gguf

# Start llama-server
./llama-server -m qwen2.5-coder-7b-instruct-q4_k_m.gguf --port 8080

# In separate terminal, install Lynkr
npm install -g lynkr

# Configure
export MODEL_PROVIDER=llamacpp
export LLAMACPP_ENDPOINT=http://localhost:8080
export LLAMACPP_MODEL=qwen2.5-coder-7b

# Start
lynkr start
```

**llama.cpp vs Ollama:**

| Feature | Ollama | llama.cpp |
|---------|--------|-----------|
| Setup | Easy (app) | Manual (compile) |
| Model Format | Ollama-specific | Any GGUF model |
| Performance | Good | Excellent (optimized C++) |
| GPU Support | Yes | Yes (CUDA, Metal, ROCm, Vulkan) |
| Memory Usage | Higher | Lower (quantization options) |
| API | Custom | OpenAI-compatible |
| Flexibility | Limited models | Any GGUF from HuggingFace |

---

### 6. Azure OpenAI

**Best for:** Azure integration, Microsoft ecosystem, GPT-4o, o1, o3

```bash
# Install
npm install -g lynkr

# Configure (IMPORTANT: Use full endpoint URL)
export MODEL_PROVIDER=azure-openai
export AZURE_OPENAI_ENDPOINT="https://your-resource.openai.azure.com/openai/deployments/YOUR-DEPLOYMENT/chat/completions?api-version=2025-01-01-preview"
export AZURE_OPENAI_API_KEY=your-azure-api-key
export AZURE_OPENAI_DEPLOYMENT=gpt-4o

# Start
lynkr start
```

**Get Azure OpenAI credentials:**
1. Log in to [Azure Portal](https://portal.azure.com)
2. Navigate to **Azure OpenAI** service
3. Go to **Keys and Endpoint**
4. Copy **KEY 1** (this is your API key)
5. Copy **Endpoint** URL
6. Create a deployment (gpt-4o, gpt-4o-mini, etc.)

**Supported deployments:**
- `gpt-4o` - Latest GPT-4o
- `gpt-4o-mini` - Smaller, faster GPT-4o
- `gpt-5-chat` - GPT-5 (if available in your region)
- `o1-preview` - Reasoning model
- `o3-mini` - Latest reasoning model

---

### 7. Azure Anthropic

**Best for:** Azure-hosted Claude models

```bash
# Install
npm install -g lynkr

# Configure
export MODEL_PROVIDER=azure-anthropic
export AZURE_ANTHROPIC_ENDPOINT=https://your-resource.services.ai.azure.com/anthropic/v1/messages
export AZURE_ANTHROPIC_API_KEY=your-azure-api-key

# Start
lynkr start
```

---

### 8. OpenAI (Direct)

**Best for:** Direct OpenAI API access, lowest latency to OpenAI

```bash
# Install
npm install -g lynkr

# Configure
export MODEL_PROVIDER=openai
export OPENAI_API_KEY=sk-your-openai-api-key
export OPENAI_MODEL=gpt-4o

# Start
lynkr start
```

**Get OpenAI API key:**
1. Visit [platform.openai.com](https://platform.openai.com)
2. Sign up or log in
3. Go to [API Keys](https://platform.openai.com/api-keys)
4. Create a new API key
5. Add credits to your account

**Supported models:**
- `gpt-4o` - Latest GPT-4o
- `gpt-4o-mini` - Affordable GPT-4o
- `o1-preview` - Reasoning model
- `o1-mini` - Smaller reasoning model

---

### 9. Moonshot AI / Kimi (Affordable Cloud)

**Best for:** Affordable cloud models, thinking/reasoning models

```bash
# Install
npm install -g lynkr

# Configure
export MODEL_PROVIDER=moonshot
export MOONSHOT_API_KEY=sk-your-moonshot-api-key
export MOONSHOT_MODEL=kimi-k2-turbo-preview

# Start
lynkr start
```

**Get Moonshot API key:**
1. Visit [platform.moonshot.ai](https://platform.moonshot.ai)
2. Sign up or log in
3. Create a new API key
4. Add credits to your account

**Available models:**
- `kimi-k2-turbo-preview` - Fast, efficient, tool calling support
- `kimi-k2-thinking` - Chain-of-thought reasoning model

---

### 10. LM Studio (Local with GUI)

**Best for:** Local models with graphical interface

```bash
# Download and install LM Studio from: https://lmstudio.ai

# In LM Studio:
# 1. Download a model (e.g., Qwen2.5-Coder-7B)
# 2. Start local server (port 1234)

# Install Lynkr
npm install -g lynkr

# Configure
export MODEL_PROVIDER=lmstudio
export LMSTUDIO_ENDPOINT=http://localhost:1234

# Start
lynkr start
```

---

## Tier-Based Routing (Cost Optimization)

**Use local Ollama for simple tasks, cloud for complex ones:**

```bash
# Start Ollama
ollama serve
ollama pull llama3.2

# Configure tier-based routing (set all 4 to enable)
export TIER_SIMPLE=ollama:llama3.2
export TIER_MEDIUM=openrouter:openai/gpt-4o-mini
export TIER_COMPLEX=databricks:databricks-claude-sonnet-4-5
export TIER_REASONING=databricks:databricks-claude-sonnet-4-5
export FALLBACK_ENABLED=true
export FALLBACK_PROVIDER=databricks
export DATABRICKS_API_BASE=https://your-workspace.databricks.com
export DATABRICKS_API_KEY=your-key

# Start Lynkr
lynkr start
```

**How it works:**
- Each request is scored for complexity (0-100) and mapped to a tier
- **SIMPLE (0-25)**: Ollama (free, local, fast)
- **MEDIUM (26-50)**: OpenRouter (affordable cloud)
- **COMPLEX (51-75)**: Databricks (most capable)
- **REASONING (76-100)**: Databricks (best available)
- **Provider failures**: Automatic transparent fallback to cloud

**Cost savings:**
- **65-100%** for requests routed to local models
- **40-87%** faster for simple requests
- **Privacy**: Simple queries never leave your machine

---

## Verification & Testing

### Check Server Health

```bash
# Basic health check
curl http://localhost:8081/health/live

# Expected response:
# {
#   "status": "ok",
#   "provider": "databricks",
#   "timestamp": "2026-01-11T12:00:00.000Z"
# }
```

### Check Readiness (includes provider connectivity)

```bash
curl http://localhost:8081/health/ready

# Expected response (all checks passing):
# {
#   "status": "ready",
#   "checks": {
#     "database": "ok",
#     "provider": "ok"
#   }
# }
```

### Test with Claude Code CLI

```bash
# Configure Claude Code CLI
export ANTHROPIC_BASE_URL=http://localhost:8081
export ANTHROPIC_API_KEY=dummy

# Test simple query
claude "What is 2+2?"

# Should return response from your configured provider
```

---

## Environment Variables Reference

See [Provider Configuration Guide](providers.md) for complete environment variable reference for all providers.

### Core Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `MODEL_PROVIDER` | Provider to use (`databricks`, `bedrock`, `openrouter`, `ollama`, `llamacpp`, `azure-openai`, `azure-anthropic`, `openai`, `lmstudio`, `moonshot`, `zai`, `vertex`) | `databricks` |
| `PORT` | HTTP port for proxy server | `8081` |
| `WORKSPACE_ROOT` | Workspace directory path | `process.cwd()` |
| `LOG_LEVEL` | Logging level (`error`, `warn`, `info`, `debug`) | `info` |
| `TOOL_EXECUTION_MODE` | Where tools execute (`server`, `client`) | `server` |

### Provider-Specific Variables

Each provider requires specific credentials and configuration. See [Provider Configuration](providers.md) for complete details.

---

## Troubleshooting

### Server Won't Start

**Issue:** `Error: MODEL_PROVIDER requires credentials`

**Solution:**
```bash
# Check your provider is configured
echo $MODEL_PROVIDER
echo $DATABRICKS_API_KEY  # or other provider key

# If empty, set them:
export MODEL_PROVIDER=databricks
export DATABRICKS_API_KEY=your-key
```

### Connection Refused

**Issue:** `ECONNREFUSED` when connecting to provider

**Solution:**
1. Check provider URL is correct
2. Verify API key is valid
3. Check network connectivity
4. For Ollama: Ensure `ollama serve` is running

### Port Already in Use

**Issue:** `Error: listen EADDRINUSE: address already in use :::8081`

**Solution:**
```bash
# Find process using port 8081
lsof -i :8081

# Kill the process
kill -9 <PID>

# Or use different port
export PORT=8082
lynkr start
```

### Ollama Model Not Found

**Issue:** `Error: model "llama3.1:8b" not found`

**Solution:**
```bash
# List available models
ollama list

# Pull the model
ollama pull llama3.1:8b

# Verify it's available
ollama list
```

---

## Next Steps

- **[Provider Configuration](providers.md)** - Detailed configuration for all providers
- **[Claude Code CLI Setup](claude-code-cli.md)** - Connect Claude Code CLI
- **[Cursor Integration](cursor-integration.md)** - Connect Cursor IDE
- **[Features Guide](features.md)** - Learn about advanced features
- **[Production Deployment](production.md)** - Deploy to production

---

## Getting Help

- **[Troubleshooting Guide](troubleshooting.md)** - Common issues and solutions
- **[FAQ](faq.md)** - Frequently asked questions
- **[GitHub Discussions](https://github.com/vishalveerareddy123/Lynkr/discussions)** - Community Q&A
- **[GitHub Issues](https://github.com/vishalveerareddy123/Lynkr/issues)** - Report bugs
