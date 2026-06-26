# Lynkr Wrap Targets

Complete reference for all supported AI coding tools.

---

## Claude Code

**Command:** `lynkr wrap claude`

**Installation:**
```bash
# macOS
brew install --cask claude-code

# Or download from
https://claude.ai/code
```

**Authentication:** OAuth (Claude Pro/Max subscription)

**Environment Variable:** `ANTHROPIC_BASE_URL`

**Best For:** Pro/Max users who want to route simple tasks to free local models

**Example Tiers:**
```bash
TIER_SIMPLE=ollama:llama3.2
TIER_COMPLEX=anthropic:claude-sonnet-4
TIER_REASONING=anthropic:claude-opus-4
```

---

## GitHub Copilot CLI

**Command:** `lynkr wrap copilot`

**Installation:**
```bash
npm install -g @githubnext/github-copilot-cli

# Or
https://www.npmjs.com/package/@githubnext/github-copilot-cli
```

**Authentication:** OAuth (GitHub Copilot subscription)

**Environment Variable:** `OPENAI_API_BASE`

**Best For:** Copilot users who want compression and tier routing

**Example Tiers:**
```bash
TIER_SIMPLE=ollama:codellama
TIER_COMPLEX=openai:gpt-4o
```

---

## Aider

**Command:** `lynkr wrap aider`

**Installation:**
```bash
pip install aider-chat

# Or
https://aider.chat/docs/install.html
```

**Authentication:** API key (OpenAI, Anthropic, etc.)

**Environment Variable:** `OPENAI_API_BASE`

**Best For:** Aider users who want to mix local and cloud models

**Example Tiers:**
```bash
TIER_SIMPLE=ollama:qwen2.5-coder
TIER_COMPLEX=anthropic:claude-sonnet-4
```

**Usage:**
```bash
# Aider will use Lynkr for routing
lynkr wrap aider

# Pass aider flags after --
lynkr wrap aider -- --model gpt-4 --no-git
```

---

## Cursor

**Command:** `lynkr wrap cursor`

**Installation:**
```bash
# Download from
https://cursor.sh

# Or macOS
brew install --cask cursor
```

**Authentication:** OAuth (Cursor Pro subscription)

**Environment Variable:** `ANTHROPIC_BASE_URL`

**Best For:** Cursor Pro users who want tier routing

**Example Tiers:**
```bash
TIER_SIMPLE=ollama:deepseek-coder
TIER_COMPLEX=anthropic:claude-sonnet-4
```

---

## OpenAI Codex CLI

**Command:** `lynkr wrap codex`

**Installation:**
```bash
# OpenAI Python CLI
pip install openai

# Or Node.js
npm install -g openai
```

**Authentication:** API key (OpenAI)

**Environment Variable:** `OPENAI_API_BASE`

**Best For:** Codex users who want compression and cost control

**Example Tiers:**
```bash
TIER_SIMPLE=ollama:codellama
TIER_MEDIUM=openai:gpt-4o-mini
TIER_COMPLEX=openai:o1-preview
```

---

## Common Configuration

All targets share the same Lynkr `.env` configuration:

```bash
# Tier routing (adjust models to your preference)
TIER_SIMPLE=ollama:llama3.2
TIER_MEDIUM=ollama:qwen2.5
TIER_COMPLEX=anthropic:claude-sonnet-4
TIER_REASONING=anthropic:claude-opus-4

# Ollama (if using local models)
OLLAMA_ENDPOINT=http://localhost:11434

# Compression (enabled by default)
TOON_COMPRESSION_ENABLED=true
RTK_COMPRESSION_ENABLED=true

# Caching
SEMANTIC_CACHE_ENABLED=true
PROMPT_CACHE_ENABLED=true

# Lynkr server
PORT=8081

# Stats (shown on exit)
LYNKR_WRAP_SHOW_STATS=true
```

---

## Authentication Matrix

| Tool | Auth Type | Env Var | Lynkr Config |
|---|---|---|---|
| Claude Code | OAuth | `ANTHROPIC_BASE_URL` | No `ANTHROPIC_API_KEY` needed |
| Copilot CLI | OAuth | `OPENAI_API_BASE` | No `OPENAI_API_KEY` needed |
| Aider | API Key | `OPENAI_API_BASE` | Set `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` in `.env` |
| Cursor | OAuth | `ANTHROPIC_BASE_URL` | No `ANTHROPIC_API_KEY` needed |
| Codex | API Key | `OPENAI_API_BASE` | Set `OPENAI_API_KEY` in `.env` |

**Key insight:** OAuth tools (Claude, Copilot, Cursor) forward tokens automatically. API key tools (Aider, Codex) need keys in Lynkr's `.env` for tier routing to work.

---

## Troubleshooting

### "Binary not found"

Install the tool first, then verify:
```bash
claude --version
github-copilot-cli --version
aider --version
cursor --version
codex --version
```

### "Port 8081 already in use"

```bash
# Stop existing Lynkr
lynkr stop

# Or use a different port
lynkr wrap claude --port 9000
```

### OAuth Not Working (Claude/Copilot/Cursor)

Make sure you're logged into the tool:
```bash
claude login
gh copilot auth
# (Cursor logs in via UI)
```

### API Key Not Working (Aider/Codex)

Add your key to Lynkr's `.env`:
```bash
# For Anthropic models
ANTHROPIC_API_KEY=sk-ant-...

# For OpenAI models
OPENAI_API_KEY=sk-...
```

---

## Examples

### Claude Code with Hybrid Routing

```bash
# .env
TIER_SIMPLE=ollama:llama3.2
TIER_COMPLEX=anthropic:claude-sonnet-4

# Run
lynkr wrap claude
```

**Result:** Simple prompts ("Hi", "What's in this file?") → Ollama (free). Complex prompts ("Refactor this class") → Claude API (Pro/Max subscription).

---

### Aider with Tier Fallback

```bash
# .env
TIER_SIMPLE=ollama:qwen2.5-coder
TIER_COMPLEX=anthropic:claude-sonnet-4
TIER_FALLBACK_ENABLED=true

# Run
lynkr wrap aider -- /add myfile.py
```

**Result:** Aider routes through Lynkr. If Anthropic is down, fallback to Ollama.

---

### Copilot with Cost Control

```bash
# .env
TIER_SIMPLE=ollama:codellama
TIER_MEDIUM=openai:gpt-4o-mini
TIER_COMPLEX=openai:gpt-4o

# Run
lynkr wrap copilot
```

**Result:** 60-70% of requests stay on free Ollama. Remaining go to OpenAI (cheaper than pure Copilot API usage).

---

## Next Steps

- [Full wrap guide](wrap-guide.md)
- [Tier routing docs](../README.md#tier-routing)
- [Compression guide](../README.md#compression)
- [GitHub Issues](https://github.com/Fast-Editor/Lynkr/issues)
