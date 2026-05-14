# [MEDIUM] Raw err.message returned for unhandled 500-class errors leaks internal details

**File:** [`src/api/middleware/error-handling.js`](https://github.com/Fast-Editor/Lynkr/blob/feat/parallel-tool-execution/blob/feat/src/api/middleware/error-handling.js#L87-L125) (lines 87, 117, 121, 122, 123, 124, 125)
**Project:** claude-code
**Severity:** MEDIUM  •  **Confidence:** high  •  **Slug:** `other-info-disclosure`

## Owners

**Suggested assignee:** `vishalveera.reddy@servicenow.com` _(via last-committer)_

## Finding

errorHandlingMiddleware builds the response body with `message: err.message || 'An unexpected error occurred'` (line 124) and applies this uniformly to all errors regardless of whether the error is operational. The isOperational distinction (line 87) only changes the log level, not the response. As a result, when an unhandled exception escapes a handler — e.g., a better-sqlite3 SQLITE_* error, an fs ENOENT containing an absolute path like '/Users/.../db/sessions.db', a JSON.parse SyntaxError including a snippet of internal payload, an Anthropic/Databricks SDK error containing internal endpoint URLs, or any third-party library error — the raw message is echoed to the client in the JSON body alongside the request ID. Combined with the unauthenticated server (no auth middleware in server.js), an attacker can probe endpoints to harvest internal file paths, schema names, dependency identifiers, and upstream service URLs. The development-only stack-trace branch on line 135 mitigates the worst leakage, but err.message itself is leaked in every environment.

## Recommendation

Distinguish the response based on isOperational (or statusCode >= 500). For non-operational / 500-class errors, return a generic message such as `An unexpected error occurred — see request id ${req.requestId}` and log the full err.message + stack server-side. Only echo err.message for operational AppError subclasses (BadRequestError, UnauthorizedError, etc.) where the message is intentionally crafted for clients.

## Recent committers (`git log`)

- vishal veerareddy <vishalveera.reddy@servicenow.com> (2025-12-07)
