# Provider Configuration Guide

Complete configuration reference for all 9+ supported LLM providers. Each provider section includes setup instructions, model options, pricing, and example configurations.

---

## Overview

Lynkr supports multiple AI model providers, giving you flexibility in choosing the right model for your needs:

| Provider | Type | Models | Cost | Privacy | Setup Complexity |
|----------|------|--------|------|---------|------------------|
| **AWS Bedrock** | Cloud | 100+ (Claude, DeepSeek, Qwen, Nova, Titan, Llama, Mistral) | $-$$$ | Cloud | Easy |
| **Databricks** | Cloud | Claude Sonnet 4.5, Opus 4.5 | $$$ | Cloud | Medium |
| **OpenRouter** | Cloud | 100+ (GPT, Claude, Gemini, Llama, Mistral, etc.) | $-$$ | Cloud | Easy |
| **Ollama** | Local | Unlimited (free, offline) | **FREE** | 🔒 100% Local | Easy |
| **llama.cpp** | Local | Any GGUF model | **FREE** | 🔒 100% Local | Medium |
| **Azure OpenAI** | Cloud | GPT-4o, GPT-5, o1, o3 | $$$ | Cloud | Medium |
| **Azure Anthropic** | Cloud | Claude models | $$$ | Cloud | Medium |
| **OpenAI** | Cloud | GPT-4o, o1, o3 | $$$ | Cloud | Easy |
| **LM Studio** | Local | Local models with GUI | **FREE** | 🔒 100% Local | Easy |
| **MLX OpenAI Server** | Local | Apple Silicon optimized | **FREE** | 🔒 100% Local | Easy |

---

## Configuration Methods

There are two routing modes. Choose based on your needs:

### Static Routing (Single Provider)

Set `MODEL_PROVIDER` to send all requests to one provider:

```bash
export MODEL_PROVIDER=databricks
export DATABRICKS_API_BASE=https://your-workspace.databricks.com
export DATABRICKS_API_KEY=your-key
lynkr start
```

### Tier-Based Routing (Recommended for Cost Optimization)

Set all 4 `TIER_*` vars to route requests by complexity. When configured, these **override** `MODEL_PROVIDER` for routing decisions:

```bash
export MODEL_PROVIDER=ollama                            # Kept as config default
export TIER_SIMPLE=ollama:llama3.2                      # Simple tasks → local (free)
export TIER_MEDIUM=openrouter:openai/gpt-4o-mini        # Medium → affordable cloud
export TIER_COMPLEX=databricks:claude-sonnet             # Complex → capable cloud
export TIER_REASONING=databricks:claude-sonnet            # Reasoning → best available
lynkr start
```

> **Note:** All 4 `TIER_*` vars must be set. If any are missing, tier routing is disabled and `MODEL_PROVIDER` is used for all requests.

### .env File (Recommended for Production)

```bash
# Copy example file
cp .env.example .env

# Edit with your credentials
nano .env
```

Example `.env`:
```env
MODEL_PROVIDER=ollama
DATABRICKS_API_BASE=https://your-workspace.databricks.com
DATABRICKS_API_KEY=dapi1234567890abcdef
PORT=8081
LOG_LEVEL=info

# Tier routing (optional — set all 4 to enable)
TIER_SIMPLE=ollama:llama3.2
TIER_MEDIUM=openrouter:openai/gpt-4o-mini
TIER_COMPLEX=databricks:claude-sonnet
TIER_REASONING=databricks:claude-sonnet
```

---

## Remote/Network Configuration

**All provider endpoints support remote addresses** - you're not limited to `localhost`. This enables powerful setups like:

- 🖥️ **GPU Server**: Run Ollama/llama.cpp on a dedicated GPU machine
- 🏢 **Team Sharing**: Multiple developers using one Lynkr instance
- ☁️ **Hybrid**: Lynkr on local machine, models on cloud VM

### Examples

**Ollama on Remote GPU Server**
```env
MODEL_PROVIDER=ollama
OLLAMA_ENDPOINT=http://192.168.1.100:11434    # Local network IP
# or
OLLAMA_ENDPOINT=http://gpu-server.local:11434  # Hostname
# or
OLLAMA_ENDPOINT=http://ollama.mycompany.com:11434  # Domain
```

**llama.cpp on Remote Machine**
```env
MODEL_PROVIDER=llamacpp
LLAMACPP_ENDPOINT=http://10.0.0.50:8080
```

**LM Studio on Another Computer**
```env
MODEL_PROVIDER=lmstudio
LMSTUDIO_ENDPOINT=http://workstation.local:1234
```

