# [HIGH] Session collision and takeover via Authorization-as-session-id with hardcoded fallback

**File:** [`src/api/openai-router.js`](https://github.com/Fast-Editor/Lynkr/blob/feat/parallel-tool-execution/blob/feat/src/api/openai-router.js#L336-L1399) (lines 336, 1399)
**Project:** claude-code
**Severity:** HIGH  •  **Confidence:** high  •  **Slug:** `auth-bypass`

## Owners

**Suggested assignee:** `veerareddyvishal144@gmail.com` _(via last-committer)_

## Finding

Lines 336 and 1399 derive the session ID with `req.headers['x-session-id'] || req.headers['authorization']?.split(' ')[1] || 'openai-session'` (and 'responses-session' on the other path). Two concrete bugs flow from this: (1) Any client that omits both x-session-id and Authorization shares the literal string `openai-session` (or `responses-session`) as their session — meaning all such concurrent users mix their conversation history together via the shared getSession('openai-session') record. (2) Treating Authorization values as session IDs lets an attacker impersonate another user simply by sending `Authorization: Bearer <victim-session-id>` — full conversation hijack and history disclosure with no auth check.

## Recommendation

Generate a per-request session ID via crypto.randomUUID() when none is supplied (the existing sessionMiddleware in src/api/middleware/session.js already does this; reuse req.sessionId here instead of re-extracting). Never derive a session identifier from the Authorization header.

## Recent committers (`git log`)

- Vishal Veera Reddy <veerareddyvishal144@gmail.com> (2026-04-20)
- vishal veerareddy <vishalveera.reddy@servicenow.com> (2026-03-21)
- Vishal Veera Reddy <veerareddyvishal56@gmail.com> (2026-02-22)
