# [HIGH] Session lookup accepts client-supplied ID with no authentication or ownership check

**File:** [`src/api/middleware/session.js`](https://github.com/Fast-Editor/Lynkr/blob/feat/parallel-tool-execution/blob/feat/src/api/middleware/session.js#L19-L61) (lines 19, 20, 23, 28, 35, 40, 61)
**Project:** claude-code
**Severity:** HIGH  •  **Confidence:** high  •  **Slug:** `missing-auth`

## Owners

**Suggested assignee:** `veerareddyvishal56@gmail.com` _(via last-committer)_

## Finding

extractSessionId() accepts a session ID from any of: the x-session-id header, four fallback headers (x-claude-session-id, x-claude-session, x-claude-conversation-id, anthropic-session-id), or three body fields (session_id, sessionId, conversation_id). The supplied ID is then passed directly to getOrCreateSession(sessionId), which loads the full session record (id, created_at, updated_at, metadata) plus the last 50 history rows from the DB. There is no ownership check tying the session to an authenticated identity, and the entire server stack (verified by reading server.js) has no authentication middleware at all — the chain is loadShedding → requestLogging → metrics → express.json → sessionMiddleware → logging → router. Combined with the explicit ngrok/Cloudflare-Tunnel exposure comment in server.js (line 82) and the fact that app.listen(config.port) defaults to binding 0.0.0.0, any attacker who learns a session ID (via shared logs, error messages, network capture, or referer leaks) can read another user's full conversation history and continue writing to their session. Even when the session ID is auto-generated as a UUID v4, headers like X-Request-ID and other logs frequently include identifiers that may surface session IDs in mixed environments.

## Recommendation

Require an authenticated principal (API key, OAuth token, mTLS) before this middleware runs. Bind sessions to that principal at creation time, persist the owner_id in the sessions table, and in getOrCreateSession reject lookups whose stored owner_id does not match the authenticated identity. Stop accepting session IDs from the request body — body fields are easily tampered with and are not part of the standard session-routing contract. Treat session IDs as opaque routing keys, not as bearer credentials.

## Recent committers (`git log`)

- Vishal Veera Reddy <veerareddyvishal56@gmail.com> (2026-02-22)
- MichaelAnders <developer@call-home.ch> (2026-01-31)
- vishal veerareddy <vishalveera.reddy@servicenow.com> (2025-12-03)
