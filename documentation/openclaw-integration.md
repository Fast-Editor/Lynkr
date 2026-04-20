# OpenClaw Integration

This guide explains how to use [OpenClaw](https://github.com/openclaw/openclaw) with Lynkr as its AI backend, enabling you to route OpenClaw's requests through any LLM provider.

---

## Overview

OpenClaw is an open-source AI agent framework that supports multiple channels (terminal, Slack, Discord, Telegram, etc.). By connecting it to Lynkr, you can:

- Use **any model** (Ollama, Bedrock, OpenRouter, Moonshot, etc.) with OpenClaw
- Benefit from Lynkr's **complexity-based routing** — simple tasks go to fast/cheap models, complex tasks go to powerful ones
- See the **actual provider/model** used in each response via OpenClaw mode
- Get **token optimization** (60-80% savings) and **prompt caching** for free

---

## Quick Start

### 1. Start Lynkr

```bash
npm install -g lynkr
lynkr start
```

### 2. Configure OpenClaw

Add Lynkr as a provider in your OpenClaw configuration (`openclaw.json` or via the dashboard):

```json
{
  "models": {
    "providers": [
      {
        "name": "lynkr",
        "type": "openai-compatible",
        "base_url": "http://localhost:8081/v1",
        "api_key": "any-value",
        "models": ["auto"]
      }
    ]
  },
  "agents": {
    "defaults": {
      "models": {
        "primary": "lynkr/auto",
        "fallback": "lynkr/auto"
      }
    }
  }
}
```

### 3. Enable OpenClaw Mode in Lynkr

Add to your Lynkr `.env`:

```env
OPENCLAW_MODE=true
```

This rewrites the generic `model: "auto"` in responses with the actual `provider/model` that handled the request (e.g., `moonshot/kimi-k2-thinking`, `ollama/qwen2.5-coder:7b`). OpenClaw can then display which model answered each query.

---

## Tier Routing

Lynkr's tier routing works seamlessly with OpenClaw. Configure your tiers in `.env`:

```env
# Simple questions → cheap/fast model
TIER_SIMPLE=ollama:llama3.2

# Code reading, research → mid-tier
TIER_MEDIUM=openrouter:anthropic/claude-sonnet-4

# Complex multi-file changes → powerful model
TIER_COMPLEX=bedrock:anthropic.claude-sonnet-4-20250514-v1:0

# Deep reasoning tasks → most capable
TIER_REASONING=bedrock:anthropic.claude-opus-4-20250514-v1:0
```

OpenClaw sends all requests to `lynkr/auto`. Lynkr analyzes complexity and routes to the right tier automatically. With `OPENCLAW_MODE=true`, the response includes the actual model used.

---

## Supported Endpoints

Lynkr exposes these endpoints for OpenClaw:

| Endpoint | Description |
|----------|-------------|
| `POST /v1/chat/completions` | Chat API (primary endpoint for OpenClaw) |
| `POST /v1/responses` | OpenAI Responses API |
| `GET /v1/models` | List available models |
| `POST /v1/embeddings` | Embeddings for semantic search |
| `GET /v1/health` | Health check |
| `POST /v1/files` | File upload |
| `GET /v1/files/:id` | File retrieval |

---

## Tool Calling

Lynkr supports full tool calling passthrough for OpenClaw agents. It also handles models that output tool calls as raw XML/text (common with Ollama models like Minimax, Qwen, GLM) by automatically extracting and converting them to structured tool calls.

Supported extraction formats:
- Minimax `<invoke>` XML
- Hermes/Qwen `<tool_call>` JSON
- GLM `<arg_key>/<arg_value>` XML
- Llama `<|python_tag|>` JSON
- Mistral `[TOOL_CALLS]` prefix
- DeepSeek Unicode tokens
- GPT-OSS Harmony `<|call|>`
- Raw JSON fallback

---

## Extended Thinking

When using models that support extended thinking (Claude 4+, Moonshot K2-thinking), Lynkr passes through thinking blocks and `reasoning_content`. OpenClaw can display these for transparency.

```env
# No additional config needed — thinking passthrough is automatic
```

---

## Self-Hosting with Ollama (Free)

For zero-cost operation, use Ollama as your only provider:

```env
MODEL_PROVIDER=ollama
OLLAMA_MODEL=qwen2.5-coder:latest
OPENCLAW_MODE=true

TIER_SIMPLE=ollama:qwen2.5-coder:7b
TIER_MEDIUM=ollama:qwen2.5-coder:32b
TIER_COMPLEX=ollama:qwen2.5-coder:32b
TIER_REASONING=ollama:qwen2.5-coder:32b
```

---

## Troubleshooting

| Issue | Solution |
|-------|----------|
| OpenClaw can't connect | Verify Lynkr is running: `curl http://localhost:8081/health` |
| Model shows "auto" instead of actual model | Enable `OPENCLAW_MODE=true` in Lynkr `.env` |
| Tool calls appearing as raw text | Lynkr's XML tool extractor handles this automatically — update to latest version |
| Slow responses | Check tier config — simple queries may be going to expensive cloud models. Use Ollama for `TIER_SIMPLE` |
| Rate limiting | Lynkr has built-in rate limiting. Adjust `RATE_LIMIT_*` env vars if needed |

---

## Docker Deployment

```yaml
# docker-compose.yml
services:
  lynkr:
    image: lynkr:latest
    ports:
      - "8081:8081"
    environment:
      - MODEL_PROVIDER=ollama
      - OLLAMA_ENDPOINT=http://ollama:11434
      - OPENCLAW_MODE=true
    depends_on:
      - ollama

  ollama:
    image: ollama/ollama
    ports:
      - "11434:11434"
    volumes:
      - ollama_data:/root/.ollama

volumes:
  ollama_data:
```

Then configure OpenClaw to point at `http://lynkr:8081/v1` (or `http://localhost:8081/v1` if running outside Docker).
