---
name: lynkr
display_name: Lynkr AI Routing Proxy
version: 8.0.1
description: Universal LLM proxy with intelligent routing, Graphify code intelligence, Distill compression, routing telemetry, Code Mode, and 12+ provider support. 60-80% cost reduction for Claude Code, Cursor, and Codex.
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
  - graphify
  - distill
  - telemetry
  - code-mode
  - compression
  - memory
category: infrastructure
homepage: https://github.com/Fast-Editor/Lynkr
npm: lynkr
requires:
  node: ">=20"
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
  - codex
  - deepseek
---

# Lynkr - Universal LLM Proxy

Lynkr routes AI coding requests to the optimal model based on task complexity, cost, and provider health. Supports 12+ providers with 60-80% cost reduction through intelligent token optimization.

## Quick Start

```bash
npm install -g lynkr
lynkr-setup   # Auto-installs Ollama + pulls a model
lynkr          # Start the proxy
```

Then point your AI coding tool at `http://localhost:8081/v1`.

## How It Works

1. **5-Phase Complexity Analysis** - Scores each request 0-100 using token count, tool usage, code patterns, domain keywords, and Graphify structural analysis (god nodes, community cohesion, blast radius)
2. **4-Tier Routing** - Maps score to SIMPLE/MEDIUM/COMPLEX/REASONING, each with a configured provider:model
3. **Agentic Detection** - Detects multi-step workflows (tool loops, autonomous agents) and upgrades to higher tiers
4. **Cost Optimization** - Picks the cheapest provider that can handle the tier
5. **Circuit Breaker + Failover** - Automatic failover with half-open probe recovery

## Key Features (v8.0)

### Intelligent Routing
- 5-phase complexity scoring with 15-dimension weighted mode
- Agentic workflow detection (SINGLE_SHOT / TOOL_CHAIN / ITERATIVE / AUTONOMOUS)
- Graphify knowledge graph integration — god node detection, community cohesion, blast radius
- Routing telemetry with SQLite store, quality scoring (0-100), latency tracking (P50/P95/P99)

### Token Optimization (60-80% savings)
- **Smart tool selection** — filters tools by request type
- **Distill compression** — structural similarity (Jaccard), delta rendering, block dedup
- **Code Mode** — replaces 100+ MCP tools with 4 meta-tools (~96% token reduction)
- **History compression** — sliding window with Distill-powered dedup
- **Prompt caching** — SHA-256 keyed LRU cache
- **Headroom sidecar** — optional 47-92% compression via Smart Crusher, CCR, LLMLingua

### Production Hardening
- Circuit breakers with half-open probe recovery
- Admin hot-reload endpoint (POST /v1/admin/reload) — no restart needed
- Per-request performance timing (PERF_TIMER=true)
- Prometheus metrics, structured logging, health checks
- Rate limiting, load shedding, input validation

### Long-Term Memory (Titans-Inspired)
- Surprise-based memory storage with decay
- Semantic search via FTS5
- Automatic extraction and injection

## Configuration for OpenClaw

Set tier routing in your environment:

```env
MODEL_PROVIDER=ollama
TIER_SIMPLE=ollama:llama3.2
TIER_MEDIUM=openrouter:anthropic/claude-sonnet-4
TIER_COMPLEX=bedrock:anthropic.claude-sonnet-4-20250514-v1:0
TIER_REASONING=bedrock:anthropic.claude-opus-4-20250514-v1:0
```

### OpenClaw Mode

When running under OpenClaw, enable model name rewriting:

```env
OPENCLAW_MODE=true
```

This replaces the generic `model: "auto"` in responses with the actual `provider/model` that handled the request.

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

## Providers

| Provider | Type | Models |
|----------|------|--------|
| Ollama | Local (free) | llama3.2, qwen2.5-coder, deepseek-coder, mistral |
| llama.cpp | Local (free) | Any GGUF model |
| LM Studio | Local (free) | Any downloaded model |
| OpenAI | Cloud | gpt-4o, o3, o4-mini |
| Anthropic | Cloud | claude-opus-4, claude-sonnet-4, claude-haiku-4.5 |
| Databricks | Cloud | Claude, GPT, Llama via Foundation Model APIs |
| AWS Bedrock | Cloud | Claude, Titan, Llama, Mistral |
| Azure OpenAI | Cloud | GPT-4o, o1, o3 |
| OpenRouter | Cloud | 100+ models |
| Google Vertex | Cloud | Gemini 2.5 Pro/Flash |
| Moonshot AI | Cloud | Kimi K2 Thinking/Turbo |
| Z.AI | Cloud | GLM-4.7 |
| DeepSeek | Cloud | DeepSeek Reasoner, R1 |

## New in v8.0

- **Graphify Integration** — AST-based knowledge graph with 19-language support for blast radius analysis
- **Distill Compression** — Structural similarity, delta rendering, and smart dedup
- **Routing Telemetry** — SQLite-backed decision recording with quality scoring
- **Code Mode** — 4 MCP meta-tools replace 100+ individual definitions
- **Admin Reload** — Hot-reload config + reset circuit breakers without restart
- **Performance Timer** — Per-request timing breakdown (PERF_TIMER=true)
- **Large Payload Passthrough** — Smart cloning skips base64 media that will be discarded

## Response Headers

| Header | Description |
|--------|-------------|
| `X-Lynkr-Provider` | Provider that handled the request |
| `X-Lynkr-Model` | Model used |
| `X-Lynkr-Tier` | Complexity tier (SIMPLE/MEDIUM/COMPLEX/REASONING) |
| `X-Lynkr-Complexity-Score` | Numeric score 0-100 |
| `X-Lynkr-Routing-Method` | How the route was decided |
| `X-Lynkr-Agentic` | Agentic workflow type (if detected) |
| `X-Lynkr-Cost-Optimized` | Whether cost optimization changed the provider |

## Telemetry Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /v1/routing/stats` | Aggregated routing stats with latency percentiles |
| `GET /v1/routing/stats/:provider` | Per-provider statistics |
| `GET /v1/routing/telemetry` | Raw telemetry records |
| `GET /v1/routing/accuracy` | Over/under-provisioned routing detection |
| `POST /v1/admin/reload` | Hot-reload config + reset circuit breakers |
| `POST /v1/admin/circuit-breakers/reset` | Reset circuit breakers |