### Network Requirements

| Setup | Requirement |
|-------|-------------|
| Same machine | `localhost` or `127.0.0.1` |
| Local network | IP address or hostname, firewall allows port |
| Remote/Internet | Public IP/domain, port forwarding, consider VPN/auth |

> ⚠️ **Security Note**: When exposing endpoints over a network, ensure proper firewall rules and consider using a VPN or SSH tunnel for sensitive deployments.

---

## Provider-Specific Configuration

### 1. AWS Bedrock (100+ Models)

**Best for:** AWS ecosystem, multi-model flexibility, Claude + alternatives

#### Configuration

```env
MODEL_PROVIDER=bedrock
AWS_BEDROCK_API_KEY=your-bearer-token
AWS_BEDROCK_REGION=us-east-1
AWS_BEDROCK_MODEL_ID=anthropic.claude-3-5-sonnet-20241022-v2:0
```

#### Getting AWS Bedrock API Key

1. Log in to [AWS Console](https://console.aws.amazon.com/)
2. Navigate to **Bedrock** → **API Keys**
3. Click **Generate API Key**
4. Copy the bearer token (this is your `AWS_BEDROCK_API_KEY`)
5. Enable model access in Bedrock console
6. See: [AWS Bedrock API Keys Documentation](https://docs.aws.amazon.com/bedrock/latest/userguide/api-keys-generate.html)

#### Available Regions

- `us-east-1` (N. Virginia) - Most models available
- `us-west-2` (Oregon)
- `us-east-2` (Ohio)
- `ap-southeast-1` (Singapore)
- `ap-northeast-1` (Tokyo)
- `eu-central-1` (Frankfurt)

#### Model Catalog

**Claude Models (Best for Tool Calling)** ✅

Claude 4.5 (latest - requires inference profiles):
```env
AWS_BEDROCK_MODEL_ID=us.anthropic.claude-sonnet-4-5-20250929-v1:0  # Regional US
AWS_BEDROCK_MODEL_ID=us.anthropic.claude-haiku-4-5-20251001-v1:0   # Fast, efficient
AWS_BEDROCK_MODEL_ID=global.anthropic.claude-sonnet-4-5-20250929-v1:0  # Cross-region
```

Claude 3.x models:
```env
AWS_BEDROCK_MODEL_ID=anthropic.claude-3-5-sonnet-20241022-v2:0  # Excellent tool calling
AWS_BEDROCK_MODEL_ID=anthropic.claude-3-opus-20240229-v1:0      # Most capable
AWS_BEDROCK_MODEL_ID=anthropic.claude-3-haiku-20240307-v1:0     # Fast, cheap
```

**DeepSeek Models (NEW - 2025)**
```env
AWS_BEDROCK_MODEL_ID=us.deepseek.r1-v1:0    # DeepSeek R1 - reasoning model (o1-style)
```

**Qwen Models (Alibaba - NEW 2025)**
```env
AWS_BEDROCK_MODEL_ID=qwen.qwen3-235b-a22b-2507-v1:0        # Largest, 235B parameters
AWS_BEDROCK_MODEL_ID=qwen.qwen3-32b-v1:0                   # Balanced, 32B
AWS_BEDROCK_MODEL_ID=qwen.qwen3-coder-480b-a35b-v1:0       # Coding specialist, 480B
AWS_BEDROCK_MODEL_ID=qwen.qwen3-coder-30b-a3b-v1:0         # Coding, smaller
```

**OpenAI Open-Weight Models (NEW - 2025)**
```env
AWS_BEDROCK_MODEL_ID=openai.gpt-oss-120b-1:0   # 120B parameters, open-weight
AWS_BEDROCK_MODEL_ID=openai.gpt-oss-20b-1:0    # 20B parameters, efficient
```

**Google Gemma Models (Open-Weight)**
```env
AWS_BEDROCK_MODEL_ID=google.gemma-3-27b    # 27B parameters
AWS_BEDROCK_MODEL_ID=google.gemma-3-12b    # 12B parameters
AWS_BEDROCK_MODEL_ID=google.gemma-3-4b     # 4B parameters, efficient
```

**Amazon Models**

Nova (multimodal):
```env
AWS_BEDROCK_MODEL_ID=us.amazon.nova-pro-v1:0    # Best quality, multimodal, 300K context
AWS_BEDROCK_MODEL_ID=us.amazon.nova-lite-v1:0   # Fast, cost-effective
AWS_BEDROCK_MODEL_ID=us.amazon.nova-micro-v1:0  # Ultra-fast, text-only
```

Titan:
```env
AWS_BEDROCK_MODEL_ID=amazon.titan-text-premier-v1:0  # Largest
AWS_BEDROCK_MODEL_ID=amazon.titan-text-express-v1    # Fast
AWS_BEDROCK_MODEL_ID=amazon.titan-text-lite-v1       # Cheapest
```

**Meta Llama Models**
```env
AWS_BEDROCK_MODEL_ID=meta.llama3-1-70b-instruct-v1:0   # Most capable
AWS_BEDROCK_MODEL_ID=meta.llama3-1-8b-instruct-v1:0    # Fast, efficient
```

**Mistral Models**
```env
AWS_BEDROCK_MODEL_ID=mistral.mistral-large-2407-v1:0       # Largest, coding, multilingual
AWS_BEDROCK_MODEL_ID=mistral.mistral-small-2402-v1:0       # Efficient
AWS_BEDROCK_MODEL_ID=mistral.mixtral-8x7b-instruct-v0:1    # Mixture of experts
```

**Cohere Command Models**
```env
AWS_BEDROCK_MODEL_ID=cohere.command-r-plus-v1:0  # Best for RAG, search
AWS_BEDROCK_MODEL_ID=cohere.command-r-v1:0       # Balanced
```

**AI21 Jamba Models**
```env
AWS_BEDROCK_MODEL_ID=ai21.jamba-1-5-large-v1:0   # Hybrid architecture, 256K context
AWS_BEDROCK_MODEL_ID=ai21.jamba-1-5-mini-v1:0    # Fast
```

#### Pricing (per 1M tokens)

| Model | Input | Output |
|-------|-------|--------|
| Claude 3.5 Sonnet | $3.00 | $15.00 |
| Claude 3 Opus | $15.00 | $75.00 |
| Claude 3 Haiku | $0.25 | $1.25 |
| Titan Text Express | $0.20 | $0.60 |
| Llama 3 70B | $0.99 | $0.99 |
| Nova Pro | $0.80 | $3.20 |

#### Important Notes

⚠️ **Tool Calling:** Only **Claude models** support tool calling on Bedrock. Other models work via Converse API but won't use Read/Write/Bash tools.

📖 **Full Documentation:** See [BEDROCK_MODELS.md](../BEDROCK_MODELS.md) for complete model catalog with capabilities and use cases.

---

### 2. Databricks (Claude Sonnet 4.5, Opus 4.5)

**Best for:** Enterprise production use, managed Claude endpoints

#### Configuration

```env
MODEL_PROVIDER=databricks
DATABRICKS_API_BASE=https://your-workspace.cloud.databricks.com
DATABRICKS_API_KEY=dapi1234567890abcdef
```

Optional endpoint path override:
```env
DATABRICKS_ENDPOINT_PATH=/serving-endpoints/databricks-claude-sonnet-4-5/invocations
```

#### Getting Databricks Credentials

1. Log in to your Databricks workspace
2. Navigate to **Settings** → **User Settings**
3. Click **Generate New Token**
4. Copy the token (this is your `DATABRICKS_API_KEY`)
5. Your workspace URL is the base URL (e.g., `https://your-workspace.cloud.databricks.com`)

#### Available Models

- **Claude Sonnet 4.5** - Excellent for tool calling, balanced performance
- **Claude Opus 4.5** - Most capable model for complex reasoning

#### Pricing

Contact Databricks for enterprise pricing.

---

### 3. OpenRouter (100+ Models)

**Best for:** Quick setup, model flexibility, cost optimization

#### Configuration

```env
MODEL_PROVIDER=openrouter
OPENROUTER_API_KEY=sk-or-v1-your-key
OPENROUTER_MODEL=anthropic/claude-3.5-sonnet
OPENROUTER_ENDPOINT=https://openrouter.ai/api/v1/chat/completions
```

Optional for hybrid routing:
```env
OPENROUTER_MAX_TOOLS_FOR_ROUTING=15  # Max tools to route to OpenRouter
```

#### Getting OpenRouter API Key

1. Visit [openrouter.ai](https://openrouter.ai)
2. Sign in with GitHub, Google, or email
3. Go to [openrouter.ai/keys](https://openrouter.ai/keys)
4. Create a new API key
5. Add credits (pay-as-you-go, no subscription required)

#### Popular Models

**Claude Models (Best for Coding)**
```env
OPENROUTER_MODEL=anthropic/claude-3.5-sonnet       # $3/$15 per 1M tokens
OPENROUTER_MODEL=anthropic/claude-opus-4.5         # $15/$75 per 1M tokens
OPENROUTER_MODEL=anthropic/claude-3-haiku          # $0.25/$1.25 per 1M tokens
```

**OpenAI Models**
```env
OPENROUTER_MODEL=openai/gpt-4o                     # $2.50/$10 per 1M tokens
OPENROUTER_MODEL=openai/gpt-4o-mini                # $0.15/$0.60 per 1M tokens (default)
OPENROUTER_MODEL=openai/o1-preview                 # $15/$60 per 1M tokens
OPENROUTER_MODEL=openai/o1-mini                    # $3/$12 per 1M tokens
```

**Google Models**
```env
OPENROUTER_MODEL=google/gemini-pro-1.5             # $1.25/$5 per 1M tokens
OPENROUTER_MODEL=google/gemini-flash-1.5           # $0.075/$0.30 per 1M tokens
```

**Meta Llama Models**
```env
OPENROUTER_MODEL=meta-llama/llama-3.1-405b         # $2.70/$2.70 per 1M tokens
OPENROUTER_MODEL=meta-llama/llama-3.1-70b          # $0.52/$0.75 per 1M tokens
OPENROUTER_MODEL=meta-llama/llama-3.1-8b           # $0.06/$0.06 per 1M tokens
```

**Mistral Models**
```env
OPENROUTER_MODEL=mistralai/mistral-large            # $2/$6 per 1M tokens
OPENROUTER_MODEL=mistralai/codestral-latest         # $0.30/$0.90 per 1M tokens
```

**DeepSeek Models**
```env
OPENROUTER_MODEL=deepseek/deepseek-chat             # $0.14/$0.28 per 1M tokens
OPENROUTER_MODEL=deepseek/deepseek-coder            # $0.14/$0.28 per 1M tokens
```

#### Benefits

- ✅ **100+ models** through one API
- ✅ **Automatic fallbacks** if primary model unavailable
- ✅ **Competitive pricing** with volume discounts
- ✅ **Full tool calling support**
- ✅ **No monthly fees** - pay only for usage
- ✅ **Rate limit pooling** across models

See [openrouter.ai/models](https://openrouter.ai/models) for complete list with pricing.

---

### 4. Ollama (Local Models)

**Best for:** Local development, privacy, offline use, no API costs

#### Configuration

```env
MODEL_PROVIDER=ollama
OLLAMA_ENDPOINT=http://localhost:11434  # Or any remote IP/hostname
OLLAMA_MODEL=llama3.1:8b
OLLAMA_TIMEOUT_MS=120000
```

> 🌐 **Remote Support**: `OLLAMA_ENDPOINT` can be any address - `http://192.168.1.100:11434`, `http://gpu-server:11434`, etc. See [Remote/Network Configuration](#remotenetwork-configuration).

#### Performance Optimization

**Prevent Cold Starts:** Ollama unloads models after 5 minutes of inactivity by default. This causes slow first requests (10-30+ seconds) while the model reloads. To keep models loaded:

**Option 1: Environment Variable (Recommended)**
```bash
# Set on Ollama server (not Lynkr)
# macOS
launchctl setenv OLLAMA_KEEP_ALIVE "24h"

# Linux (systemd) - edit with: sudo systemctl edit ollama
[Service]
Environment="OLLAMA_KEEP_ALIVE=24h"

# Docker
docker run -e OLLAMA_KEEP_ALIVE=24h -d ollama/ollama
```

**Option 2: Per-Request Keep Alive**
```bash
curl http://localhost:11434/api/generate -d '{"model":"llama3.1:8b","keep_alive":"24h"}'
```

**Keep Alive Values:**
| Value | Behavior |
|-------|----------|
| `5m` | Default - unload after 5 minutes |
| `24h` | Keep loaded for 24 hours |
| `-1` | Never unload (keep forever) |
| `0` | Unload immediately after request |

#### Installation & Setup

```bash
# Install Ollama
brew install ollama  # macOS
# Or download from: https://ollama.ai/download

# Start Ollama service
ollama serve

# Pull a model
ollama pull llama3.1:8b

# Verify model is available
ollama list
```

#### Recommended Models

**For Tool Calling** ✅ (Required for Claude Code CLI)
```bash
ollama pull llama3.1:8b          # Good balance (4.7GB)
ollama pull llama3.2             # Latest Llama (4.7GB)
ollama pull qwen2.5:14b          # Strong reasoning (8GB, 7b struggles with tools)
ollama pull mistral:7b-instruct  # Fast and capable (4.1GB)
```

**NOT Recommended for Tools** ❌
```bash
qwen2.5-coder    # Code-only, slow with tool calling
codellama        # Code-only, poor tool support
```

#### Tool Calling Support

Lynkr supports **native tool calling** for compatible Ollama models:

- ✅ **Supported models**: llama3.1, llama3.2, qwen2.5, mistral, mistral-nemo
- ✅ **Automatic detection**: Lynkr detects tool-capable models
- ✅ **Format conversion**: Transparent Anthropic ↔ Ollama conversion
- ❌ **Unsupported models**: llama3, older models (tools filtered automatically)

#### Pricing

**100% FREE** - Models run on your hardware with no API costs.

#### Model Sizes

- **7B models**: ~4-5GB download, 8GB RAM required
- **8B models**: ~4.7GB download, 8GB RAM required
- **14B models**: ~8GB download, 16GB RAM required
- **32B models**: ~18GB download, 32GB RAM required

---

### 5. llama.cpp (GGUF Models)

**Best for:** Maximum performance, custom quantization, any GGUF model

#### Configuration

```env
MODEL_PROVIDER=llamacpp
LLAMACPP_ENDPOINT=http://localhost:8080  # Or any remote IP/hostname
LLAMACPP_MODEL=qwen2.5-coder-7b
LLAMACPP_TIMEOUT_MS=120000
```

Optional API key (for secured servers):
```env
LLAMACPP_API_KEY=your-optional-api-key
```

> 🌐 **Remote Support**: `LLAMACPP_ENDPOINT` can be any address. See [Remote/Network Configuration](#remotenetwork-configuration).

#### Installation & Setup

```bash
# Clone and build llama.cpp
git clone https://github.com/ggerganov/llama.cpp
cd llama.cpp && make

# Download a GGUF model (example: Qwen2.5-Coder-7B)
wget https://huggingface.co/Qwen/Qwen2.5-Coder-7B-Instruct-GGUF/resolve/main/qwen2.5-coder-7b-instruct-q4_k_m.gguf

# Start llama-server
./llama-server -m qwen2.5-coder-7b-instruct-q4_k_m.gguf --port 8080

# Verify server is running
curl http://localhost:8080/health
```

#### GPU Support

llama.cpp supports multiple GPU backends:

- **CUDA** (NVIDIA): `make LLAMA_CUDA=1`
- **Metal** (Apple Silicon): `make LLAMA_METAL=1`
- **ROCm** (AMD): `make LLAMA_ROCM=1`
- **Vulkan** (Universal): `make LLAMA_VULKAN=1`

#### llama.cpp vs Ollama

| Feature | Ollama | llama.cpp |
|---------|--------|-----------|
| Setup | Easy (app) | Manual (compile/download) |
| Model Format | Ollama-specific | Any GGUF model |
| Performance | Good | **Excellent** (optimized C++) |
| GPU Support | Yes | Yes (CUDA, Metal, ROCm, Vulkan) |
| Memory Usage | Higher | **Lower** (quantization options) |
| API | Custom `/api/chat` | OpenAI-compatible `/v1/chat/completions` |
| Flexibility | Limited models | **Any GGUF** from HuggingFace |
| Tool Calling | Limited models | Grammar-based, more reliable |

**Choose llama.cpp when you need:**
- Maximum performance
- Specific quantization options (Q4, Q5, Q8)
- GGUF models not available in Ollama
- Fine-grained control over inference parameters

---

### 6. Azure OpenAI

**Best for:** Azure integration, Microsoft ecosystem, GPT-4o, o1, o3

#### Configuration

```env
MODEL_PROVIDER=azure-openai
AZURE_OPENAI_ENDPOINT=https://your-resource.openai.azure.com/openai/deployments/YOUR-DEPLOYMENT/chat/completions?api-version=2025-01-01-preview
AZURE_OPENAI_API_KEY=your-azure-api-key
AZURE_OPENAI_DEPLOYMENT=gpt-4o
```

Optional:
```env
AZURE_OPENAI_API_VERSION=2024-08-01-preview  # Latest stable version
```

#### Getting Azure OpenAI Credentials

1. Log in to [Azure Portal](https://portal.azure.com)
2. Navigate to **Azure OpenAI** service
3. Go to **Keys and Endpoint**
4. Copy **KEY 1** (this is your API key)
5. Copy **Endpoint** URL
6. Create a deployment (gpt-4o, gpt-4o-mini, etc.)

#### Important: Full Endpoint URL Required

The `AZURE_OPENAI_ENDPOINT` must include:
- Resource name
- Deployment path
- API version query parameter

**Example:**
```
https://your-resource.openai.azure.com/openai/deployments/gpt-4o/chat/completions?api-version=2025-01-01-preview
```

#### Available Deployments

You can deploy any of these models in Azure AI Foundry:

```env
AZURE_OPENAI_DEPLOYMENT=gpt-4o         # Latest GPT-4o
AZURE_OPENAI_DEPLOYMENT=gpt-4o-mini    # Smaller, faster, cheaper
AZURE_OPENAI_DEPLOYMENT=gpt-5-chat     # GPT-5 (if available)
AZURE_OPENAI_DEPLOYMENT=o1-preview     # Reasoning model
AZURE_OPENAI_DEPLOYMENT=o3-mini        # Latest reasoning model
AZURE_OPENAI_DEPLOYMENT=kimi-k2        # Kimi K2 (if available)
```

---

### 7. Azure Anthropic

**Best for:** Azure-hosted Claude models with enterprise integration

#### Configuration

```env
MODEL_PROVIDER=azure-anthropic
AZURE_ANTHROPIC_ENDPOINT=https://your-resource.services.ai.azure.com/anthropic/v1/messages
AZURE_ANTHROPIC_API_KEY=your-azure-api-key
AZURE_ANTHROPIC_VERSION=2023-06-01
```

#### Getting Azure Anthropic Credentials

1. Log in to [Azure Portal](https://portal.azure.com)
2. Navigate to your Azure Anthropic resource
3. Go to **Keys and Endpoint**
4. Copy the API key
5. Copy the endpoint URL (includes `/anthropic/v1/messages`)

#### Available Models

- **Claude Sonnet 4.5** - Best for tool calling, balanced
- **Claude Opus 4.5** - Most capable for complex reasoning

---

### 8. OpenAI (Direct)

**Best for:** Direct OpenAI API access, lowest latency

#### Configuration

```env
MODEL_PROVIDER=openai
OPENAI_API_KEY=sk-your-openai-api-key
OPENAI_MODEL=gpt-4o
OPENAI_ENDPOINT=https://api.openai.com/v1/chat/completions
```

Optional for organization-level keys:
```env
OPENAI_ORGANIZATION=org-your-org-id
```

#### Getting OpenAI API Key

1. Visit [platform.openai.com](https://platform.openai.com)
2. Sign up or log in
3. Go to [API Keys](https://platform.openai.com/api-keys)
4. Create a new API key
5. Add credits to your account (pay-as-you-go)

#### Available Models

```env
OPENAI_MODEL=gpt-4o           # Latest GPT-4o ($2.50/$10 per 1M)
OPENAI_MODEL=gpt-4o-mini      # Smaller, faster ($0.15/$0.60 per 1M)
OPENAI_MODEL=gpt-4-turbo      # GPT-4 Turbo
OPENAI_MODEL=o1-preview       # Reasoning model
OPENAI_MODEL=o1-mini          # Smaller reasoning model
```

#### Benefits

- ✅ **Direct API access** - No intermediaries, lowest latency
- ✅ **Full tool calling support** - Excellent function calling
- ✅ **Parallel tool calls** - Execute multiple tools simultaneously
- ✅ **Organization support** - Use org-level API keys
- ✅ **Simple setup** - Just one API key needed

---

### 9. LM Studio (Local with GUI)

**Best for:** Local models with graphical interface

#### Configuration

```env
MODEL_PROVIDER=lmstudio
LMSTUDIO_ENDPOINT=http://localhost:1234
LMSTUDIO_MODEL=default
LMSTUDIO_TIMEOUT_MS=120000
```

Optional API key (for secured servers):
```env
LMSTUDIO_API_KEY=your-optional-api-key
```

#### Setup

1. Download and install [LM Studio](https://lmstudio.ai)
2. Launch LM Studio
3. Download a model (e.g., Qwen2.5-Coder-7B, Llama 3.1)
4. Click **Start Server** (default port: 1234)
5. Configure Lynkr to use LM Studio

#### Benefits

- ✅ **Graphical interface** for model management
- ✅ **Easy model downloads** from HuggingFace
- ✅ **Built-in server** with OpenAI-compatible API
- ✅ **GPU acceleration** support
- ✅ **Model presets** and configurations

---

### 10. MLX OpenAI Server (Apple Silicon)

**Best for:** Maximum performance on Apple Silicon Macs (M1/M2/M3/M4)

[MLX OpenAI Server](https://github.com/cubist38/mlx-openai-server) is a high-performance local LLM server optimized for Apple's MLX framework. It provides OpenAI-compatible endpoints for text, vision, audio, and image generation models.

#### Installation

```bash
# Create virtual environment
python3.11 -m venv .venv
source .venv/bin/activate

# Install
pip install mlx-openai-server

# Optional: for audio transcription
brew install ffmpeg
```

#### Start the Server

```bash
# Text/Code models (recommended for coding)
mlx-openai-server launch --model-path mlx-community/Qwen2.5-Coder-7B-Instruct-4bit --model-type lm

# Smaller model (faster, less RAM)
mlx-openai-server launch --model-path mlx-community/Qwen2.5-Coder-1.5B-Instruct-4bit --model-type lm

# General purpose
mlx-openai-server launch --model-path mlx-community/Qwen2.5-3B-Instruct-4bit --model-type lm
```

Server runs at `http://localhost:8000/v1` by default.

#### Configuration

```env
MODEL_PROVIDER=openai
OPENAI_ENDPOINT=http://localhost:8000/v1/chat/completions
OPENAI_API_KEY=not-needed
```

> 🌐 **Remote Support**: `OPENAI_ENDPOINT` can be any address (e.g., `http://192.168.1.100:8000/v1/chat/completions` for a Mac Studio GPU server).

#### Recommended Models for Coding

| Model | Size | RAM | Command |
|-------|------|-----|---------|
| `Qwen2.5-Coder-1.5B-Instruct-4bit` | ~1GB | 4GB | Fast, simple code tasks |
| `Qwen2.5-3B-Instruct-4bit` | ~2GB | 6GB | General + code |
| `Qwen2.5-Coder-7B-Instruct-4bit` | ~4GB | 8GB | Best for coding |
| `Qwen2.5-Coder-14B-Instruct-4bit` | ~8GB | 16GB | Complex reasoning |
| `Llama-3.2-3B-Instruct-4bit` | ~2GB | 6GB | General purpose |
| `Phi-3-mini-4k-instruct-4bit` | ~2GB | 6GB | Reasoning tasks |

#### Server Options

```bash
mlx-openai-server launch \
  --model-path mlx-community/Qwen2.5-Coder-7B-Instruct-4bit \
  --model-type lm \
  --host 0.0.0.0 \           # Allow remote connections
  --port 8000 \              # Default port
  --max-concurrency 2 \      # Parallel requests
  --context-length 4096      # Max context window
```

#### MLX vs Ollama Comparison

| Feature | MLX OpenAI Server | Ollama |
|---------|-------------------|--------|
| Platform | Apple Silicon only | Cross-platform |
| Performance | Native MLX optimization | Good on Apple Silicon |
| Model Format | HuggingFace MLX | Ollama-specific |
| Vision/Audio | ✅ Built-in | Limited |
| Image Generation | ✅ Flux support | ❌ |
| Quantization | 4/8/16-bit flexible | Model-specific |

#### Test Connection

```bash
curl -X POST http://localhost:8000/v1/chat/completions -H "Content-Type: application/json" -d '{"model": "default", "messages": [{"role": "user", "content": "Hello"}]}'
```

#### Pricing

**100% FREE** - Models run locally on your Apple Silicon Mac.

---

## Tier-Based Routing & Fallback

### Intelligent 4-Tier Routing

Optimize costs by routing requests based on complexity:

```env
# Tier-based routing (set all 4 to enable)
TIER_SIMPLE=ollama:llama3.2
TIER_MEDIUM=openrouter:openai/gpt-4o-mini
TIER_COMPLEX=azure-openai:gpt-4o
TIER_REASONING=azure-openai:gpt-4o

FALLBACK_ENABLED=true

# Provider credentials
OLLAMA_ENDPOINT=http://localhost:11434
OPENROUTER_API_KEY=your-key
AZURE_OPENAI_ENDPOINT=https://your-resource.openai.azure.com/...
AZURE_OPENAI_API_KEY=your-key
```

### How It Works

**Routing Logic:**
1. Each request is scored for complexity (0-100)
2. Score maps to a tier: SIMPLE (0-25), MEDIUM (26-50), COMPLEX (51-75), REASONING (76-100)
3. The request is routed to the provider:model configured for that tier

**Automatic Fallback:**
- If the selected provider fails, Lynkr falls back to `FALLBACK_PROVIDER`
- Transparent to the user

### Cost Savings

- **65-100%** for requests routed to local/cheap models
- **40-87%** faster for simple requests
- **Privacy**: Simple queries can stay on your machine when using a local TIER_SIMPLE model

### Configuration Options

| Variable | Description | Default |
|----------|-------------|---------|
| `TIER_SIMPLE` | Model for simple tier (`provider:model`) | *required for tier routing* |
| `TIER_MEDIUM` | Model for medium tier (`provider:model`) | *required for tier routing* |
| `TIER_COMPLEX` | Model for complex tier (`provider:model`) | *required for tier routing* |
| `TIER_REASONING` | Model for reasoning tier (`provider:model`) | *required for tier routing* |
| `FALLBACK_ENABLED` | Enable automatic fallback | `true` |
| `FALLBACK_PROVIDER` | Provider to use when primary fails | `databricks` |
| `OLLAMA_MAX_TOOLS_FOR_ROUTING` | Max tools to route to Ollama | `3` |
| `OPENROUTER_MAX_TOOLS_FOR_ROUTING` | Max tools to route to OpenRouter | `15` |

**Note:** Local providers (ollama, llamacpp, lmstudio) cannot be used as `FALLBACK_PROVIDER`.

---

## Complete Configuration Reference

### Core Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `MODEL_PROVIDER` | Primary provider (`databricks`, `bedrock`, `openrouter`, `ollama`, `llamacpp`, `azure-openai`, `azure-anthropic`, `openai`, `lmstudio`) | `databricks` |
| `PORT` | HTTP port for proxy server | `8081` |
| `WORKSPACE_ROOT` | Workspace directory path | `process.cwd()` |
| `LOG_LEVEL` | Logging level (`error`, `warn`, `info`, `debug`) | `info` |
| `TOOL_EXECUTION_MODE` | Where tools execute (`server`, `client`) | `server` |
| `MODEL_DEFAULT` | Override default model/deployment name | Provider-specific |

### Provider-Specific Variables

See individual provider sections above for complete variable lists.

---

## Provider Comparison

### Feature Comparison

| Feature | Databricks | Bedrock | OpenAI | Azure OpenAI | Azure Anthropic | OpenRouter | Ollama | llama.cpp | LM Studio |
|---------|-----------|---------|--------|--------------|-----------------|------------|--------|-----------|-----------|
| **Setup Complexity** | Medium | Easy | Easy | Medium | Medium | Easy | Easy | Medium | Easy |
| **Cost** | $$$ | $-$$$ | $$ | $$ | $$$ | $-$$ | **Free** | **Free** | **Free** |
| **Latency** | Low | Low | Low | Low | Low | Medium | **Very Low** | **Very Low** | **Very Low** |
| **Model Variety** | 2 | **100+** | 10+ | 10+ | 2 | **100+** | 50+ | Unlimited | 50+ |
| **Tool Calling** | Excellent | Excellent* | Excellent | Excellent | Excellent | Good | Fair | Good | Fair |
| **Context Length** | 200K | Up to 300K | 128K | 128K | 200K | Varies | 32K-128K | Model-dependent | 32K-128K |
| **Streaming** | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes |
| **Privacy** | Enterprise | Enterprise | Third-party | Enterprise | Enterprise | Third-party | **Local** | **Local** | **Local** |
| **Offline** | No | No | No | No | No | No | **Yes** | **Yes** | **Yes** |

_* Tool calling only supported by Claude models on Bedrock_

### Cost Comparison (per 1M tokens)

| Provider | Model | Input | Output |
|----------|-------|-------|--------|
| **Bedrock** | Claude 3.5 Sonnet | $3.00 | $15.00 |
| **Databricks** | Contact for pricing | - | - |
| **OpenRouter** | Claude 3.5 Sonnet | $3.00 | $15.00 |
| **OpenRouter** | GPT-4o mini | $0.15 | $0.60 |
| **OpenAI** | GPT-4o | $2.50 | $10.00 |
| **Azure OpenAI** | GPT-4o | $2.50 | $10.00 |
| **Ollama** | Any model | **FREE** | **FREE** |
| **llama.cpp** | Any model | **FREE** | **FREE** |
| **LM Studio** | Any model | **FREE** | **FREE** |

---

## Next Steps

- **[Installation Guide](installation.md)** - Install Lynkr with your chosen provider
- **[Claude Code CLI Setup](claude-code-cli.md)** - Connect Claude Code CLI
- **[Cursor Integration](cursor-integration.md)** - Connect Cursor IDE
- **[Embeddings Configuration](embeddings.md)** - Enable @Codebase semantic search
- **[Troubleshooting](troubleshooting.md)** - Common issues and solutions

---

## Getting Help

- **[FAQ](faq.md)** - Frequently asked questions
- **[Troubleshooting Guide](troubleshooting.md)** - Common issues
- **[GitHub Discussions](https://github.com/vishalveerareddy123/Lynkr/discussions)** - Community Q&A
- **[GitHub Issues](https://github.com/vishalveerareddy123/Lynkr/issues)** - Report bugs
