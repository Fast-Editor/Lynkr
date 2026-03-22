---
name: lynkr
display_name: Lynkr AI Routing Proxy
version: 0.6.0
description: Intelligent LLM routing proxy with complexity-based tier routing, agentic workflow detection, and multi-provider failover. Drop-in replacement for direct provider APIs.
author: lynkr-ai
license: MIT
tags:
  - routing
  - proxy
  - llm
  - multi-provider
  - ollama
  - openai
  - anthropic
  - bedrock
  - cost-optimization
category: infrastructure
homepage: https://github.com/lynkr-ai/lynkr
npm: lynkr
requires:
  node: ">=18"
providers:
  - ollama
  - databricks
  - azure-anthropic
  - azure-openai
  - openrouter
  - openai
  - bedrock
  - vertex
  - moonshot
  - zai
  - llamacpp
  - lmstudio
---

# Lynkr - Intelligent LLM Routing Proxy

Lynkr routes AI coding requests to the best available model based on task complexity, cost, and provider health. It supports 12+ providers and works as an OpenAI-compatible proxy.

## Quick Start

```bash
npm install -g lynkr
lynkr --port 8081
```

Then point your AI coding tool at `http://localhost:8081/v1`.

## How It Works

1. **Complexity Analysis** - Scores each request 0-100 based on token count, tool usage, code patterns, and domain keywords
2. **Tier Routing** - Maps score to a tier (SIMPLE/MEDIUM/COMPLEX/REASONING), each configured with a specific provider:model
3. **Agentic Detection** - Detects multi-step workflows (tool loops, autonomous agents) and upgrades to higher tiers
4. **Cost Optimization** - Picks the cheapest provider that can handle the tier
5. **Circuit Breaker + Failover** - Automatic failover when a provider is down

## Configuration for OpenClaw

Set tier routing in your environment:

```env
MODEL_PROVIDER=ollama
TIER_SIMPLE=ollama:qwen2.5-coder:7b
TIER_MEDIUM=openrouter:anthropic/claude-sonnet-4-20250514
TIER_COMPLEX=bedrock:anthropic.claude-sonnet-4-20250514-v1:0
TIER_REASONING=bedrock:anthropic.claude-sonnet-4-20250514-v1:0
```

### OpenClaw Mode

When running under OpenClaw, enable model name rewriting so the actual provider and model appear in responses:

```env
OPENCLAW_MODE=true
```

This replaces the generic `model: "auto"` in responses with the actual `provider/model` that handled the request (e.g., `ollama/qwen2.5-coder:7b` or `bedrock/claude-sonnet-4`).

## Provider Registration

Add to your `openclaw.json`:

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

## Features

- **12+ providers**: Ollama, OpenAI, Anthropic (Azure/Bedrock/Direct), OpenRouter, Vertex, Moonshot, Z.AI, LM Studio, llama.cpp
- **Smart routing**: Heuristic + optional BERT-based complexity classification
- **Tool support**: Server-side tool execution with IDE-aware tool mapping (Cursor, Cline, Continue, Codex)
- **Session management**: Persistent sessions with cross-request deduplication
- **Observability**: Prometheus metrics, circuit breaker status, routing decision headers (`X-Lynkr-*`)
- **Agent-aware**: `X-Agent-Role` header for multi-agent framework routing hints
- **Lazy tool loading**: On-demand tool registration for fast startup
- **History compression**: Automatic conversation trimming for long sessions

## Response Headers

Every response includes routing metadata:

| Header | Description |
|--------|-------------|
| `X-Lynkr-Provider` | Provider that handled the request |
| `X-Lynkr-Model` | Model used |
| `X-Lynkr-Tier` | Complexity tier (SIMPLE/MEDIUM/COMPLEX/REASONING) |
| `X-Lynkr-Complexity-Score` | Numeric score 0-100 |
| `X-Lynkr-Routing-Method` | How the route was decided |
| `X-Lynkr-Cost-Optimized` | Whether cost optimization changed the provider |
