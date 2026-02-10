# Codex CLI Integration

This guide explains how to configure [OpenAI Codex CLI](https://github.com/openai/codex) to use Lynkr as its backend, enabling you to use any LLM provider (Ollama, Azure OpenAI, Bedrock, Databricks, etc.) with Codex.

---

## Overview

Codex CLI is OpenAI's terminal-based AI coding assistant. By routing it through Lynkr, you can:

- Use **local models** (Ollama, llama.cpp, LM Studio) for free, private coding assistance
- Access **enterprise providers** (Azure OpenAI, Databricks, AWS Bedrock)
- Benefit from Lynkr's **token optimization** and **caching** features
- Switch between providers without changing Codex configuration

---

## Quick Start

### Option 1: Environment Variables

The fastest way to get started:

```bash
# Set Lynkr as the OpenAI endpoint
export OPENAI_BASE_URL=http://localhost:8081/v1
export OPENAI_API_KEY=dummy

# Start Lynkr (in another terminal)
cd /path/to/lynkr && npm start

# Run Codex
codex
```

### Option 2: Config File (Recommended)

For persistent configuration, edit `~/.codex/config.toml`:

```toml
# Set Lynkr as the default provider
model_provider = "lynkr"
model = "gpt-4o"

# Define the Lynkr provider
[model_providers.lynkr]
name = "Lynkr Proxy"
base_url = "http://localhost:8081/v1"
wire_api = "responses"

# Optional: Trust your project directories for tool execution
[projects."/path/to/your/project"]
trust_level = "trusted"
```

---

## Complete Configuration Reference

### Full config.toml Example

```toml
# =============================================================================
# Codex CLI Configuration for Lynkr
# Location: ~/.codex/config.toml
# =============================================================================

# Active provider (must match a key in [model_providers])
model_provider = "lynkr"

# Model to request (Lynkr maps this to your configured provider)
model = "gpt-4o"

# Personality affects response style: default, pragmatic, concise, educational
personality = "pragmatic"

# =============================================================================
# Lynkr Provider Definition
# =============================================================================

[model_providers.lynkr]
name = "Lynkr Proxy"
base_url = "http://localhost:8081/v1"
wire_api = "responses"

# Alternative: Use chat completions API instead of responses API
# wire_api = "chat"

# =============================================================================
# Remote Lynkr Server (Optional)
# =============================================================================

[model_providers.lynkr-remote]
name = "Remote Lynkr (GPU Server)"
base_url = "http://192.168.1.100:8081/v1"
wire_api = "responses"

# =============================================================================
# Project Trust Levels
# =============================================================================
# trusted    - Full tool execution allowed
# sandboxed  - Restricted tool execution
# untrusted  - No tool execution (default for new projects)

[projects."/Users/yourname/work"]
trust_level = "trusted"

[projects."/Users/yourname/personal"]
trust_level = "trusted"

# =============================================================================
# Agent Configuration (Optional)
# =============================================================================

[agent]
enabled = true

# =============================================================================
# Skills Configuration (Optional)
# =============================================================================

[skills]
enabled = true
```

---

## Configuration Options

### Provider Options

| Option | Description | Values |
|--------|-------------|--------|
| `model_provider` | Active provider name | `"lynkr"`, `"openai"`, etc. |
| `model` | Model to request | `"gpt-4o"`, `"claude-sonnet-4-5"`, etc. |
| `personality` | Response style | `"default"`, `"pragmatic"`, `"concise"`, `"educational"` |

### Model Provider Options

| Option | Description | Example |
|--------|-------------|---------|
| `name` | Display name | `"Lynkr Proxy"` |
| `base_url` | API endpoint URL | `"http://localhost:8081/v1"` |
| `wire_api` | API format | `"responses"` (recommended) or `"chat"` |
| `env_key` | Environment variable for API key | `"OPENAI_API_KEY"` |

### Project Options

| Option | Description | Values |
|--------|-------------|--------|
| `trust_level` | Tool execution permissions | `"trusted"`, `"sandboxed"`, `"untrusted"` |

---

## Wire API Formats

Codex supports two API formats:

### Responses API (Recommended)

```toml
wire_api = "responses"
```

- Uses OpenAI's newer Responses API format
- Better support for multi-turn conversations
- Recommended for Lynkr integration

### Chat Completions API

```toml
wire_api = "chat"
```

- Uses standard OpenAI Chat Completions format
- Broader compatibility with proxies
- Use if you encounter issues with `responses`

---

## Remote Server Configuration

Connect Codex to a Lynkr instance running on another machine:

### On the Remote Server

```bash
# Edit .env to allow remote connections
PORT=8081

# Start Lynkr
npm start
```

### On Your Local Machine

```toml
# ~/.codex/config.toml
model_provider = "lynkr-remote"

[model_providers.lynkr-remote]
name = "Remote Lynkr"
base_url = "http://192.168.1.100:8081/v1"
wire_api = "responses"
```

---

## Lynkr Configuration for Codex

Optimize Lynkr for Codex usage by configuring these `.env` settings:

### Recommended Settings

```bash
# =============================================================================
# Lynkr .env Configuration for Codex
# =============================================================================

# Your LLM provider (Codex works with all Lynkr providers)
MODEL_PROVIDER=azure-openai
# MODEL_PROVIDER=ollama
# MODEL_PROVIDER=bedrock

# Tool execution mode - let Codex handle tools locally
TOOL_EXECUTION_MODE=client

# Increase tool loop threshold for complex multi-step tasks
POLICY_TOOL_LOOP_THRESHOLD=15

# Semantic cache (disable if getting repeated responses)
SEMANTIC_CACHE_ENABLED=false

# Or keep enabled with proper embeddings for faster responses
# SEMANTIC_CACHE_ENABLED=true
# OLLAMA_EMBEDDINGS_MODEL=nomic-embed-text
```

### Provider-Specific Examples

**Azure OpenAI:**
```bash
MODEL_PROVIDER=azure-openai
AZURE_OPENAI_ENDPOINT=https://your-resource.openai.azure.com/openai/responses?api-version=2025-04-01-preview
AZURE_OPENAI_API_KEY=your-key
AZURE_OPENAI_DEPLOYMENT=gpt-4o
```

**Ollama (Local, Free):**
```bash
MODEL_PROVIDER=ollama
OLLAMA_MODEL=qwen2.5-coder:latest
OLLAMA_ENDPOINT=http://localhost:11434
```

**AWS Bedrock:**
```bash
MODEL_PROVIDER=bedrock
AWS_BEDROCK_API_KEY=your-key
AWS_BEDROCK_MODEL_ID=anthropic.claude-3-5-sonnet-20241022-v2:0
```

---

## Troubleshooting

### Common Issues

| Issue | Cause | Solution |
|-------|-------|----------|
| Same response for all queries | Semantic cache matching on system prompt | Set `SEMANTIC_CACHE_ENABLED=false` in Lynkr `.env` |
| Tool calls not executing | Tool loop threshold too low | Set `POLICY_TOOL_LOOP_THRESHOLD=15` |
| Connection refused | Lynkr not running | Run `npm start` in Lynkr directory |
| Slow first request | Cold start / model loading | Set `OLLAMA_KEEP_ALIVE=24h` for Ollama |
| "Invalid API key" errors | API key not set | Set `OPENAI_API_KEY=dummy` (Lynkr doesn't validate) |
| Streaming issues | Wire API mismatch | Try `wire_api = "chat"` instead of `"responses"` |

### Debug Mode

Enable verbose logging to diagnose issues:

```bash
# In Lynkr .env
LOG_LEVEL=debug

# Restart Lynkr and watch logs
npm start
```

### Verify Connection

Test that Codex can reach Lynkr:

```bash
curl http://localhost:8081/health
# Expected: {"status":"ok",...}
```

---

## Model Mapping

When you specify a model in Codex, Lynkr maps it to your configured provider:

| Codex Model | Lynkr Mapping |
|-------------|---------------|
| `gpt-4o` | Uses your `MODEL_PROVIDER` default model |
| `gpt-4o-mini` | Maps to smaller/cheaper model variant |
| `claude-sonnet-4-5` | Routes to Anthropic-compatible provider |
| `claude-opus-4-5` | Routes to most capable model |

The actual model used depends on your Lynkr provider configuration.

---

## Architecture

```
┌─────────────────┐
│   Codex CLI     │  Terminal AI coding assistant
│   (Your Machine)│
└────────┬────────┘
         │ OpenAI Responses API
         │ http://localhost:8081/v1
         ▼
┌─────────────────┐
│     Lynkr       │  Universal LLM proxy
│   Port 8081     │
│                 │
│ • Format conv.  │  Converts between API formats
│ • Token optim.  │  Reduces costs 60-80%
│ • Caching       │  Semantic + prompt caching
│ • Tool routing  │  Server or client execution
└────────┬────────┘
         │
    ┌────┴────┬──────────┬──────────┐
    ▼         ▼          ▼          ▼
┌───────┐ ┌───────┐ ┌─────────┐ ┌─────────┐
│Ollama │ │Azure  │ │Bedrock  │ │Databricks│
│(Free) │ │OpenAI │ │(100+)   │ │         │
└───────┘ └───────┘ └─────────┘ └─────────┘
```

---

## Tips & Best Practices

### 1. Use Trusted Projects

For frequently used projects, set trust level to avoid repeated permission prompts:

```toml
[projects."/Users/yourname/main-project"]
trust_level = "trusted"
```

### 2. Configure Personality

Choose a personality that matches your workflow:

- `pragmatic` - Direct, solution-focused responses
- `concise` - Minimal explanations, code-focused
- `educational` - Detailed explanations, good for learning
- `default` - Balanced approach

### 3. Keep Models Loaded

Prevent slow first requests with Ollama:

```bash
# macOS
launchctl setenv OLLAMA_KEEP_ALIVE "24h"

# Linux/Windows
export OLLAMA_KEEP_ALIVE=24h
```

### 4. Monitor Token Usage

Check Lynkr metrics to monitor usage:

```bash
curl http://localhost:8081/metrics/token-usage
```

---

## Related Documentation

- **[Installation Guide](installation.md)** - Install and configure Lynkr
- **[Provider Configuration](providers.md)** - Configure your LLM provider
- **[Token Optimization](token-optimization.md)** - Reduce costs with Lynkr
- **[Troubleshooting](troubleshooting.md)** - Common issues and solutions

---

**Need help?** Visit [GitHub Discussions](https://github.com/vishalveerareddy123/Lynkr/discussions) or check the [FAQ](faq.md).
