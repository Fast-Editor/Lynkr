# Lynkr Wrap Guide

`lynkr wrap` launches AI coding tools through the Lynkr proxy, giving users access to **tier routing**, **compression**, and **caching**. For Claude Code Pro/Max subscription users, this works without separate API billing.

---

## Why Use Lynkr Wrap?

**Without Lynkr:**
- Claude Code uses your Pro/Max subscription directly
- Simple and complex requests both count against your usage limits
- No compression, no caching, no routing optimization

**With Lynkr Wrap:**
- **Hybrid routing** — route simple tasks to free local models (Ollama), complex tasks to your subscription
- **3-5x more usage** from the same subscription limits
- **All Lynkr features** — tier routing, TOON/RTK compression, semantic caching, fallback
- **Zero configuration** — just run `lynkr wrap claude` instead of `claude`

---

## Supported Tools

| Tool | Command | OAuth Support | Docs |
|---|---|---|---|
| **Claude Code** | `lynkr wrap claude` | ✅ Pro/Max | [claude.ai/code](https://claude.ai/code) |
| **GitHub Copilot CLI** | `lynkr wrap copilot` | ✅ Subscription | [github.com/features/copilot](https://github.com/features/copilot) |
| **Aider** | `lynkr wrap aider` | ❌ API key | [aider.chat](https://aider.chat) |
| **Cursor** | `lynkr wrap cursor` | ✅ Pro | [cursor.sh](https://cursor.sh) |
| **OpenAI Codex CLI** | `lynkr wrap codex` | ❌ API key | [openai.com](https://openai.com) |

---

## Quick Start

### 1. Install Your Tool

**Claude Code:**
```bash
brew install --cask claude-code
```

**Copilot CLI:**
```bash
npm install -g @githubnext/github-copilot-cli
```

**Aider:**
```bash
pip install aider-chat
```

**Cursor:**
```bash
# Download from cursor.sh
brew install --cask cursor
```

**Codex:**
```bash
pip install openai
```

### 2. Install Lynkr

```bash
npm install -g lynkr@latest
```

### 3. Configure Tiers (Optional)

Create or edit `~/.claude-code/.env` (or run `lynkr` once to generate it):

```bash
# Route simple tasks to free local Ollama
TIER_SIMPLE=ollama:llama3.2
TIER_MEDIUM=ollama:qwen2.5

# Route complex tasks to your Pro/Max subscription
TIER_COMPLEX=anthropic:claude-sonnet-4
TIER_REASONING=anthropic:claude-opus-4

# Ollama endpoint (if using local models)
OLLAMA_ENDPOINT=http://localhost:11434
```

**No `ANTHROPIC_API_KEY` needed** — your OAuth token from Claude Code is used automatically.

### 4. Launch

```bash
# Claude Code
lynkr wrap claude

# GitHub Copilot CLI
lynkr wrap copilot

# Aider
lynkr wrap aider

# Cursor
lynkr wrap cursor

# Codex
lynkr wrap codex
```

That's it! Your tool launches with Lynkr routing enabled.

---

## How It Works

```
┌─────────────────────────────────────────────┐
│  You run: lynkr wrap claude                 │
└──────────────┬──────────────────────────────┘
               │
       ┌───────▼────────┐
       │  Lynkr starts  │
       │  on :8081      │
       └───────┬────────┘
               │
    ┌──────────▼────────────────────┐
    │  Claude Code launched with    │
    │  ANTHROPIC_BASE_URL=          │
    │    http://localhost:8081      │
    └──────────┬────────────────────┘
               │
        ┌──────▼───────┐
        │  Your prompt │
        └──────┬───────┘
               │
    ┌──────────▼───────────────────┐
    │  Lynkr analyzes complexity   │
    │  Score: 22 → SIMPLE tier     │
    └──────────┬───────────────────┘
               │
       ┌───────▼────────┐
       │  Route to:     │
       │  Ollama (FREE) │
       └───────┬────────┘
               │
        ┌──────▼────────┐
        │  Response     │
        │  to Claude    │
        └───────────────┘
```

vs. complex task:

```
Your prompt → Lynkr
  → Score: 78 → REASONING tier
  → Route to: Anthropic (via OAuth, counts against Pro/Max)
  → Response to Claude
```

---

## Usage

### Basic

```bash
# Claude Code
lynkr wrap claude

# GitHub Copilot CLI
lynkr wrap copilot

# Aider
lynkr wrap aider

# Cursor
lynkr wrap cursor
```

### Custom Port

```bash
lynkr wrap claude --port 9000
lynkr wrap aider --port 8090
```

### Pass Args to Target Tool

```bash
# Claude Code
lynkr wrap claude -- --help
lynkr wrap claude -- --model claude-opus-4

# Aider
lynkr wrap aider -- --model gpt-4

# Copilot
lynkr wrap copilot -- --version
```

Everything after `--` is forwarded to the target tool.

---

## What Gets Routed?

| Request Type | Example | Typical Tier | Routed To (example config) |
|---|---|---|---|
| Greeting | "Hi" | SIMPLE | Ollama (free) |
| File read | "Read package.json" | SIMPLE | Ollama (free) |
| Simple question | "What's in this folder?" | MEDIUM | Ollama (free) |
| Refactor | "Refactor this function" | COMPLEX | Anthropic (Pro/Max) |
| Architecture | "Design a new API" | REASONING | Anthropic (Pro/Max) |

**Result:** 60-70% of requests never touch your subscription → 3-5x effective capacity.

---

## Hybrid Provider Routing

Mix multiple providers to optimize cost and quality:

```bash
TIER_SIMPLE=ollama:llama3.2              # Free local
TIER_MEDIUM=openai:gpt-4o-mini           # Cheap OpenAI API
TIER_COMPLEX=anthropic:claude-sonnet-4   # Your Pro/Max subscription
TIER_REASONING=azure-openai:gpt-5.2      # Enterprise Azure credits

OPENAI_API_KEY=sk-...                    # Separate OpenAI key
AZURE_OPENAI_API_KEY=...                 # Separate Azure key
```

Each tier uses its own authentication — Anthropic routes use your OAuth token, others use the configured API keys.

---

## Session Stats

On clean exit (Ctrl-D or `/exit`), Lynkr shows what you saved:

```
╭─ Lynkr Session Stats ────────────────────────────────
│  Requests      47
│  Tokens        Original: 1,204,582  →  Routed: 892,103  (26% saved)
│  Tier Mix      SIMPLE: 12  MEDIUM: 28  COMPLEX: 7
│  Cache Hits    Semantic: 8  Prompt: 14
╰──────────────────────────────────────────────────────
```

Disable with:
```bash
export LYNKR_WRAP_SHOW_STATS=false
```

---

## Log Control

**By default, Lynkr suppresses verbose logs in wrap mode** to keep your terminal clean. Only errors are shown.

### Show More Logs (Debugging)

```bash
# Show all logs (info level)
LOG_LEVEL=info lynkr wrap claude

# Show debug logs
LOG_LEVEL=debug lynkr wrap claude

# Show warnings and errors
LOG_LEVEL=warn lynkr wrap claude
```

### Hide All Logs (Errors Only - Default)

```bash
LOG_LEVEL=error lynkr wrap claude
```

**Tip:** If you see intermixed JSON logs, it means your `.env` has `LOG_LEVEL=info`. Change it to `error` for clean output.

---

## ToS Compliance

**Is this allowed under Anthropic's Terms of Service?**

Yes, with caveats:

✅ **What's allowed:**
- Using the official Claude Code binary through a transparent proxy
- Routing requests to different providers with separate credentials
- Personal productivity tools that enhance your own usage

❌ **What's banned (per Feb 2026 update):**
- Extracting OAuth tokens and using them in non-Claude-Code clients
- Sharing one subscription to authenticate API access for multiple end users
- SaaS wrappers that resell Claude access

**Lynkr wrap is compliant because:**
1. It wraps the official Claude Code binary (not extracting tokens)
2. OAuth authentication stays in Claude Code → Anthropic sees legitimate traffic
3. When routing to Anthropic, your OAuth token is forwarded as-is
4. When routing elsewhere, separate credentials are used
5. It's a local tool for personal use (not redistribution)

**Bottom line:** Using it for yourself to optimize your Pro/Max usage is fine. Using it to resell access or share one subscription across a team would violate ToS.

---

## Troubleshooting

### "Claude Code not found in PATH"

Install Claude Code first:
```bash
brew install --cask claude-code
# Or download from: https://claude.ai/code
```

Verify:
```bash
claude --version
```

### "Port 8081 already in use"

Stop existing Lynkr:
```bash
lynkr stop
# Or use a different port:
lynkr wrap claude --port 9000
```

### "Failed to start Lynkr"

Check your `.env` configuration. Common issues:
- Missing `TIER_*` config (required)
- Invalid `OLLAMA_ENDPOINT` (if using Ollama)
- Conflicting `MODEL_PROVIDER` / `FALLBACK_PROVIDER` (use tier routing instead)

Debug logs:
```bash
tail -f data/logs/lynkr.log
```

### Ollama Not Starting

If you configured Ollama tiers, make sure Ollama is running:
```bash
ollama serve
# In another terminal:
ollama pull llama3.2
ollama pull qwen2.5
```

---

## Advanced

### View Live Routing Decisions

Open the dashboard while Claude Code is running:
```
http://localhost:8081/dashboard
```

Shows real-time tier routing, compression stats, and token savings.

### Custom Compression

Lynkr applies:
- **TOON compression** — tool outputs, JSON
- **RTK compression** — test results, git output, logs
- **Semantic caching** — dedup similar prompts

All automatic, no config needed.

### Tier Fallback

If your COMPLEX tier provider (e.g., Moonshot) is down, Lynkr auto-escalates to REASONING, then falls to MEDIUM/SIMPLE. Never silent — check response headers or dashboard.

---

## Comparison to Headroom

| Feature | Headroom | Lynkr Wrap |
|---|---|---|
| Wrap Claude Code | ✅ | ✅ |
| Compression | ✅ ML-based | ✅ TOON/RTK |
| Tier routing | ❌ | ✅ Hybrid providers |
| Caching | ✅ CCR | ✅ Semantic + prompt |
| Dashboard | ✅ | ✅ |
| Multi-provider routing | ❌ | ✅ |
| Fallback on failure | ❌ | ✅ Escalate-then-demote |
| Open source | ✅ | ✅ Apache 2.0 |

---

## FAQ

**Q: Does this work with Claude Pro or just Max?**
A: Both — any Claude subscription that includes Claude Code access (Pro, Max, Team, Enterprise).

**Q: Can I use it without a subscription (just API keys)?**
A: Yes! Configure all tiers with API-based providers:
```bash
TIER_SIMPLE=ollama:llama3.2
TIER_COMPLEX=openai:gpt-4o
```
No OAuth needed.

**Q: Will this slow down my responses?**
A: No — Lynkr adds <50ms overhead (routing + compression), typically invisible. Caching can make repeat queries *faster*.

**Q: Which tools are supported?**
A: Claude Code, GitHub Copilot CLI, Aider, Cursor, and OpenAI Codex CLI. See the table at the top for details.

---

## Next Steps

- **Monitor savings:** Open `http://localhost:8081/dashboard` during a session
- **Tune tiers:** Adjust complexity thresholds in `.env` if routing feels off
- **Add fallback:** Set `TIER_FALLBACK_ENABLED=true` (already on in 9.6.0+)
- **Try task decomposition:** Set `TASK_DECOMPOSITION_ENABLED=true` for multi-step plans

---

## Support

- **GitHub Issues:** https://github.com/Fast-Editor/Lynkr/issues
- **Docs:** https://fast-editor.github.io/Lynkr/
- **Discord:** (link TBD)

---

**Happy routing! 🚀**
