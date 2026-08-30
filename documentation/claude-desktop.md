# Claude Desktop Integration

This guide explains how to route the **Claude Desktop app** (macOS) through Lynkr so its conversations use your configured providers (local models, Azure OpenAI, Bedrock, Databricks, etc.) instead of talking to `api.anthropic.com` directly.

---

## Overview

Claude Desktop has an undocumented "third-party gateway" mode (the same mechanism [Ollama's `claude-desktop` launcher](https://github.com/ollama/ollama) uses) that redirects its Anthropic Messages API traffic to a local URL instead of Anthropic's servers. Lynkr already speaks that API on `/v1/messages`, so pointing Desktop at Lynkr gets you:

- **Local models** (Ollama, llama.cpp, LM Studio) for free, private conversations
- **Enterprise providers** (Azure OpenAI, Bedrock, Databricks) behind the same Desktop UI
- Lynkr's **tier routing**, **token optimization**, and **caching**
- A **model picker that doubles as a tier selector** (see [Model Picker](#model-picker--tier-selector) below)

This is macOS-only — the mechanism was reverse-engineered from Desktop's own config files, which only exist in that form on macOS.

---

## Quick Start

```bash
# 1. Make sure Lynkr is running
cd /path/to/lynkr && npm start

# 2. Mint a Claude Pro/Max OAuth token (one-time, interactive browser approval)
claude setup-token

# 3. Install it into Desktop's gateway profile
lynkr desktop-token sk-ant-oat01-...

# 4. Relaunch Desktop (not automatic — this would close open chats)
killall Claude && open -a Claude
```

Desktop's chat traffic now flows through Lynkr. Check any response for the `*[Lynkr] TIER → provider (model)*` badge Lynkr injects to confirm.

### Undoing it

```bash
lynkr desktop-token --restore
killall Claude && open -a Claude
```

Puts Desktop's deployment mode and profile registry back to what they were before, and removes the installed profile + backup files. Safe to run even if nothing was ever installed.

---

## Why a token is needed

In its normal mode, Desktop manages its own Anthropic login and never needs anything from you. Once redirected to Lynkr's gateway (deploymentMode `"3p"`), Desktop no longer talks to Anthropic at all — **Lynkr** does, on Desktop's behalf, whenever a conversation routes to the OAuth-subscription tier. That's the `sk-ant-oat...` access token `lynkr desktop-token` installs: it becomes the bearer key Desktop sends Lynkr, which Lynkr forwards to Anthropic for subscription-tier requests. It is *not* minted or refreshed by Lynkr — re-run `claude setup-token` yourself whenever it expires (Anthropic calls will start 401ing) and reinstall with `lynkr desktop-token <new token>`.

Requests that don't route to the subscription tier (local models, Azure, Bedrock, etc.) don't need this token to be valid — but Desktop still requires *some* bearer value to be configured before it'll use the gateway at all.

---

## What actually gets changed

`lynkr desktop-token` / `scripts/claude-desktop.js` edit three JSON files under `~/Library/Application Support/`:

| File | Purpose |
|------|---------|
| `Claude/claude_desktop_config.json` | `deploymentMode: "1p"` (stock) or `"3p"` (gateway) |
| `Claude-3p/claude_desktop_config.json` | Same flag, third-party profile root |
| `Claude-3p/configLibrary/_meta.json` | Profile registry — which profile id is applied |
| `Claude-3p/configLibrary/<uuid>.json` | The Lynkr profile itself: gateway URL, bearer key, display name |

A first install also writes `Claude-3p/configLibrary/.lynkr-backup.json` — whatever `deploymentMode`/`appliedId` existed *before* Lynkr touched anything, so `--restore` puts it back exactly rather than just guessing `"1p"`.

None of this touches Lynkr's own `.env` or `TIER_*` settings, and neither install nor restore quits/relaunches Desktop automatically — both print the `killall Claude && open -a Claude` command instead, since that would otherwise close your open chat windows without warning.

Check current state anytime:

```bash
node scripts/claude-desktop.js --status
```

```
deploymentMode: 3p
Lynkr profile installed: true
Lynkr profile applied: true
gateway URL: http://127.0.0.1:8081

Claude Desktop is routed through Lynkr.
```

---

## Model Picker → Tier Selector

Desktop's model dropdown lists whatever `GET /v1/messages` (with an `anthropic-version` header, which Desktop always sends) returns from `src/api/claude-desktop-gateway.js`. Lynkr advertises five fixed entries — Desktop validates model ids against its own known catalog, so these reuse real Claude family names rather than inventing ids like `lynkr-simple`:

| Desktop picker entry | Pins tier | Notes |
|---|---|---|
| Lynkr Auto (`claude-fable-5`) | — (no pin) | Falls through to normal content-based scoring |
| `claude-opus-5` | REASONING | |
| `claude-sonnet-5` | COMPLEX | |
| `claude-sonnet-4-6` | MEDIUM | |
| `claude-haiku-4-5-20251001` | SIMPLE | |

Picking anything other than "Lynkr Auto" **pins** that tier explicitly — Lynkr skips content scoring entirely for that request (`src/api/router.js`'s model-id-pin check, source: `src/routing/model-slots.js`). Tiers left unset in `.env` are skipped from the list; if that leaves a family with no default, the first surviving entry of that family is promoted so the picker always has a selectable default.

The list is dynamic — labels for non-default entries show the actual configured model, e.g. `Lynkr MEDIUM (gpt-5.6-sol)`, pulled live from `config.modelTiers`.

Disable the picker (fall back to whatever Desktop's default model list would otherwise be) with:

```bash
CLAUDE_DESKTOP_GATEWAY=0
```

Adjust the advertised `max_tokens` per model entry (default 32768) with:

```bash
CLAUDE_DESKTOP_GATEWAY_MAX_TOKENS=65536
```

---

## Detection & Gating

The gateway model list only intercepts callers that look like Desktop specifically — anything sending an `anthropic-version` header, or an explicit `?format=anthropic` query param. Everything else (Claude Code CLI, curl, other Anthropic-format clients hitting the same `/v1/messages` route) falls through to the normal OpenAI-format model list from `src/api/openai-router.js` untouched.

Separately, `src/routing/client-profiles.js`'s `detectClient()` recognizes Desktop by the same `claude-cli/` user-agent family Claude Code CLI uses (Desktop and the CLI share a base client library) — this is what lets Lynkr apply Desktop-appropriate behavior (like tool-loadout expectations) without the model-picker gating above being involved at all.

---

## Troubleshooting

| Issue | Cause | Solution |
|---|---|---|
| Desktop doesn't show the Lynkr model entries | Gateway intercept didn't fire | Confirm `deploymentMode: "3p"` via `--status`; confirm `CLAUDE_DESKTOP_GATEWAY` isn't set to `0` |
| Model list shows "hasn't loaded" | An unrecognized/invented model id was advertised | Only use ids from `MODEL_SLOTS` (`src/routing/model-slots.js`) — Desktop validates against its own fixed catalog |
| 401s after a while | The installed OAuth token expired | `claude setup-token`, then `lynkr desktop-token <new token>` |
| Changes don't take effect | Desktop caches its config at launch | `killall Claude && open -a Claude` after any install/restore |
| Web search / web fetch tool calls fail | Desktop is a client Lynkr doesn't have a native profile for on some paths | See `src/tools/web-search-exec.js` — Lynkr can auto-resolve `web_search`/`web_fetch` server-side for unrecognized-client traffic |
| Caveman/brevity mode behaving oddly | `CAVEMAN_ENABLED` state stale in a long-running process | `.env` changes need `lynkr restart` (or a fresh `npm run dev` boot) to take effect — Node doesn't hot-reload `.env` |
| Connection refused | Lynkr not running, or wrong port in the installed profile | `npm start` in the Lynkr directory; re-run `lynkr desktop-token` if the port changed |

---

## Related Documentation

- **[Claude Code CLI Setup](claude-code-cli.md)** — the terminal counterpart; shares the `claude-cli/` user-agent family with Desktop
- **[Codex CLI Setup](codex-cli.md)** — same third-party-gateway concept, for OpenAI's Codex CLI/Desktop instead
- **[Routing & Model Tiering](routing.md)** — how tier scoring and pins work generally
- **[Troubleshooting Guide](troubleshooting.md)** — issues not specific to Desktop

---

**Need help?** Visit [GitHub Discussions](https://github.com/Fast-Editor/Lynkr/discussions) or check the [FAQ](faq.md).
