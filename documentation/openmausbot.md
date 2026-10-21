# OpenMausBot Integration

Run [OpenMausBot](https://github.com/milind-soni/OpenMausBot) bots on any
provider Lynkr routes to. OpenMausBot ships an `openai-compat` engine that
speaks `/v1/chat/completions` directly (streaming, structured tool calls,
reasoning content, images), so no CLI sits in between: the app talks to
Lynkr, Lynkr tier-routes to your providers.

## Setup

1. Start Lynkr as usual (default `http://127.0.0.1:8081`).
2. Add Lynkr as an engine. Either run the headless command against a running
   OpenMausBot workspace:

   ```bash
   export LYNKR_API_KEY=sk-lynkr   # Lynkr ignores the value; the driver needs one
   openmausbot engine set openai-compatible --key-env LYNKR_API_KEY --base-url http://127.0.0.1:8081/v1
   openmausbot engine list
   ```

   or, with the app stopped, add an instance to `~/.openmausbot/config.json`:

   ```json
   {
     "instances": {
       "lynkr": {
         "driver": "openai-compat",
         "displayName": "Lynkr",
         "environment": { "LYNKR_API_KEY": "sk-lynkr" },
         "config": {
           "url": "http://127.0.0.1:8081/v1",
           "apiKeyEnv": "LYNKR_API_KEY",
           "model": "lynkr-auto"
         }
       }
     }
   }
   ```

3. Pick a model in the bot's model picker. The driver lists Lynkr's
   `/v1/models`; `lynkr-auto` keeps full content routing, `lynkr-simple` …
   `lynkr-reasoning` pin a tier (see [tier-pinning.md](tier-pinning.md)).

Why not the Claude engine? OpenMausBot's `claude` engine spawns Claude Code
and would also work via `ANTHROPIC_BASE_URL`, but that brings Claude Code's
own agent loop and file/shell tools into a messaging bot. The
`openai-compat` route is the natural fit and is what Lynkr's `openmausbot`
client profile is written for.

## What Lynkr does for OpenMausBot traffic

OpenMausBot sends only `authorization` and `content-type` headers — no
`user-agent`, no `x-client` — and it omits the `tools` key entirely when a
bot has no tools. Lynkr's `openmausbot` client profile
(`src/routing/client-profiles.js`) handles both:

- **No tool injection.** Lynkr's OpenAI-compat routers inject their
  IDE_SAFE_TOOLS only for coding harnesses they have a tool mapping for
  (Codex, Cline, Kilo, Continue). Every other tool-less request, OpenMausBot's
  included, is forwarded exactly as sent. OpenMausBot executes only the tools
  it sent, so an injected `Read`/`Bash` call would have come back to the app
  as a failed turn. As a second guard the profile carries
  `injectTools: false`, and both routes run client detection *before*
  injection so the veto applies even if a mapping is ever added.
- **Baseline subtraction.** The app's own loadout (`ask_user` plus the
  built-in `agents_*` MCP tools) is named as the baseline, so the agentic
  detector scores only the connectors and MCP servers you actually gave the
  bot, not the harness.
- **No tool-result compression.** Lynkr's RTK-style compressor rewrites
  large tool results (test, git, lint, JSON output) into summaries for coding
  agents that can re-run the command. OpenMausBot's tool results are the data
  itself, and the app appends its own paging notice (a saved result id and
  offset for `agents_tool_result_read`) to oversized results; compressing
  them deleted that notice and failed the turn. The profile carries
  `compressToolResults: false`, so the orchestrator leaves this client's
  tool results intact while `TOOL_RESULT_COMPRESSION_ENABLED` stays on for
  everyone else.

### How Lynkr recognises the app

In order: `user-agent`, then `x-client` / `x-client-name`, then a prompt
marker, then the tool fingerprint.

| Signal | OpenMausBot 0.1.x | Notes |
|---|---|---|
| `user-agent: openmausbot/…` | not sent | Upstream change requested; the pattern is in place for it. |
| `x-client: openmausbot` | not sent | Set it on a reverse proxy in front of Lynkr to make detection deterministic today. |
| "Context from OpenMausBot updated since…" in the user turn | sometimes | Only when the app's volatile context changed. |
| Tool fingerprint (≥ 50% of the `agents_*` baseline) | yes, when the agents server is mounted | Bots without the agents server send only `ask_user` and are not matched — with tools present there is nothing to inject or subtract. |

A bot with *no* tools and *no* identifying header has nothing Lynkr can
fingerprint, so it is simply treated as an unrecognised client. That is
safe: unrecognised tool-less requests are never injected into. Recognition
still matters for routing (baseline subtraction), so a `user-agent` from
OpenMausBot, or `x-client: openmausbot` set at a proxy in front of Lynkr,
remains worthwhile.

### Adjusting the profile without a code change

Create `data/client-profiles.json` next to your `.env`. Any key you omit
keeps the shipped value, so updating the baseline for a newer OpenMausBot
release does not drop the injection veto:

```json
{
  "openmausbot": {
    "baselineTools": ["ask_user", "agents_memory_update", "agents_memory_log", "agents_session_search"]
  },
  "my-own-app": {
    "headerPatterns": ["my-own-app/"],
    "injectTools": false
  }
}
```

Supported keys per profile: `baselineTools`, `headerPatterns`,
`promptPatterns`, `minToolFingerprintMatch`, `toolless`, `injectTools`,
`compressToolResults`.

## Verify

Send a bot a message, then check Lynkr's log for the routing decision and
one of `TOOLS NOT INJECTED — no tool mapping for this client` (tool-less
bot, unrecognised), `TOOLS NOT INJECTED — client profile executes only the
tools it sent` (tool-less bot, recognised), or the bot's own tool names
passing through.
`lynkr usage` shows the spend and tier savings per request.
