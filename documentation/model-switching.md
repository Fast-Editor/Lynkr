# Switching Models and Seeing Which One Served

Lynkr picks a model for every request from the four tiers you configure
(`TIER_SIMPLE`, `TIER_MEDIUM`, `TIER_COMPLEX`, `TIER_REASONING`). This page
answers the everyday questions about that choice:

- [How do I switch model from my client?](#switch-model-from-your-client)
- [How do I see which model answered?](#see-which-model-served-a-request)
- [How do I change the routing rules?](#change-the-routing-rules)
- [How do I use a different model for each CLI?](#a-different-model-for-each-cli)

Picking a tier needs tier routing enabled, i.e. all four `TIER_*`
variables set (see [Routing & Model Tiering](routing.md)).

---

## Switch Model From Your Client

By default every request is scored and sent to the tier that fits it. To
choose the tier yourself, set the client's model to one of Lynkr's tier ids:

| Model id | Served by |
|---|---|
| `lynkr-auto` | Automatic, content-based routing (the default behaviour) |
| `lynkr-simple` | `TIER_SIMPLE` |
| `lynkr-medium` | `TIER_MEDIUM` |
| `lynkr-complex` | `TIER_COMPLEX` |
| `lynkr-reasoning` | `TIER_REASONING` |

The ids work on every endpoint (`/v1/messages`, `/v1/chat/completions`,
`/v1/responses`), so the same trick works in any client that lets you type a
model name:

| Client | How to pick a tier |
|---|---|
| Claude Code | `claude --model lynkr-reasoning`, `/model lynkr-simple` inside a session, or `export ANTHROPIC_MODEL=lynkr-complex` |
| opencode | `lynkr run opencode` writes the five entries; pick one in opencode's model picker ([details](opencode.md)) |
| Codex CLI | `model = "lynkr-medium"` in `~/.codex/config.toml`, or `codex -m lynkr-medium` ([details](codex-cli.md#pinning-a-routing-tier)) |
| Cline, Continue, Kilo Code, curl, SDKs | Use `lynkr-*` as the model name of the OpenAI-compatible provider |
| Claude Desktop | Its model picker is mapped to tiers ([details](claude-desktop.md)) |
| Codex Desktop | The model + effort picker is mapped to tiers ([details](tier-pinning.md)) |

Switch back to automatic routing with `lynkr-auto`.

A tier pin selects the **tier**, and the tier's model comes from your
`TIER_*` configuration. On `/v1/messages` (Claude Code, opencode) a few
explicit signals still override the pin for that one request: force phrases
such as `ultrathink` or `security audit`, high-risk edits, and a follow-up
that scores clearly above the pinned tier. See
[Tier Pinning](tier-pinning.md#scope-and-caveats) for the full scope.

---

## See Which Model Served a Request

**Status line (Claude Code).** One line under the prompt after every turn,
with no token cost. Add to `~/.claude/settings.json`:

```json
"statusLine": { "type": "command", "command": "lynkr-statusline" }
```

```
◆ Opus 4.8 · MEDIUM → minimax-m3:cloud (ollama) · today $0.06 · cache 67%
```

**Badge in the reply (any client).** Set `LYNKR_VISIBLE_ROUTING=true` and
every reply starts with the tier, model and provider that served it:

```
*[Lynkr] COMPLEX → GLM-4.7 (zai) · score 58*
```

**Response headers.** Anthropic-format responses (`/v1/messages`) carry
`X-Lynkr-Tier`, `X-Lynkr-Model` and `X-Lynkr-Provider` (full list in
[Routing Headers](routing.md#routing-headers)); non-streaming
`/v1/chat/completions` responses carry `X-Lynkr-Routed-Model` and
`X-Lynkr-Routed-Provider`:

```bash
curl -si http://localhost:8081/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: dummy" \
  -H "anthropic-version: 2023-06-01" \
  -d '{"model":"lynkr-auto","max_tokens":64,"messages":[{"role":"user","content":"hi"}]}' \
  | grep -i '^x-lynkr'
```

**Dashboard.** `http://localhost:8081/dashboard` shows recent requests,
spend and routing decisions per tier, model and provider.

**Dry run.** `lynkr route --preview` explains how a request *would* route
(every signal, the chosen tier and model) without calling a provider:

```bash
echo '{"messages":[{"role":"user","content":"rename this variable"}]}' \
  | lynkr route --preview -
```

---

## Change the Routing Rules

- **Which model a tier uses** — edit the `TIER_*` lines in `.env`. The file
  in the directory Lynkr was started from is watched and reloaded on save,
  so no restart is needed (disable with `HOT_RELOAD_ENABLED=false`):

  ```bash
  TIER_SIMPLE=ollama:qwen2.5-coder:7b
  TIER_MEDIUM=openai:gpt-4o-mini
  TIER_COMPLEX=zai:GLM-4.7
  TIER_REASONING=openrouter:anthropic/claude-opus-4.1
  ```

- **Which phrases force a tier** — see [Force Patterns](routing.md#force-patterns).
- **How requests are scored** — see [Routing & Model Tiering](routing.md)
  for the scoring modes, thresholds and the tier config file.

---

## A Different Model for Each CLI

Give each client its own tier id, and point those tiers at the models you
want. For example, Claude Code on a local Ollama model and opencode on GLM:

```bash
# .env
# SIMPLE → Claude Code, COMPLEX → opencode
TIER_SIMPLE=ollama:qwen2.5-coder:7b
TIER_MEDIUM=openai:gpt-4o-mini
TIER_COMPLEX=zai:GLM-4.7
TIER_REASONING=openrouter:anthropic/claude-opus-4.1
ZAI_API_KEY=your-zai-api-key
```

```bash
# Claude Code: pinned to the SIMPLE tier (Ollama)
ANTHROPIC_MODEL=lynkr-simple claude

# opencode: pick "lynkr-complex" in the model picker (GLM)
lynkr run opencode
```

Keep in mind:

- There are four tiers, so up to four clients can each have a model of
  their own; clients pinned to the same tier share its model.
- Changing a `TIER_*` line changes the model for every client pinned to that
  tier, and for automatic routing too.
- Clients set to `lynkr-auto` keep full automatic routing across all four
  tiers.
- On `/v1/messages` the overrides described in
  [Switch Model From Your Client](#switch-model-from-your-client) still
  apply, so an `ultrathink` turn from a client pinned to SIMPLE goes to the
  REASONING tier for that request.
