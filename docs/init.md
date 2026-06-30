# `lynkr init` — Setup Wizard

Interactive command that produces a working `.env` from a short Q&A. Covers all
twelve supported providers, picks a provider+model for each tier, collects
credentials once, and emits a fully-populated configuration so the server boots
into a production-grade default state.

---

## Usage

```bash
lynkr init                        # interactive wizard
lynkr init --force                # overwrite existing .env
lynkr init --output=<path>        # write to <path> instead of ./.env
lynkr init --dry-run              # print the generated config to stdout
lynkr init --help
```

The wizard exits with a non-zero status if no TTY is attached (CI, piped stdin).
For unattended setups, generate a `.env` once interactively, then commit or
ship that file via your configuration management.

---

## Flow

### 1. Usage mode

Two paths to pick from:

- **Claude Pro/Max subscription via `lynkr wrap claude`** — sets
  `LYNKR_OAUTH_PASSTHROUGH=true` so subscription requests pass through to
  `api.anthropic.com` against your existing flat-fee plan. Wizard suggests
  Ollama for SIMPLE/MEDIUM tiers and offers a "skip" option for COMPLEX /
  REASONING because the subscription handles them.
- **Direct API usage** — pay-as-you-go with API keys. Every tier needs an
  explicit provider+model pick.

### 2. Per-tier provider + model

For each of `SIMPLE`, `MEDIUM`, `COMPLEX`, `REASONING`:

- Pick a provider from the full list of twelve.
- Provide (or accept the default) model name.
- If the picked provider needs credentials, the wizard collects them once
  and reuses across tiers — pick the same provider twice, get prompted once.

In wrap mode the COMPLEX and REASONING prompts also offer "Skip — let
subscription passthrough handle it" so you can leave `TIER_COMPLEX` /
`TIER_REASONING` unset.

### 3. Routing intelligence

- **Visible routing badge** — render `*[Lynkr] TIER → MODEL · score N*` at the
  start of each assistant reply. Sanitised on the inbound side so it never
  re-enters the model's context (see
  [`intent-window-routing.md`](./intent-window-routing.md)).
- **Intent window size** — how many recent user messages contribute to tier
  scoring. Default `5`.
- **Per-turn decay** — exponential weight applied to older messages. Default
  `0.7`.

---

## Supported providers

The wizard covers everything in `src/config/index.js` `SUPPORTED_MODEL_PROVIDERS`:

| Provider | Local? | Required env keys |
|---|---|---|
| `ollama` | ✓ | `OLLAMA_ENDPOINT` (default `http://localhost:11434`) |
| `llamacpp` | ✓ | `LLAMACPP_ENDPOINT` (default `http://localhost:8080`) |
| `lmstudio` | ✓ | `LMSTUDIO_ENDPOINT` (default `http://localhost:1234/v1`) |
| `azure-anthropic` | | `AZURE_ANTHROPIC_ENDPOINT`, `AZURE_ANTHROPIC_API_KEY` |
| `azure-openai` | | `AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_API_KEY`, `AZURE_OPENAI_DEPLOYMENT` |
| `openai` | | `OPENAI_API_KEY` |
| `openrouter` | | `OPENROUTER_API_KEY` |
| `databricks` | | `DATABRICKS_API_BASE`, `DATABRICKS_API_KEY` |
| `bedrock` | | `BEDROCK_API_KEY` (or IAM credentials) |
| `vertex` | | `VERTEX_API_KEY` (or Application Default Credentials) |
| `zai` | | `ZAI_API_KEY` |
| `moonshot` | | `MOONSHOT_API_KEY` |

Local providers skip the credential prompt entirely.

---

## What ends up in `.env`

The generated file is grouped into sections so it stays readable. Roughly:

```
# Tier routing            ← your wizard picks
# Server                  ← PORT, NODE_ENV, REQUEST_JSON_LIMIT, etc.
# Provider credentials    ← required keys for picked providers + placeholders
# Routing intelligence    ← LYNKR_VISIBLE_ROUTING, LYNKR_INTENT_*, cascade, kNN
# Tool execution          ← TOOL_EXECUTION_MODE, SMART_TOOL_SELECTION_*
# Caching                 ← PROMPT_CACHE_*, SEMANTIC_CACHE_*
# Compression & context   ← TOON_*, full HEADROOM_* Docker sidecar config
# Memory & tracking       ← MEMORY_* (11 keys), TOKEN_TRACKING_*, TOOL_TRUNCATION_*
# Prompt & output shaping ← SYSTEM_PROMPT_MODE, HISTORY_*, TOKEN_BUDGET_*, CAVEMAN_*
# Policy & budgets        ← POLICY_MAX_*, POLICY_GIT_*, POLICY_FILE_BLOCKED_PATHS
# Agents                  ← AGENTS_ENABLED, AGENTS_DEFAULT_MODEL, etc.
# Rate limiting           ← RATE_LIMIT_*
# MCP sandbox             ← MCP_SANDBOX_* Docker isolation config
# Web tools               ← WEB_SEARCH_*, WEB_FETCH_*
# TinyFish                ← TinyFish web automation config (key empty)
# Workspace test runner   ← WORKSPACE_TEST_*
# Ops                     ← HOT_RELOAD_*, LOAD_SHEDDING_*
# Logging                 ← LOG_LEVEL=silent
```

A fresh wizard run yields roughly 150 KEY=VALUE entries spanning 20 sections —
everything you need to boot a production-grade Lynkr.

Sensitive defaults you can change anytime:

- `LOG_LEVEL=silent` — flip to `info` or `debug` for diagnostics.
- `MCP_SANDBOX_ENABLED=true` — set to `false` if you're not using Docker for
  MCP tool isolation.
- `HEADROOM_ENABLED=true` — set to `false` to skip the context-compression
  sidecar.
- `POLICY_MAX_STEPS=2000`, `POLICY_MAX_TOOL_CALLS=2000` — lower for stricter
  agent loop bounds.

---

## Re-running

`lynkr init` refuses to overwrite an existing `.env` unless you pass `--force`.
This guards against accidentally losing tuned values. A safe iteration loop:

```bash
lynkr init --output=/tmp/new.env       # generate to scratch
diff .env /tmp/new.env                  # see what would change
lynkr init --force                      # apply when ready
```

---

## Non-interactive setups

The wizard requires a TTY. For containers, CI, and provisioning systems:

1. Run `lynkr init` once on a workstation with a TTY.
2. Commit (or vault) the resulting `.env`.
3. Ship that file through your provisioning channel.

Long-term we may add `--profile=<name>` for non-interactive defaults; today
the wizard is interactive-only.

---

## Related

- [`wrap-guide.md`](./wrap-guide.md) — `lynkr wrap <target>` end-to-end
- [`intent-window-routing.md`](./intent-window-routing.md) — how the routing
  intelligence options (window size, decay, visible badge) actually behave
- [`oauth-subscription-routing.md`](./oauth-subscription-routing.md) — what
  the wrap-mode OAuth passthrough does under the hood
