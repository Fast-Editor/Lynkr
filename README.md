# Lynkr

### Run Claude Code, Cursor, and Codex on any model. One proxy, every provider.

[![npm version](https://img.shields.io/npm/v/lynkr.svg)](https://www.npmjs.com/package/lynkr)
[![Tests](https://img.shields.io/badge/tests-699%20passing-brightgreen)](https://github.com/Fast-Editor/Lynkr)
[![License: Apache 2.0](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-20%2B-green)](https://nodejs.org)
[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/vishalveerareddy123/Lynkr)

<table>
<tr>
<td align="center"><strong>12+</strong><br/>LLM Providers</td>
<td align="center"><strong>60-80%</strong><br/>Cost Reduction</td>
<td align="center"><strong>699</strong><br/>Tests Passing</td>
<td align="center"><strong>0</strong><br/>Code Changes Required</td>
</tr>
</table>

---

## Quick Start (2 Minutes)

### 1. Install Lynkr

```bash
npm install -g lynkr
```

### 2. Configure Lynkr

First run creates a `.env` file. Edit it with your provider settings.

**Option A: Free & Local (Ollama) - Recommended for Testing**

```bash
# Install Ollama first: https://ollama.com
ollama pull qwen2.5-coder:latest
```

Create/edit `.env` in your project directory:
```bash
# Provider
MODEL_PROVIDER=ollama
FALLBACK_ENABLED=false

# Ollama Configuration
OLLAMA_ENDPOINT=http://localhost:11434
OLLAMA_MODEL=qwen2.5-coder:latest

# Server
PORT=8081

# Increase limits for Claude Code/Cursor
POLICY_MAX_STEPS=50
POLICY_MAX_TOOL_CALLS=100

# Disable overly strict command filtering
POLICY_SAFE_COMMANDS_ENABLED=false
```

**Option B: Cloud (OpenRouter) - Recommended for Production**

```bash
# Get API key from https://openrouter.ai
```

Create/edit `.env`:
```bash
# Provider
MODEL_PROVIDER=openrouter
OPENROUTER_API_KEY=sk-or-v1-your-key-here
FALLBACK_ENABLED=false

# Server
PORT=8081

# Increase limits
POLICY_MAX_STEPS=50
POLICY_MAX_TOOL_CALLS=100

# Optional: Enable caching
PROMPT_CACHE_ENABLED=true
SEMANTIC_CACHE_ENABLED=true
```

**Option C: Enterprise (AWS Bedrock)**

Create/edit `.env`:
```bash
# Provider
MODEL_PROVIDER=bedrock
AWS_BEDROCK_API_KEY=your-aws-key
AWS_BEDROCK_MODEL_ID=anthropic.claude-3-5-sonnet-20241022-v2:0
FALLBACK_ENABLED=false

# Server
PORT=8081

# Increase limits
POLICY_MAX_STEPS=50
POLICY_MAX_TOOL_CALLS=100
```

**Option D: Enterprise (Databricks)**

Create/edit `.env`:
```bash
# Provider
MODEL_PROVIDER=databricks
DATABRICKS_API_BASE=https://your-workspace.cloud.databricks.com
DATABRICKS_API_KEY=your-token
FALLBACK_ENABLED=false

# Server
PORT=8081

# Increase limits
POLICY_MAX_STEPS=50
POLICY_MAX_TOOL_CALLS=100
```

Then start Lynkr:
```bash
lynkr start
```

### 3. Connect Your Tool

**Claude Code**
```bash
export ANTHROPIC_BASE_URL=http://localhost:8081
export ANTHROPIC_API_KEY=dummy
claude "write a hello world in python"
```

**Cursor IDE**
- Settings → Models → Override Base URL
- Set to: `http://localhost:8081/v1`
- API Key: `any-value`

**Codex CLI**

Edit `~/.codex/config.toml`:
```toml
model_provider = "lynkr"

[model_providers.lynkr]
base_url = "http://localhost:8081/v1"
wire_api = "responses"
```

✅ **Done!** Your AI tool now uses your chosen provider.

---

## Why Lynkr?

AI coding tools lock you into one provider. Lynkr breaks that lock.

```
Claude Code / Cursor / Codex / Cline / Continue
                    ↓
                  Lynkr
                    ↓
    Ollama | Bedrock | Azure | OpenRouter | OpenAI
```

**What you get:**
- ✅ Use **free local models** (Ollama, llama.cpp) with Claude Code
- ✅ Route through **your company's infrastructure** (Databricks, Azure, Bedrock)
- ✅ Cut costs **60-80%** with smart token optimization
- ✅ **Zero code changes** - just change one environment variable

---

## Supported Providers

| Provider | Type | Example Models | Cost |
|----------|------|---------------|------|
| **Ollama** | Local | qwen2.5-coder, deepseek-coder, llama3 | **Free** |
| **llama.cpp** | Local | Any GGUF model | **Free** |
| **LM Studio** | Local | Local models with GUI | **Free** |
| **OpenRouter** | Cloud | GPT-4o, Claude 3.5, Llama 3, Gemini | $ |
| **AWS Bedrock** | Cloud | Claude, Llama, Mistral, Titan | $$ |
| **Databricks** | Cloud | Claude Sonnet 4.5, Opus 4.6 | $$$ |
| **Azure OpenAI** | Cloud | GPT-4o, o1, o3 | $$$ |
| **Azure Anthropic** | Cloud | Claude Sonnet, Opus | $$$ |
| **OpenAI** | Cloud | GPT-4o, o3-mini | $$$ |
| **DeepSeek** | Cloud | DeepSeek R1, Reasoner | $ |

**4 local providers** for 100% offline, free usage. **10+ cloud providers** for scale.

---

## Advanced: Tier Routing (Save Even More)

Route different request types to different models automatically:

```bash
# .env file
MODEL_PROVIDER=ollama
FALLBACK_ENABLED=false

# Use small/fast models for simple tasks
TIER_SIMPLE=ollama:qwen2.5:3b

# Use medium models for normal coding
TIER_MEDIUM=ollama:qwen2.5:7b

# Use powerful models for complex architecture
TIER_COMPLEX=ollama:deepseek-r1:14b
TIER_REASONING=ollama:deepseek-r1:14b

# Increase limits for long conversations
POLICY_MAX_STEPS=50
POLICY_MAX_TOOL_CALLS=100
```

Lynkr analyzes each request and routes it to the appropriate tier. Simple questions use fast models. Complex refactoring uses powerful models.

**Result:** 70-90% of requests use cheaper/faster models. Only hard problems hit expensive models.

---

## Complete .env Examples

### MVP: Minimal Working Setup (Ollama)

Copy-paste ready configuration for immediate use:

```bash
# .env - Minimal Ollama Setup

# ============================================
# REQUIRED: Provider Configuration
# ============================================
MODEL_PROVIDER=ollama
FALLBACK_ENABLED=false

# ============================================
# REQUIRED: Ollama Settings
# ============================================
OLLAMA_ENDPOINT=http://localhost:11434
OLLAMA_MODEL=qwen2.5-coder:latest

# ============================================
# REQUIRED: Server Configuration
# ============================================
PORT=8081
HOST=0.0.0.0

# ============================================
# REQUIRED: Claude Code/Cursor Compatibility
# ============================================
POLICY_MAX_STEPS=50
POLICY_MAX_TOOL_CALLS=100
POLICY_SAFE_COMMANDS_ENABLED=false

# ============================================
# OPTIONAL: Performance (Recommended)
# ============================================
LOG_LEVEL=warn
LOAD_SHEDDING_ENABLED=true
LOAD_SHEDDING_HEAP_THRESHOLD=0.85
```

**Steps:**
1. Install Ollama: `curl -fsSL https://ollama.com/install.sh | sh`
2. Pull model: `ollama pull qwen2.5-coder:latest`
3. Copy above to `.env` in your project directory
4. Run: `lynkr start`

---

### Production: Cloud with Tier Routing (OpenRouter)

Optimized for cost savings with smart routing:

```bash
# .env - Production OpenRouter Setup

# ============================================
# REQUIRED: Provider Configuration
# ============================================
MODEL_PROVIDER=openrouter
OPENROUTER_API_KEY=sk-or-v1-your-key-here
FALLBACK_ENABLED=false

# ============================================
# REQUIRED: Server Configuration
# ============================================
PORT=8081
HOST=0.0.0.0

# ============================================
# TIER ROUTING: Smart Cost Optimization
# ============================================
# Simple queries → Cheap/fast model
TIER_SIMPLE=openrouter:google/gemini-flash-1.5

# Normal coding → Balanced model
TIER_MEDIUM=openrouter:anthropic/claude-3.5-sonnet

# Complex refactoring → Powerful model
TIER_COMPLEX=openrouter:anthropic/claude-opus-4

# Deep reasoning → Most capable model
TIER_REASONING=openrouter:anthropic/claude-opus-4

# ============================================
# REQUIRED: Claude Code/Cursor Compatibility
# ============================================
POLICY_MAX_STEPS=50
POLICY_MAX_TOOL_CALLS=100
POLICY_SAFE_COMMANDS_ENABLED=false

# ============================================
# OPTIONAL: Token Optimization (60-80% savings)
# ============================================
PROMPT_CACHE_ENABLED=true
SEMANTIC_CACHE_ENABLED=true
SEMANTIC_CACHE_THRESHOLD=0.95
TOOL_INJECTION_ENABLED=false

# ============================================
# OPTIONAL: Performance Tuning
# ============================================
LOG_LEVEL=warn
LOAD_SHEDDING_ENABLED=true
LOAD_SHEDDING_HEAP_THRESHOLD=0.85
```

**Expected savings:** 70-90% of requests use Gemini Flash ($). Only 10-30% use Claude Opus ($$$).

---

### Enterprise: Databricks Foundation Models

For teams using Databricks Model Serving:

```bash
# .env - Enterprise Databricks Setup

# ============================================
# REQUIRED: Provider Configuration
# ============================================
MODEL_PROVIDER=databricks
DATABRICKS_API_BASE=https://your-workspace.cloud.databricks.com
DATABRICKS_API_KEY=dapi1234567890abcdef
FALLBACK_ENABLED=false

# ============================================
# REQUIRED: Model Configuration
# ============================================
# Option 1: Single model (no tier routing)
DATABRICKS_MODEL=databricks-meta-llama-3-1-405b-instruct

# Option 2: Tier routing (comment out above, uncomment below)
# TIER_SIMPLE=databricks:databricks-meta-llama-3-1-70b-instruct
# TIER_MEDIUM=databricks:databricks-claude-sonnet-4-5
# TIER_COMPLEX=databricks:databricks-claude-opus-4-6
# TIER_REASONING=databricks:databricks-claude-opus-4-6

# ============================================
# REQUIRED: Server Configuration
# ============================================
PORT=8081
HOST=0.0.0.0

# ============================================
# REQUIRED: Claude Code/Cursor Compatibility
# ============================================
POLICY_MAX_STEPS=50
POLICY_MAX_TOOL_CALLS=100
POLICY_SAFE_COMMANDS_ENABLED=false

# ============================================
# OPTIONAL: Enterprise Features
# ============================================
LOG_LEVEL=info
LOAD_SHEDDING_ENABLED=true
LOAD_SHEDDING_HEAP_THRESHOLD=0.85

# Optional: Metrics for monitoring
# PROMETHEUS_METRICS_ENABLED=true
```

---

### Hybrid: Local + Cloud Fallback

Use free Ollama, fallback to cloud when needed:

```bash
# .env - Hybrid Setup (Advanced)

# ============================================
# PRIMARY: Local Ollama
# ============================================
MODEL_PROVIDER=ollama
OLLAMA_ENDPOINT=http://localhost:11434
OLLAMA_MODEL=qwen2.5-coder:latest

# ============================================
# FALLBACK: Cloud Provider
# ============================================
FALLBACK_ENABLED=true
FALLBACK_PROVIDER=openrouter
OPENROUTER_API_KEY=sk-or-v1-your-key-here

# ============================================
# TIER ROUTING: Mix Local + Cloud
# ============================================
TIER_SIMPLE=ollama:qwen2.5:3b
TIER_MEDIUM=ollama:qwen2.5:7b
TIER_COMPLEX=openrouter:anthropic/claude-3.5-sonnet
TIER_REASONING=openrouter:anthropic/claude-opus-4

# ============================================
# REQUIRED: Server Configuration
# ============================================
PORT=8081
HOST=0.0.0.0

# ============================================
# REQUIRED: Claude Code/Cursor Compatibility
# ============================================
POLICY_MAX_STEPS=50
POLICY_MAX_TOOL_CALLS=100
POLICY_SAFE_COMMANDS_ENABLED=false

# ============================================
# OPTIONAL: Performance
# ============================================
LOG_LEVEL=warn
LOAD_SHEDDING_ENABLED=true
```

**Best of both worlds:** 80% of requests stay local (free). Complex tasks use cloud (paid).

---

## Common Issues & Fixes

| Issue | Solution |
|-------|----------|
| **"Service temporarily overloaded"** | Ollama model too large for RAM. Use smaller model or increase `--max-old-space-size` |
| **"Route not found: HEAD /"** | Ignore - harmless health check from Claude Code |
| **"Hallucinated tool calls"** | Normal - Lynkr automatically filters invalid tools |
| **"Safe Command DSL blocked"** | Add `POLICY_SAFE_COMMANDS_ENABLED=false` to `.env` |
| **Slow first request (20+ sec)** | Ollama loading model into memory. Add `OLLAMA_KEEP_ALIVE=30m` in Ollama config |
| **No response after N turns** | Increase limits: `POLICY_MAX_STEPS=50` and `POLICY_MAX_TOOL_CALLS=100` |

---

## Advanced Features

### Token Optimization (60-80% savings)
```bash
# Enable all optimizations
PROMPT_CACHE_ENABLED=true
SEMANTIC_CACHE_ENABLED=true
TOOL_INJECTION_ENABLED=false
CODE_MODE_ENABLED=true
```

### Memory System (Titans-inspired)
```bash
MEMORY_ENABLED=true
MEMORY_TTL=3600000  # 1 hour
```

### Load Shedding & Resilience
```bash
LOAD_SHEDDING_ENABLED=true
LOAD_SHEDDING_HEAP_THRESHOLD=0.85
```

### Admin Hot-Reload (no restart needed)
```bash
curl -X POST http://localhost:8081/v1/admin/reload
```

---

## Installation Methods

**NPM (recommended)**
```bash
npm install -g lynkr
```

**One-line installer**
```bash
curl -fsSL https://raw.githubusercontent.com/Fast-Editor/Lynkr/main/install.sh | bash
```

**Homebrew**
```bash
brew tap vishalveerareddy123/lynkr
brew install lynkr
```

**Docker**
```bash
git clone https://github.com/Fast-Editor/Lynkr.git
cd Lynkr
docker-compose up -d
```

**From source**
```bash
git clone https://github.com/Fast-Editor/Lynkr.git
cd Lynkr
npm install
cp .env.example .env
npm start
```

---

## Documentation

| Guide | Description |
|-------|-------------|
| [Installation](documentation/installation.md) | All installation methods |
| [Provider Setup](documentation/providers.md) | Configuration for all 12+ providers |
| [Claude Code](documentation/claude-code-cli.md) | Claude Code CLI integration |
| [Cursor IDE](documentation/cursor-integration.md) | Cursor setup + troubleshooting |
| [Codex CLI](documentation/codex-cli.md) | Codex configuration |
| [Tier Routing](documentation/routing.md) | Smart model routing by complexity |
| [Token Optimization](documentation/token-optimization.md) | 60-80% cost reduction |
| [Troubleshooting](documentation/troubleshooting.md) | Common issues and solutions |
| [API Reference](documentation/api.md) | REST API endpoints |
| [Production](documentation/production.md) | Enterprise deployment |

---

## Cost Comparison

| Scenario | Direct Anthropic | Lynkr + Ollama | Lynkr + OpenRouter |
|----------|-----------------|----------------|-------------------|
| Daily coding (8h) | $10-30/day | **$0 (free)** | $2-8/day |
| Monthly (heavy use) | $300-900 | **$0** | $60-240 |

With tier routing + token optimization: **additional 60-80% savings** on cloud providers.

---

## Why Lynkr vs Alternatives

| Feature | Lynkr | LiteLLM | OpenRouter | PortKey |
|---------|-------|---------|-----------|---------|
| **Setup** | `npm install -g lynkr` | Python + Docker + Postgres | Account signup | Docker stack |
| **Claude Code native** | ✅ Drop-in | ⚠️ Requires config | ❌ | ⚠️ Partial |
| **Cursor native** | ✅ Drop-in | ⚠️ Partial | ❌ | ⚠️ Partial |
| **Local models** | Ollama, llama.cpp, LM Studio, MLX | Ollama only | ❌ | ❌ |
| **Tier routing** | Auto complexity-based | ❌ Manual | Cost-based only | ❌ Manual |
| **Token optimization** | 60-80% built-in | ❌ | ❌ | Cache only |
| **Self-hosted** | ✅ Node.js only | ✅ Python stack | ❌ SaaS | ✅ Docker |
| **Dependencies** | Node.js 20+ | Python, Prisma, PostgreSQL | None | Docker, Python |

**Lynkr's edge:** Purpose-built for AI coding tools. Zero-config for Claude Code, Cursor, and Codex. Installs in one command, runs anywhere Node.js runs.

---

## Community

- [GitHub Discussions](https://github.com/Fast-Editor/Lynkr/discussions) — Ask questions
- [Report Issues](https://github.com/Fast-Editor/Lynkr/issues) — Bug reports
- [NPM Package](https://www.npmjs.com/package/lynkr) — Official releases
- [DeepWiki](https://deepwiki.com/vishalveerareddy123/Lynkr) — AI-powered docs

---

## License

Apache 2.0 — See [LICENSE](LICENSE).

---

**Built by [Vishal Veera Reddy](https://github.com/vishalveerareddy123) for developers who want control over their AI tools.**
