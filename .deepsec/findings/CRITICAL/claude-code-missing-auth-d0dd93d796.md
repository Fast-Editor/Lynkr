# [CRITICAL] Unauthenticated /v1/messages endpoint enables RCE via tool execution

**File:** [`src/api/router.js`](https://github.com/Fast-Editor/Lynkr/blob/feat/parallel-tool-execution/blob/feat/src/api/router.js#L229) (lines 229)
**Project:** claude-code
**Severity:** CRITICAL  •  **Confidence:** high  •  **Slug:** `missing-auth`

## Owners

**Suggested assignee:** `vishalveera.reddy@servicenow.com` _(via last-committer)_

## Finding

POST /v1/messages (line 229) is the primary Anthropic-compatible endpoint and routes through processMessage() which invokes the agent loop with server-side tools (shell, edit, write, etc.). The route has rateLimiter applied but no authentication middleware. Any client reaching the server can drive an LLM to execute shell commands on the host. Same exposure surface as /v1/chat/completions, with the additional concern that this is the documented Anthropic-API endpoint — so the impact extends to anyone who points Claude Code, Cursor, or similar tools at a publicly-reachable Lynkr instance.

## Recommendation

Add explicit auth middleware (bearer token validation against an allowlist) before the orchestrator. At a minimum, refuse to bind to non-loopback interfaces unless an API key is configured.

## Recent committers (`git log`)

- vishal veerareddy <vishalveera.reddy@servicenow.com> (2026-04-28)
- Vishal Veera Reddy <veerareddyvishal144@gmail.com> (2026-04-20)
- Vishal Veera Reddy <veerareddyvishal56@gmail.com> (2026-02-22)
