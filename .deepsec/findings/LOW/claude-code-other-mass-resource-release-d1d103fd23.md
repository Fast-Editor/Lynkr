# [LOW] workspace_sandbox_sessions release-all without target id releases every session

**File:** [`src/tools/mcp.js`](https://github.com/Fast-Editor/Lynkr/blob/feat/parallel-tool-execution/blob/feat/src/tools/mcp.js#L42-L48) (lines 42, 43, 44, 45, 46, 47, 48)
**Project:** claude-code
**Severity:** LOW  •  **Confidence:** high  •  **Slug:** `other-mass-resource-release`

## Owners

**Suggested assignee:** `vishalveera.reddy@servicenow.com` _(via last-committer)_

## Finding

When `release: true` is passed to `workspace_sandbox_sessions` (lines 41-50) without a `session_id`, the handler iterates every session in `listSessions()` and calls `releaseSession(session.id)`. There is no per-session authorization or confirmation gate. A prompt-injection attack could destroy all in-flight sandbox sessions, forcing other ongoing tool runs to lose state or fail. This is denial-of-service against multi-tenant sandbox state.

## Recommendation

Require an explicit `session_id` (or an explicit `release_all: true` flag plus operator confirmation) for batch release. Default to releasing only the caller's session by mapping the calling context's session id automatically.

## Recent committers (`git log`)

- vishal veerareddy <vishalveera.reddy@servicenow.com> (2025-12-03)
