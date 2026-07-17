# Lynkr

### An LLM Gateway which optimises your token usage.

**84% fewer tokens on JSON tool results. 53% fewer tokens on tool-heavy requests. Sub-300ms semantic cache hits. Zero code changes.**

[![npm version](https://img.shields.io/npm/v/lynkr.svg)](https://www.npmjs.com/package/lynkr)
[![Tests](https://img.shields.io/badge/tests-1041%20passing-brightgreen)](https://github.com/Fast-Editor/Lynkr)
[![License: Apache 2.0](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-20%2B-green)](https://nodejs.org)
[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/Fast-Editor/Lynkr)

<table>
<tr>
<td align="center"><strong>84%</strong><br/>JSON Compression</td>
<td align="center"><strong>53%</strong><br/>Tool Token Reduction</td>
<td align="center"><strong>&lt;300ms</strong><br/>Semantic Cache Hits</td>
<td align="center"><strong>13+</strong><br/>LLM Providers</td>
<td align="center"><strong>0</strong><br/>Code Changes Required</td>
</tr>
</table>

> Numbers from the bundled benchmark against LiteLLM on identical free local backends — run it yourself: `node benchmark-tier-routing.js`. It doubles as a 19-scenario routing regression harness (currently 12/12 correctness checks), and `MODE=routing` runs a routing-only head-to-head that judges **both** proxies on the same acceptable-tier sets — including LiteLLM's Auto Router v2. [How it works →](docs/benchmarking.md)

> **Third-party benchmark:** on [RouterArena](https://github.com/RouteWorks/RouterArena) (ICLR 2026, 8,400 queries) Lynkr's routing scores **67.65 arena / 68.41% accuracy at $0.29 per 1K queries with 92.38 robustness** — above GPT-5's built-in router and NotDiamond at a fraction of their cost. [Methodology & caveats →](docs/routerarena-benchmark.md)

---

## 🚀 New: Wrap Mode for AI Coding Tools

**Use Lynkr's routing with your AI coding assistant — maximize your subscription value:**

```bash
npm install -g lynkr


# Claude Code Pro/Max
lynkr wrap claude


```

**Wrapping gives you:**
- ✅ Tier routing (send simple tasks to free Ollama, complex to your subscription/API)
- ✅ Sticky sessions: one routing decision per conversation via content fingerprinting, with automatic escalation when the task outgrows the model
- ✅ TOON/RTK compression (84% token reduction on large JSON tool outputs)
- ✅ Semantic caching (sub-300ms cache hits, 0 tokens billed)
- ✅ **3-5x more usage from the same subscription limits**
- ✅ Works with OAuth (Claude, Copilot, Cursor) or API keys (Aider, Codex)

[Full wrap guide →](docs/wrap-guide.md)

---

## Quick Start (2 Minutes)

### 1. Install Lynkr

```bash
npm install -g lynkr
```

### 2. Configure Lynkr

The fastest path is the interactive wizard:

```bash
lynkr init
```

It asks four questions — usage mode (Claude Pro/Max via wrap, or direct API keys), tier picks for SIMPLE/MEDIUM/COMPLEX/REASONING across the 12 supported providers, credentials for what you chose, and a few routing-intelligence knobs — then writes a fully-populated `.env` with sensible production defaults for everything else (caching, compression, policy budgets, MCP sandbox, agents, rate limiting).

Useful flags:

```bash
lynkr init --force                # overwrite an existing .env
```

See [`docs/init.md`](docs/init.md) for the full wizard reference.

If you'd rather configure by hand, the manual options below still work — copy `.env.example` to `.env` and edit it directly:

**Option A: Free & Local (Ollama) - Recommended for Testing**

```bash
# Install Ollama first: https://ollama.com
ollama pull qwen2.5-coder:latest
```


Then start Lynkr:

```bash
lynkr start
```

### 3. Connect Your Tool


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

## Common Startup Errors

### Error: `unable to determine transport target for "pino-pretty"`

**Problem:** You're running an older version (< 9.3.0).

**Solution:** Update to the latest version:
```bash
npm install -g lynkr@latest
```

If you must use an older version, set `NODE_ENV=production` before starting.

### Warning: `Missing tier configuration: TIER_SIMPLE, TIER_MEDIUM...`

**This is just a warning - you can ignore it.** Tier routing is optional.

To remove the warning, add to `.env`:
```bash
TIER_SIMPLE=ollama:qwen2.5-coder:latest
TIER_MEDIUM=ollama:qwen2.5-coder:latest
TIER_COMPLEX=ollama:qwen2.5-coder:latest
TIER_REASONING=ollama:qwen2.5-coder:latest
```

### Warning: `FALLBACK_PROVIDER='databricks' is enabled but missing credentials`

**Solution:** Add to `.env`:
```bash
FALLBACK_ENABLED=false
```

### Error: `connect ECONNREFUSED ::1:11434` (Ollama)

**Problem:** Ollama is not running.

**Solution:**
```bash
ollama serve
```

Keep this terminal open, and start Lynkr in a new terminal.

### Error: `Connection refused` or `404 Not Found`

**Problem:** Lynkr is not running or wrong port.

**Solution:** Check Lynkr is running on the correct port:
```bash
curl http://localhost:8081/
```

Should return: `{"service":"Lynkr","version":"9.x.x","status":"running"}`

---

## Why Lynkr?

AI coding tools lock you into one provider and send every token raw. Lynkr breaks both locks.

```
Claude Code / Cursor / Codex / Cline / Continue
                    ↓
                  Lynkr
          ┌─────────────────────┐
          │  Strip unused tools  │  ← 53% fewer tokens on tool calls
          │  Compress JSON blobs │  ← 84% on large tool results
          │  Semantic cache      │  ← <300ms hits, 0 tokens billed
          │  Route by complexity │  ← cheap model for simple, cloud for hard
          │  Learn from outcomes │  ← kNN + bandit + auto-calibration
          └─────────────────────┘
                    ↓
    Ollama | Bedrock | Azure | Moonshot | OpenRouter | OpenAI
```

**What you get:**
- ✅ **53% fewer tokens** on tool-heavy requests (Claude Code, Cursor sessions)
- ✅ **84% compression** on large JSON tool results (grep, file reads, test output)
- ✅ **Semantic cache** serves repeated queries in under 300ms with 0 tokens billed
- ✅ **Automatic tier routing** — simple questions go to cheap models, complex ones escalate; sessions stick to one model until the task genuinely outgrows it
- ✅ **A closed learning loop** — every outcome trains a kNN router and bandit, and tier thresholds re-calibrate nightly from your own traffic
- ✅ Route through **your company's infrastructure** (Databricks, Azure, Bedrock)
- ✅ **Zero code changes** — just change one environment variable

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

# Optional: Limits (remove for unlimited) for long conversations
POLICY_MAX_STEPS=50
POLICY_MAX_TOOL_CALLS=100
```

Lynkr analyzes each request and routes it to the appropriate tier. Simple questions use fast models. Complex refactoring uses powerful models.

**Result:** 70-90% of requests use cheaper/faster models. Only hard problems hit expensive models.

Tier configuration is strictly authoritative — bandit exploration is constrained to the models you've listed in `TIER_*`, and multi-turn conversations score with a recency-weighted sliding window so context isn't lost on short follow-ups. Conversations get a content-fingerprint session id (clients like Claude Code send none), the decision pins for the session, and a guarded escape ladder (risk keywords, force phrases, score drift, context overflow) re-escalates the moment a task outgrows its model. Full pipeline: [`docs/routing-intelligence.md`](docs/routing-intelligence.md) · intent scorer: [`docs/intent-window-routing.md`](docs/intent-window-routing.md) · verify any change: [`docs/benchmarking.md`](docs/benchmarking.md).

---


## Common Issues & Fixes

| Issue | Solution |
|-------|----------|
| **"Service temporarily overloaded"** | Ollama model too large for RAM. Use smaller model or increase `--max-old-space-size` |
| **"Route not found: HEAD /"** | Ignore - harmless health check from Claude Code |
| **"Hallucinated tool calls"** | Normal - Lynkr automatically filters invalid tools |
| **"Safe Command DSL blocked"** | Add `POLICY_SAFE_COMMANDS_ENABLED=false` to `.env` |
| **"spawn graphify ENOENT"** | Optional feature. Set `CODE_GRAPH_ENABLED=false` in `.env` (see Advanced Features section for installation) |
| **Slow first request (20+ sec)** | Ollama loading model into memory. Add `OLLAMA_KEEP_ALIVE=30m` in Ollama config |
| **No response after N turns** | Remove `POLICY_MAX_STEPS` and `POLICY_MAX_TOOL_CALLS` from `.env` (unlimited by default in v9.3.0+) |

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

Always-on (no config): **smart tool selection** (server mode), **RTK tool-result
compression** (test/git/grep/lint/build/JSON output), **MCP tool dedup** (drops
built-in WebSearch/WebFetch when an Exa/Tavily MCP tool is present), and
**request bypass** (Claude CLI Warmup / title-extraction calls are answered
locally, never hitting a provider).

Optional **terse-output mode** to cut *output* tokens:
```bash
CAVEMAN_ENABLED=true        # off by default — nudges the model to be concise
CAVEMAN_LEVEL=lite          # lite | full | ultra
```

### Cost tracking & model pricing
Per-request cost is computed from a model-pricing registry (LiteLLM → models.dev,
cached 24h) and recorded in telemetry. Models the registry doesn't know record
`cost_usd=null` (logged once) rather than a fabricated price. Pin prices for
unknown models:
```bash
# Per-1M-token USD prices, JSON keyed by model name
MODEL_PRICE_OVERRIDES={"my-model":{"input":0.5,"output":1.5}}
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

### Code Intelligence (Optional - Graphify)

**Graphify** provides AST-based code analysis for smarter routing decisions.

**Installation (Rust required):**
```bash
# Install Rust if not already installed
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source $HOME/.cargo/env

# Build and install graphify
git clone https://github.com/safishamsi/graphify
cd graphify
cargo build --release
sudo cp target/release/graphify /usr/local/bin/

# Verify installation
graphify --version
```

**Enable in `.env`:**
```bash
CODE_GRAPH_ENABLED=true
CODE_GRAPH_WORKSPACE=/path/to/your/project  # Optional, defaults to cwd
```

**Features:**
- AST-based complexity scoring
- Structural code analysis (19 languages supported)
- Enhanced routing decisions based on code structure

**Note:** Graphify is completely optional. If not installed, Lynkr falls back to simpler complexity analysis.

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

**Homebrew** (macOS / Linux)
```bash
brew tap fast-editor/lynkr
brew install lynkr
lynkr --version
```
Upgrade later with `brew update && brew upgrade lynkr`. The formula tracks the latest [`lynkr` npm release](https://www.npmjs.com/package/lynkr) automatically.

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

## Benchmark Results

Head-to-head against **LiteLLM** on the **same backends** (Ollama `minimax-m2.5`, Moonshot, Azure OpenAI), 9 scenarios across 4 feature categories. Apples-to-apples comparison is Lynkr vs LiteLLM **billed tokens on the same scenario**. Run with `node benchmark-tier-routing.js`.

> _Run: June 5, 2026 · Lynkr v9.3.2 · LiteLLM v1.87.1 · macOS, Apple Silicon._

### Token reduction (vs LiteLLM, same model & prompt)

| Mechanism | Lynkr | LiteLLM | Result |
|---|---|---|---|
| Smart tool selection (14 tools) | **959** tokens · $0.0044 | 2,085 tokens · $0.0091 | **53% fewer tokens, 52% cheaper** |
| TOON compression (60-item grep JSON) | **427** tokens · $0.009 | 3,458 tokens · $0.018 | **87.6% fewer tokens, 50% cheaper** |

Lynkr strips irrelevant tool schemas (smart tool selection) and binary-compresses large JSON tool results (TOON) — both in-process, no added latency.

### Semantic cache

| | Tokens billed | Response time |
|---|---|---|
| First call (cold) | 2,857 | 1,891ms |
| **Second call — paraphrased, cache hit** | **0** (served from cache) | **171ms (11× faster)** |

Near-identical prompts return cached responses in 171ms. Zero model tokens billed on a cache hit.

### Tier routing — vs LiteLLM Auto Router v2 (July 15, 2026)

LiteLLM v1.94 shipped a native complexity router (`auto_router/complexity_router`) with the same four tier names Lynkr uses. Head-to-head on the **same backends** with identical prompts, both proxies judged against the same acceptable-tier sets (11 routing scenarios, `MODE=routing node benchmark-tier-routing.js`, LiteLLM config in `litellm-autorouter-v2.yaml`):

| Router | Routing-correct | Routing overhead |
|---|---|---|
| **Lynkr** | **11/11** | local embedding, ~0 marginal cost/latency after cache |
| LiteLLM v2 — heuristic (default) | 4/11 | <1ms, free — but every miss under-routed hard work (banking security analysis, autonomous agentic loop) to the free local model |
| LiteLLM v2 — LLM classifier | 6–8/11 (non-deterministic across runs) | a paid GPT-5.2 call + ~2–3s on **every** request; fails outright with local classifier models (structured-output errors → silent heuristic fallback) |

Lynkr scores cleaned user-authored text against embedding anchors plus 13 weighted heuristic dimensions, detects agentic workflows, and strips harness-injected noise before scoring. LiteLLM's router reads the raw last message and has no verify-then-escalate cascade — its fallbacks trigger only on HTTP errors, never on a bad answer.

_Fairness notes: the 11 scenarios derive from Lynkr's own regression suite, so Lynkr has home-field advantage — the transferable finding is the direction of LiteLLM's failures (systematic under-routing on defaults; per-request cost and instability with the LLM classifier), not the exact scores. Lynkr's top tiers used Azure gpt-5.2-chat / Z.ai GLM-5.2; LiteLLM was given the identical tier targets._

### Cost projection (100,000 requests/month, same backend)

| | Monthly cost | vs LiteLLM |
|---|---|---|
| LiteLLM | ~$818 | baseline |
| **Lynkr** | **~$409** | **~50% cheaper** |

_Based on a tool-heavy agentic session (TOON scenario). On equal footing — same provider, same model — Lynkr is cheaper due to token optimization._

→ [Full benchmark report with methodology](BENCHMARK_REPORT.md)

---

## Cost Comparison

| Scenario | Direct Anthropic | Lynkr + Ollama | Lynkr + OpenRouter |
|----------|-----------------|----------------|-------------------|
| Daily coding (8h) | $10-30/day | **$0 (free)** | $2-8/day |
| Monthly (heavy use) | $300-900 | **$0** | $60-240 |

With tier routing + token optimization: **additional 50-87% savings** on cloud providers depending on workload.

---

## Why Lynkr vs Alternatives

| Feature | Lynkr | LiteLLM | OpenRouter | PortKey |
|---------|-------|---------|-----------|---------|
| **Setup** | `npm install -g lynkr` | Python + Docker + Postgres | Account signup | Docker stack |
| **Claude Code native** | ✅ Drop-in | ⚠️ Requires config | ❌ | ⚠️ Partial |
| **Cursor native** | ✅ Drop-in | ⚠️ Partial | ❌ | ⚠️ Partial |
| **Local models** | Ollama, llama.cpp, LM Studio | Ollama only | ❌ | ❌ |
| **Automatic tier routing** | ✅ embedding intent + 13-dimension scorer, verified cascade | ⚠️ Auto Router v2 (v1.94): heuristic under-routes, LLM classifier billed per request | ❌ | ❌ Manual metadata |
| **TOON JSON compression** | ✅ up to 87.6% | ❌ | ❌ | ❌ |
| **Smart tool selection** | ✅ up to 60% token reduction | ❌ | ❌ | ❌ |
| **Semantic cache** | ✅ 171ms hits, 0 tokens | ❌ | ❌ | ✅ Prompt cache only |
| **Long-term memory** | ✅ SQLite, per-session | ❌ | ❌ | ❌ |
| **MCP integration** | ✅ + Code Mode (96% reduction) | ❌ | ❌ | ❌ |
| **Self-hosted** | ✅ Node.js only | ✅ Python stack | ❌ SaaS | ✅ Docker |
| **Dependencies** | Node.js 20+ | Python, Prisma, PostgreSQL | None | Docker, Python |

**Lynkr's edge:** Purpose-built for AI coding tools. Compresses tokens before they reach the model — not just after. Zero-config for Claude Code, Cursor, and Codex. Installs in one command.

---

## Community

- [GitHub Discussions](https://github.com/Fast-Editor/Lynkr/discussions) — Ask questions
- [Report Issues](https://github.com/Fast-Editor/Lynkr/issues) — Bug reports
- [NPM Package](https://www.npmjs.com/package/lynkr) — Official releases
- [DeepWiki](https://deepwiki.com/Fast-Editor/Lynkr) — AI-powered docs

---

## License

Apache 2.0 — See [LICENSE](LICENSE).

---

**Built by [Vishal Veera Reddy](https://github.com/vishalveerareddy123) for developers who want control over their AI tools.**
