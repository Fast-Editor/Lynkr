# [MEDIUM] IDOR on /api/sessions/:sessionId/tokens

**File:** [`src/api/router.js`](https://github.com/Fast-Editor/Lynkr/blob/feat/parallel-tool-execution/blob/feat/src/api/router.js#L735) (lines 735)
**Project:** claude-code
**Severity:** MEDIUM  •  **Confidence:** high  •  **Slug:** `cross-tenant-id`

## Owners

**Suggested assignee:** `vishalveera.reddy@servicenow.com` _(via last-committer)_

## Finding

Line 735: `getSession(req.params.sessionId)` looks up arbitrary session IDs supplied in the URL path with no ownership verification. Returns turn-by-turn token usage, model used, and cost data. Combined with the predictable/guessable session-id behavior in openai-router.js (clients sharing 'openai-session' or other simple values), an attacker can harvest other users' usage telemetry and coarse conversation metadata.

## Recommendation

Require auth and only return stats for sessions owned by the caller.

## Recent committers (`git log`)

- vishal veerareddy <vishalveera.reddy@servicenow.com> (2026-04-28)
- Vishal Veera Reddy <veerareddyvishal144@gmail.com> (2026-04-20)
- Vishal Veera Reddy <veerareddyvishal56@gmail.com> (2026-02-22)
