# [CRITICAL] Unauthenticated chat completions endpoint enables RCE via server-side tool execution

**File:** [`src/api/openai-router.js`](https://github.com/Fast-Editor/Lynkr/blob/feat/parallel-tool-execution/blob/feat/src/api/openai-router.js#L334) (lines 334)
**Project:** claude-code
**Severity:** CRITICAL  •  **Confidence:** high  •  **Slug:** `missing-auth`

## Owners

**Suggested assignee:** `veerareddyvishal144@gmail.com` _(via last-committer)_

## Finding

POST /v1/chat/completions (line 334) accepts requests with no authentication and routes them through orchestrator.processMessage(), which runs an agent loop with server-side tools registered at startup (registerExecutionTools → registerShellTool in src/tools/execution.js). The shell tool spawns `bash -lc <command>` directly. The server binds to 0.0.0.0 (src/server.js:215 — `app.listen(config.port)` with no host arg, despite the misleading console.log saying 'localhost'), and the README explicitly documents ngrok/Cloudflare Tunnel exposure. There is no API key check, no bearer-token validation, and no allowlist — the only middleware is sessionMiddleware (which auto-mints session IDs) and a rate limiter that is NOT applied here (the rate limiter on src/api/router.js:229 is on /v1/messages, NOT on /v1/chat/completions). Any unauthenticated network attacker who can reach the server can ask the model to execute arbitrary shell commands.

## Recommendation

Add an authentication middleware (API key, bearer token, or mTLS) before the orchestrator can be reached. At minimum gate any tool-executing path behind an explicit allowlist of session IDs or API keys. Bind to 127.0.0.1 by default and require explicit opt-in to bind to 0.0.0.0.

## Recent committers (`git log`)

- Vishal Veera Reddy <veerareddyvishal144@gmail.com> (2026-04-20)
- vishal veerareddy <vishalveera.reddy@servicenow.com> (2026-03-21)
- Vishal Veera Reddy <veerareddyvishal56@gmail.com> (2026-02-22)
