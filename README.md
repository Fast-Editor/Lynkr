# Lynkr - Run Cursor, Cline, Continue, OpenAi Compatible Tools and Claude Code on any model.
## One universal LLM proxy for AI coding tools.

[![npm version](https://img.shields.io/npm/v/lynkr.svg)](https://www.npmjs.com/package/lynkr)
[![Homebrew Tap](https://img.shields.io/badge/homebrew-lynkr-brightgreen.svg)](https://github.com/vishalveerareddy123/homebrew-lynkr)
[![License: Apache 2.0](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)
[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/vishalveerareddy123/Lynkr)
[![Databricks Supported](https://img.shields.io/badge/Databricks-Supported-orange)](https://www.databricks.com/)
[![AWS Bedrock](https://img.shields.io/badge/AWS%20Bedrock-100%2B%20Models-FF9900)](https://aws.amazon.com/bedrock/)
[![OpenAI Compatible](https://img.shields.io/badge/OpenAI-Compatible-412991)](https://openai.com/)
[![Ollama Compatible](https://img.shields.io/badge/Ollama-Compatible-brightgreen)](https://ollama.ai/)
[![llama.cpp Compatible](https://img.shields.io/badge/llama.cpp-Compatible-blue)](https://github.com/ggerganov/llama.cpp)

### Use Case
```
        Cursor / Cline / Continue / Claude Code / Clawdbot / Codex/ KiloCode
                        ↓
                       Lynkr
                        ↓
        Local LLMs | OpenRouter | Azure | Databricks | AWS BedRock | Ollama | LMStudio | Gemini
```
---

## Overview

Lynkr is a **self-hosted proxy server** that unlocks Claude Code CLI , Cursor IDE and Codex Cli by enabling:

- 🚀 **Any LLM Provider** - Databricks, AWS Bedrock (100+ models), OpenRouter (100+ models), Ollama (local), llama.cpp, Azure OpenAI, Azure Anthropic, OpenAI, LM Studio
- 💰 **60-80% Cost Reduction** - Built-in token optimization with smart tool selection, prompt caching, and memory deduplication
- 🔒 **100% Local/Private** - Run completely offline with Ollama or llama.cpp
- 🌐 **Remote or Local** - Connect to providers on any IP/hostname (not limited to localhost)
- 🎯 **Zero Code Changes** - Drop-in replacement for Anthropic's backend
- 🏢 **Enterprise-Ready** - Circuit breakers, load shedding, Prometheus metrics, health checks

**Perfect for:**
- Developers who want provider flexibility and cost control
- Enterprises needing self-hosted AI with observability
- Privacy-focused teams requiring local model execution
- Teams seeking 60-80% cost reduction through optimization

---

## Quick Start

### Installation

**Option 1: NPM Package (Recommended)**
```bash
# Install globally
npm install -g pino-pretty 
npm install -g lynkr

lynk start
```

**Option 2: Git Clone**
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

**Node.js Compatibility:**
- **Node 20-24**: Full support with all features
- **Node 25+**: Full support (native modules auto-rebuild, babel fallback for code parsing)



**Option 3: Docker**
```bash
docker-compose up -d
```

---

## Supported Providers

Lynkr supports **10+ LLM providers**:

| Provider | Type | Models | Cost | Privacy |
|----------|------|--------|------|---------|
| **AWS Bedrock** | Cloud | 100+ (Claude, Titan, Llama, Mistral, etc.) | $$-$$$ | Cloud |
| **Databricks** | Cloud | Claude Sonnet 4.5, Opus 4.5 | $$$ | Cloud |
| **OpenRouter** | Cloud | 100+ (GPT, Claude, Llama, Gemini, etc.) | $-$$ | Cloud |
| **Ollama** | Local | Unlimited (free, offline) | **FREE** | 🔒 100% Local |
| **llama.cpp** | Local | GGUF models | **FREE** | 🔒 100% Local |
| **Azure OpenAI** | Cloud | GPT-4o, GPT-5, o1, o3 | $$$ | Cloud |
| **Azure Anthropic** | Cloud | Claude models | $$$ | Cloud |
| **OpenAI** | Cloud | GPT-4o, o1, o3 | $$$ | Cloud |
| **LM Studio** | Local | Local models with GUI | **FREE** | 🔒 100% Local |
| **MLX OpenAI Server** | Local | Apple Silicon (M1/M2/M3/M4) | **FREE** | 🔒 100% Local |

📖 **[Full Provider Configuration Guide](documentation/providers.md)**

---

## Claude Code Integration

Configure Claude Code CLI to use Lynkr:

```bash
# Set Lynkr as backend
export ANTHROPIC_BASE_URL=http://localhost:8081
export ANTHROPIC_API_KEY=dummy

# Run Claude Code
claude "Your prompt here"
```

That's it! Claude Code now uses your configured provider.

📖 **[Detailed Claude Code Setup](documentation/claude-code-cli.md)**

---

## Cursor Integration

Configure Cursor IDE to use Lynkr:

1. **Open Cursor Settings**
   - Mac: `Cmd+,` | Windows/Linux: `Ctrl+,`
   - Navigate to: **Features** → **Models**

2. **Configure OpenAI API Settings**
   - **API Key**: `sk-lynkr` (any non-empty value)
   - **Base URL**: `http://localhost:8081/v1`
   - **Model**: `claude-3.5-sonnet` (or your provider's model)

3. **Test It**
   - Chat: `Cmd+L` / `Ctrl+L`
   - Inline edits: `Cmd+K` / `Ctrl+K`
   - @Codebase search: Requires [embeddings setup](documentation/embeddings.md)

📖 **[Full Cursor Setup Guide](documentation/cursor-integration.md)** | **[Embeddings Configuration](documentation/embeddings.md)**
---
## Codex CLI Integration

Configure [OpenAI Codex CLI](https://github.com/openai/codex) to use Lynkr as its backend.

### Option 1: Environment Variables (Quick Start)

```bash
export OPENAI_BASE_URL=http://localhost:8081/v1
export OPENAI_API_KEY=dummy

codex
```

### Option 2: Config File (Recommended)

Edit `~/.codex/config.toml`:

```toml
# Set Lynkr as the default provider
model_provider = "lynkr"
model = "gpt-4o"

# Define the Lynkr provider
[model_providers.lynkr]
name = "Lynkr Proxy"
base_url = "http://localhost:8081/v1"
wire_api = "responses"

# Optional: Trust your project directories
[projects."/path/to/your/project"]
trust_level = "trusted"
```

### Configuration Options

| Option | Description | Example |
|--------|-------------|---------|
| `model_provider` | Active provider name | `"lynkr"` |
| `model` | Model to request (mapped by Lynkr) | `"gpt-4o"`, `"claude-sonnet-4-5"` |
| `base_url` | Lynkr endpoint | `"http://localhost:8081/v1"` |
| `wire_api` | API format (`responses` or `chat`) | `"responses"` |
| `trust_level` | Project trust (`trusted`, `sandboxed`) | `"trusted"` |

### Remote Lynkr Server

To connect Codex to a remote Lynkr instance:

```toml
[model_providers.lynkr-remote]
name = "Remote Lynkr"
base_url = "http://192.168.1.100:8081/v1"
wire_api = "responses"
```

### Troubleshooting

| Issue | Solution |
|-------|----------|
| Same response for all queries | Disable semantic cache: `SEMANTIC_CACHE_ENABLED=false` |
| Tool calls not executing | Increase threshold: `POLICY_TOOL_LOOP_THRESHOLD=15` |
| Slow first request | Keep Ollama loaded: `OLLAMA_KEEP_ALIVE=24h` |
| Connection refused | Ensure Lynkr is running: `npm start` |

> **Note:** Codex uses the OpenAI Responses API format. Lynkr automatically converts this to your configured provider's format.

---

## ClawdBot Integration

Lynkr supports [ClawdBot](https://github.com/openclaw/openclaw) via its OpenAI-compatible API. ClawdBot users can route requests through Lynkr to access any supported provider.

**Configuration in ClawdBot:**
| Setting | Value |
|---------|-------|
| Model/auth provider | `Copilot` |
| Copilot auth method | `Copilot Proxy (local)` |
| Copilot Proxy base URL | `http://localhost:8081/v1` |
| Model IDs | Any model your Lynkr provider supports |

**Available models** (depending on your Lynkr provider):
`gpt-5.2`, `gpt-5.1-codex`, `claude-opus-4.5`, `claude-sonnet-4.5`, `claude-haiku-4.5`, `gemini-3-pro`, `gemini-3-flash`, and more.

> 🌐 **Remote Support**: ClawdBot can connect to Lynkr on any machine - use any IP/hostname in the Proxy base URL (e.g., `http://192.168.1.100:8081/v1` or `http://gpu-server:8081/v1`).

---

## Lynkr also supports  Cline, Continue.dev and other OpenAI compatible tools.
---

## Documentation

### Getting Started
- 📦 **[Installation Guide](documentation/installation.md)** - Detailed installation for all methods
- ⚙️ **[Provider Configuration](documentation/providers.md)** - Complete setup for all 9+ providers
- 🎯 **[Quick Start Examples](documentation/installation.md#quick-start-examples)** - Copy-paste configs

### IDE & CLI Integration
- 🖥️ **[Claude Code CLI Setup](documentation/claude-code-cli.md)** - Connect Claude Code CLI
- 🤖 **[Codex CLI Setup](documentation/codex-cli.md)** - Configure OpenAI Codex CLI with config.toml
- 🎨 **[Cursor IDE Setup](documentation/cursor-integration.md)** - Full Cursor integration with troubleshooting
- 🔍 **[Embeddings Guide](documentation/embeddings.md)** - Enable @Codebase semantic search (4 options: Ollama, llama.cpp, OpenRouter, OpenAI)

### Features & Capabilities
- ✨ **[Core Features](documentation/features.md)** - Architecture, request flow, format conversion
- 🧠 **[Memory System](documentation/memory-system.md)** - Titans-inspired long-term memory
- 🗃️ **[Semantic Cache](#semantic-cache)** - Cache responses for similar prompts
- 💰 **[Token Optimization](documentation/token-optimization.md)** - 60-80% cost reduction strategies
- 🔧 **[Tools & Execution](documentation/tools.md)** - Tool calling, execution modes, custom tools

### Deployment & Operations
- 🐳 **[Docker Deployment](documentation/docker.md)** - docker-compose setup with GPU support
- 🏭 **[Production Hardening](documentation/production.md)** - Circuit breakers, load shedding, metrics
- 📊 **[API Reference](documentation/api.md)** - All endpoints and formats

### Support
- 🔧 **[Troubleshooting](documentation/troubleshooting.md)** - Common issues and solutions
- ❓ **[FAQ](documentation/faq.md)** - Frequently asked questions
- 🧪 **[Testing Guide](documentation/testing.md)** - Running tests and validation

---

## External Resources

- 📚 **[DeepWiki Documentation](https://deepwiki.com/vishalveerareddy123/Lynkr)** - AI-powered documentation search
- 💬 **[GitHub Discussions](https://github.com/vishalveerareddy123/Lynkr/discussions)** - Community Q&A
- 🐛 **[Report Issues](https://github.com/vishalveerareddy123/Lynkr/issues)** - Bug reports and feature requests
- 📦 **[NPM Package](https://www.npmjs.com/package/lynkr)** - Official npm package

---

## Key Features Highlights

- ✅ **Multi-Provider Support** - 9+ providers including local (Ollama, llama.cpp) and cloud (Bedrock, Databricks, OpenRouter)
- ✅ **60-80% Cost Reduction** - Token optimization with smart tool selection, prompt caching, memory deduplication
- ✅ **100% Local Option** - Run completely offline with Ollama/llama.cpp (zero cloud dependencies)
- ✅ **OpenAI Compatible** - Works with Cursor IDE, Continue.dev, and any OpenAI-compatible client
- ✅ **Embeddings Support** - 4 options for @Codebase search: Ollama (local), llama.cpp (local), OpenRouter, OpenAI
- ✅ **MCP Integration** - Automatic Model Context Protocol server discovery and orchestration
- ✅ **Enterprise Features** - Circuit breakers, load shedding, Prometheus metrics, K8s health checks
- ✅ **Streaming Support** - Real-time token streaming for all providers
- ✅ **Memory System** - Titans-inspired long-term memory with surprise-based filtering
- ✅ **Tool Calling** - Full tool support with server and passthrough execution modes
- ✅ **Production Ready** - Battle-tested with 400+ tests, observability, and error resilience
- ✅ **Node 20-25 Support** - Works with latest Node.js versions including v25
- ✅ **Semantic Caching** - Cache responses for similar prompts (requires embeddings)

---

## Semantic Cache

Lynkr includes an optional semantic response cache that returns cached responses for semantically similar prompts, reducing latency and costs.

**Enable Semantic Cache:**
```bash
# Requires an embeddings provider (Ollama recommended)
ollama pull nomic-embed-text

# Add to .env
SEMANTIC_CACHE_ENABLED=true
SEMANTIC_CACHE_THRESHOLD=0.95
OLLAMA_EMBEDDINGS_MODEL=nomic-embed-text
OLLAMA_EMBEDDINGS_ENDPOINT=http://localhost:11434/api/embeddings
```

| Setting | Default | Description |
|---------|---------|-------------|
| `SEMANTIC_CACHE_ENABLED` | `false` | Enable/disable semantic caching |
| `SEMANTIC_CACHE_THRESHOLD` | `0.95` | Similarity threshold (0.0-1.0) |

> **Note:** Without a proper embeddings provider, the cache uses hash-based fallback which may cause false matches. Use Ollama with `nomic-embed-text` for best results.

---

## Architecture

```
┌─────────────────┐
│    AI Tools     │  
└────────┬────────┘
         │ Anthropic/OpenAI Format
         ↓
┌─────────────────┐
│  Lynkr Proxy    │
│  Port: 8081     │
│                 │
│ • Format Conv.  │
│ • Token Optim.  │
│ • Provider Route│
│ • Tool Calling  │
│ • Caching       │
└────────┬────────┘
         │
         ├──→ Databricks (Claude 4.5)
         ├──→ AWS Bedrock (100+ models)
         ├──→ OpenRouter (100+ models)
         ├──→ Ollama (local, free)
         ├──→ llama.cpp (local, free)
         ├──→ Azure OpenAI (GPT-4o, o1)
         ├──→ OpenAI (GPT-4o, o3)
         └──→ Azure Anthropic (Claude)
```

📖 **[Detailed Architecture](documentation/features.md#architecture)**

---

## Quick Configuration Examples

**100% Local (FREE)**
```bash
export MODEL_PROVIDER=ollama
export OLLAMA_MODEL=qwen2.5-coder:latest
export OLLAMA_EMBEDDINGS_MODEL=nomic-embed-text
npm start
```
> 💡 **Tip:** Prevent slow cold starts by keeping Ollama models loaded: `launchctl setenv OLLAMA_KEEP_ALIVE "24h"` (macOS) or set `OLLAMA_KEEP_ALIVE=24h` env var. See [troubleshooting](documentation/troubleshooting.md#slow-first-request--cold-start-warning).

**Remote Ollama (GPU Server)**
```bash
export MODEL_PROVIDER=ollama
export OLLAMA_ENDPOINT=http://192.168.1.100:11434  # Any IP or hostname
export OLLAMA_MODEL=llama3.1:70b
npm start
```
> 🌐 **Note:** All provider endpoints support remote addresses - not limited to localhost. Use any IP, hostname, or domain.

**MLX OpenAI Server (Apple Silicon)**
```bash
# Terminal 1: Start MLX server
mlx-openai-server launch --model-path mlx-community/Qwen2.5-Coder-7B-Instruct-4bit --model-type lm

# Terminal 2: Start Lynkr
export MODEL_PROVIDER=openai
export OPENAI_ENDPOINT=http://localhost:8000/v1/chat/completions
export OPENAI_API_KEY=not-needed
npm start
```
> 🍎 **Apple Silicon optimized** - Native MLX performance on M1/M2/M3/M4 Macs. See [MLX setup guide](documentation/providers.md#10-mlx-openai-server-apple-silicon).

**AWS Bedrock (100+ models)**
```bash
export MODEL_PROVIDER=bedrock
export AWS_BEDROCK_API_KEY=your-key
export AWS_BEDROCK_MODEL_ID=anthropic.claude-3-5-sonnet-20241022-v2:0
npm start
```

**OpenRouter (simplest cloud)**
```bash
export MODEL_PROVIDER=openrouter
export OPENROUTER_API_KEY=sk-or-v1-your-key
npm start
```
** You can setup multiple models like local models
📖 **[More Examples](documentation/providers.md#quick-start-examples)**

---

## Contributing

We welcome contributions! Please see:
- **[Contributing Guide](documentation/contributing.md)** - How to contribute
- **[Testing Guide](documentation/testing.md)** - Running tests

---

## License

Apache 2.0 - See [LICENSE](LICENSE) file for details.

---

## Community & Support

- ⭐ **Star this repo** if Lynkr helps you!
- 💬 **[Join Discussions](https://github.com/vishalveerareddy123/Lynkr/discussions)** - Ask questions, share tips
- 🐛 **[Report Issues](https://github.com/vishalveerareddy123/Lynkr/issues)** - Bug reports welcome
- 📖 **[Read the Docs](documentation/)** - Comprehensive guides

---

**Made with ❤️ by developers, for developers.**
