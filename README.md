# Lynkr

### Run Claude Code, Cursor, and Codex on any model. One proxy, every provider.

[![npm version](https://img.shields.io/npm/v/lynkr.svg)](https://www.npmjs.com/package/lynkr)
[![Tests](https://img.shields.io/badge/tests-652%20passing-brightgreen)](https://github.com/vishalveerareddy123/Lynkr)
[![License: Apache 2.0](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-20%2B-green)](https://nodejs.org)
[![Homebrew Tap](https://img.shields.io/badge/homebrew-lynkr-brightgreen.svg)](https://github.com/vishalveerareddy123/homebrew-lynkr)
[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/vishalveerareddy123/Lynkr)

<table>
<tr>
<td align="center"><strong>10+</strong><br/>LLM Providers</td>
<td align="center"><strong>60-80%</strong><br/>Cost Reduction</td>
<td align="center"><strong>652</strong><br/>Tests Passing</td>
<td align="center"><strong>0</strong><br/>Code Changes Required</td>
</tr>
</table>

---

## The Problem

AI coding tools lock you into one provider. Claude Code requires Anthropic. Codex requires OpenAI. You can't use your company's Databricks endpoint, your local Ollama models, or your AWS Bedrock account — at least, not without Lynkr.

**The real costs:**
- Anthropic API at $15/MTok output adds up fast for daily coding
- No way to use free local models (Ollama, llama.cpp) with Claude Code
- Enterprise teams can't route through their own cloud infrastructure
- Provider outages take your entire workflow down

## The Solution

Lynkr is a self-hosted proxy that sits between your AI coding tools and any LLM provider. One environment variable change, and your tools work with any model.

```
Claude Code / Cursor / Codex / Cline / Continue / Vercel AI SDK
                        |
                      Lynkr
                        |
    Ollama | Bedrock | Databricks | OpenRouter | Azure | OpenAI | llama.cpp
```

```bash
# That's it. Three lines.
npm install -g lynkr
export ANTHROPIC_BASE_URL=http://localhost:8081
lynkr start
```

---

## Quick Start

### Install

```bash
npm install -g pino-pretty && npm install -g lynkr
```

### Pick a Provider

**Free & Local (Ollama)**
```bash
export MODEL_PROVIDER=ollama
export OLLAMA_MODEL=qwen2.5-coder:latest
lynkr start
```

**AWS Bedrock (100+ models)**
```bash
export MODEL_PROVIDER=bedrock
export AWS_BEDROCK_API_KEY=your-key
export AWS_BEDROCK_MODEL_ID=anthropic.claude-3-5-sonnet-20241022-v2:0
lynkr start
```

**OpenRouter (cheapest cloud)**
```bash
export MODEL_PROVIDER=openrouter
export OPENROUTER_API_KEY=sk-or-v1-your-key
lynkr start
```

### Connect Your Tool

**Claude Code**
```bash
export ANTHROPIC_BASE_URL=http://localhost:8081
export ANTHROPIC_API_KEY=dummy
claude "Your prompt here"
```

**Codex CLI** — edit `~/.codex/config.toml`:
```toml
model_provider = "lynkr"
model = "gpt-4o"

[model_providers.lynkr]
name = "Lynkr Proxy"
base_url = "http://localhost:8081/v1"
wire_api = "responses"
```

**Cursor IDE**
- Settings > Features > Models
- Base URL: `http://localhost:8081/v1`
- API Key: `sk-lynkr`

**Vercel AI SDK**
```ts
import { generateText } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

const lynkr = createOpenAICompatible({
  baseURL: "http://localhost:8081/v1",
  name: "lynkr",
  apiKey: "sk-lynkr",
});

const { text } = await generateText({
  model: lynkr.chatModel("auto"),
  prompt: "Hello!",
});
```

> Works with any OpenAI-compatible client: Cline, Continue.dev, ClawdBot, KiloCode, and more.

---

## Supported Providers

| Provider | Type | Models | Cost |
|----------|------|--------|------|
| **Ollama** | Local | Unlimited (free, offline) | **Free** |
| **llama.cpp** | Local | Any GGUF model | **Free** |
| **LM Studio** | Local | Local models with GUI | **Free** |
| **MLX Server** | Local | Apple Silicon optimized | **Free** |
| **AWS Bedrock** | Cloud | 100+ (Claude, Llama, Mistral, Titan) | $$ |
| **OpenRouter** | Cloud | 100+ (GPT, Claude, Llama, Gemini) | $-$$ |
| **Databricks** | Cloud | Claude Sonnet 4.5, Opus 4.5 | $$$ |
| **Azure OpenAI** | Cloud | GPT-4o, GPT-5, o1, o3 | $$$ |
| **Azure Anthropic** | Cloud | Claude models | $$$ |
| **OpenAI** | Cloud | GPT-4o, o1, o3 | $$$ |

4 local providers for **100% offline, free** usage. 6+ cloud providers for scale.

---

## Why Lynkr Over Alternatives

| Feature | Lynkr | LiteLLM (42K stars) | OpenRouter | PortKey |
|---------|-------|---------------------|------------|---------|
| **Setup** | `npm install -g lynkr` | Python + Docker + Postgres | Account signup | Docker + config |
| **Claude Code support** | Drop-in, native | Requires config | No CLI support | Requires config |
| **Cursor support** | Drop-in, native | Partial | Via API key | Partial |
| **Codex CLI support** | Drop-in, native | No | No | No |
| **Built for coding tools** | Yes (purpose-built) | No (general gateway) | No (general API) | No (general gateway) |
| **Local models** | Ollama, llama.cpp, LM Studio, MLX | Ollama only | No | No |
| **Token optimization** | Built-in (60-80% savings) | No | No | Caching only |
| **Complexity routing** | Auto-routes by task difficulty | Manual | Cost/latency only | Manual |
| **Memory system** | Titans-inspired long-term memory | No | No | No |
| **Self-hosted** | Yes (Node.js) | Yes (Python stack) | No (SaaS) | Yes (Docker) |
| **Offline capable** | Yes | Yes | No | No |
| **Transaction fees** | None | None (OSS) / Paid enterprise | 5.5% on credits | Free tier / Paid |
| **Dependencies** | Node.js only | Python, Prisma, PostgreSQL | N/A | Docker, Python |
| **Format conversion** | Anthropic <-> OpenAI (automatic) | Automatic | N/A | Automatic |
| **License** | Apache 2.0 | MIT | Proprietary | MIT (gateway) |

**Lynkr's edge:** Purpose-built for AI coding tools. Not a general LLM gateway — a proxy that understands Claude Code, Cursor, and Codex natively, with built-in token optimization, complexity-based routing, and a memory system designed for coding workflows. Installs in one command, runs on Node.js, zero infrastructure required.

---

## Cost Comparison

| Scenario | Direct Anthropic | Lynkr + Ollama | Lynkr + OpenRouter | Lynkr + Bedrock |
|----------|-----------------|----------------|--------------------| --------------- |
| Daily Claude Code usage | ~$10-30/day | **$0 (free)** | ~$2-8/day | ~$5-15/day |
| Token optimization savings | — | — | 60-80% further | 60-80% further |
| Monthly (heavy use) | $300-900 | **$0** | $60-240 | $150-450 |

> With token optimization enabled, Lynkr's smart tool selection, prompt caching, and memory deduplication reduce token usage by 60-80% on top of provider savings.

---

## What's Under the Hood

Lynkr isn't just a passthrough proxy. It's an optimization layer.

### Smart Routing
Routes requests to the right model based on task complexity. Simple questions go to fast/cheap models. Complex architectural tasks go to powerful models. You configure the tiers.

### Token Optimization
- **Smart tool selection** — only sends tools relevant to the current task
- **Prompt compression** — removes redundant context before sending
- **Memory deduplication** — eliminates repeated information across turns
- **TOON format** — compact serialization that cuts token count

### Enterprise Resilience
- **Circuit breakers** — automatic failover when a provider goes down
- **Load shedding** — graceful degradation under high load
- **Prometheus metrics** — full observability at `/metrics`
- **Health checks** — K8s-ready endpoints at `/health`

### Memory System
Titans-inspired long-term memory with surprise-based filtering. The system remembers important context across sessions and forgets noise — reducing token waste from repeated context.

### Semantic Cache
Cache responses for semantically similar prompts. Hit rate depends on your workflow, but repeat questions (common in coding) get instant responses.

```bash
SEMANTIC_CACHE_ENABLED=true
SEMANTIC_CACHE_THRESHOLD=0.95
```

### MCP Integration
Automatic Model Context Protocol server discovery and orchestration. Your MCP tools work through Lynkr without configuration.

---

## Deployment Options

**NPM (recommended)**
```bash
npm install -g lynkr && lynkr start
```

**Docker**
```bash
docker-compose up -d
```

**Git Clone**
```bash
git clone https://github.com/vishalveerareddy123/Lynkr.git
cd Lynkr && npm install && cp .env.example .env
npm start
```

**Homebrew**
```bash
brew tap vishalveerareddy123/lynkr
brew install lynkr
```

---

## Documentation

| Guide | Description |
|-------|-------------|
| [Installation](documentation/installation.md) | All installation methods |
| [Provider Config](documentation/providers.md) | Setup for all 10+ providers |
| [Claude Code CLI](documentation/claude-code-cli.md) | Detailed Claude Code integration |
| [Codex CLI](documentation/codex-cli.md) | Codex config.toml setup |
| [Cursor IDE](documentation/cursor-integration.md) | Cursor integration + troubleshooting |
| [Embeddings](documentation/embeddings.md) | @Codebase semantic search (4 options) |
| [Token Optimization](documentation/token-optimization.md) | 60-80% cost reduction strategies |
| [Memory System](documentation/memory-system.md) | Titans-inspired long-term memory |
| [Tools & Execution](documentation/tools.md) | Tool calling and execution modes |
| [Smart Routing](documentation/routing.md) | Complexity-based model routing |
| [Docker Deployment](documentation/docker.md) | docker-compose with GPU support |
| [Production Hardening](documentation/production.md) | Circuit breakers, metrics, load shedding |
| [API Reference](documentation/api.md) | All endpoints and formats |
| [Troubleshooting](documentation/troubleshooting.md) | Common issues and solutions |
| [FAQ](documentation/faq.md) | Frequently asked questions |

---

## Troubleshooting

| Issue | Solution |
|-------|----------|
| Same response for all queries | Disable semantic cache: `SEMANTIC_CACHE_ENABLED=false` |
| Tool calls not executing | Increase threshold: `POLICY_TOOL_LOOP_THRESHOLD=15` |
| Slow first request | Keep Ollama loaded: `OLLAMA_KEEP_ALIVE=24h` |
| Connection refused | Ensure Lynkr is running: `lynkr start` |

---

## Contributing

We welcome contributions. See the [Contributing Guide](documentation/contributing.md) and [Testing Guide](documentation/testing.md).

---

## License

Apache 2.0 — See [LICENSE](LICENSE).

---

## Community

- [GitHub Discussions](https://github.com/vishalveerareddy123/Lynkr/discussions) — Questions and tips
- [Report Issues](https://github.com/vishalveerareddy123/Lynkr/issues) — Bug reports and feature requests
- [NPM Package](https://www.npmjs.com/package/lynkr) — Official package
- [DeepWiki](https://deepwiki.com/vishalveerareddy123/Lynkr) — AI-powered docs search

---

**Built by [Vishal Veera Reddy](https://github.com/vishalveerareddy123) — for developers who want control over their AI tools.**
