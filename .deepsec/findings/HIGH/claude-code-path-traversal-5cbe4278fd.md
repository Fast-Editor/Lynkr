# [HIGH] Path traversal in oversized error log filenames via user-controlled session/request IDs

**File:** [`src/logger/oversized-error-stream.js`](https://github.com/Fast-Editor/Lynkr/blob/feat/parallel-tool-execution/blob/feat/src/logger/oversized-error-stream.js#L132-L173) (lines 132, 134, 137, 140, 143, 153, 169, 172, 173)
**Project:** claude-code
**Severity:** HIGH  •  **Confidence:** high  •  **Slug:** `path-traversal`

## Owners

**Suggested assignee:** `developer@call-home.ch` _(via last-committer)_

## Finding

The `getSessionFile` function constructs a file path using string interpolation of `sessionId` directly into the filename: `const filename = `${sessionId}_${timestamp}.log`; const filepath = path.join(logDir, filename);` (lines 172-173). The `sessionId` comes from `extractSessionId(logObject)` (lines 132-144), which pulls values from `logObject.sessionId`, `logObject.correlationId`, or `logObject.requestId` — none of which are sanitized.

Tracing the data flow: `src/api/middleware/session.js` (lines 19-38) sets `req.sessionId` from headers `x-session-id`, `x-claude-session-id`, `x-claude-session`, `x-claude-conversation-id`, `anthropic-session-id`, or body fields `session_id`/`sessionId`/`conversation_id`. The only normalisation is `value.trim()` — no path-character validation. Similarly, `src/api/middleware/request-logging.js:22` sets `req.requestId = req.headers['x-request-id']` with zero validation. These IDs are propagated to log lines via `req.log = logger.child({ sessionId })` and explicit `{ requestId }` log fields (e.g., `error-handling.js` lines 91-114).

`path.join('/var/log/oversized', '../../tmp/evil_2026_05_05_xx.log')` resolves to `/var/tmp/evil_2026_05_05_xx.log`, escaping the configured log directory.

Exploit: an attacker sends a request with `X-Request-ID: ../../../tmp/pwn` (or `X-Session-Id: ../../../tmp/pwn`) plus an input that causes a 500 error. The error handler logs the stack trace, the entry exceeds the 200-char threshold, the oversized error stream fires, and the attacker-chosen path is used to create/append to a `.log` file outside `logDir`. Consequences include arbitrary `.log` file creation/append anywhere the process can write (e.g., `/tmp`, user home dirs, mounted volumes), corruption of unrelated `.log` files, disk-space exhaustion at unusual locations bypassing log rotation, and — if the process runs with elevated privileges — overwriting/appending to sensitive locations. Because content is partially attacker-influenced JSON log data, this can also be combined with file-format quirks to weaponize specific targets (e.g., appending to logrotate-watched paths).

## Recommendation

Sanitize the session identifier before using it in a filename. Two safe options: (1) Replace any non-allowlisted character: `const safeId = String(sessionId).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);` Then assert `if (safeId !== sessionId) { ... }` or just always use `safeId`. (2) Use `path.basename(sessionId)` AND verify the resulting `filepath` resolves under `logDir` with `path.resolve(filepath).startsWith(path.resolve(logDir) + path.sep)`. Apply the same fix in `src/api/middleware/session.js` `normaliseSessionId` and in `src/api/middleware/request-logging.js` for the `x-request-id` header to prevent these untrusted IDs from being trusted elsewhere.

## Recent committers (`git log`)

- MichaelAnders <developer@call-home.ch> (2026-01-31)
- Vishal Veera Reddy <veerareddyvishal56@gmail.com> (2026-01-26)
