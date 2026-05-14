# [MEDIUM] Pino redaction list misses common credential locations

**File:** [`src/logger/index.js`](https://github.com/Fast-Editor/Lynkr/blob/feat/parallel-tool-execution/blob/feat/src/logger/index.js#L106-L109) (lines 106, 107, 108, 109)
**Project:** claude-code
**Severity:** MEDIUM  •  **Confidence:** medium  •  **Slug:** `other-info-disclosure`

## Owners

**Suggested assignee:** `veerareddyvishal56@gmail.com` _(via last-committer)_

## Finding

The redact configuration (lines 106-109) only scrubs `req.headers.authorization` and `req.headers.cookie`. In this codebase, request logging in `src/api/middleware/request-logging.js` lines 29-39 logs `req.query` verbatim and the request `path`/`url` — both of which routinely carry tokens (e.g., `?api_key=...`, `?token=...`, OAuth callbacks with `?code=...&state=...`, signed S3 URLs). Many integrations also pass tokens through custom headers (`x-api-key`, `x-auth-token`) or in request bodies — none of which are redacted.

Because the same pino logger feeds the file-rotation stream and the oversized-error stream, any leaked secret persists to disk in multiple places. With `pino-roll` and the oversized error stream, retention is configurable but logs can still survive for long periods, and if shipped to a centralized log system the secret is duplicated to every downstream consumer.

## Recommendation

Expand `redact.paths` to cover common credential surfaces: at minimum `req.headers['x-api-key']`, `req.headers['x-auth-token']`, `req.headers['x-session-id']` (treat as PII even if not auth), `req.query.api_key`, `req.query.token`, `req.query.access_token`, `req.query.code`, `req.body.password`, `req.body.api_key`, `req.body.token`. Better: configure pino with `redact.paths` matching wildcards (`req.headers.*authorization*`, `*.password`, `*.token`, `*.api_key`, `*.secret`) using pino's `redact` glob syntax. Also redact `req.url` if you keep query strings in path logs (`req.path` is preferred over `req.url`).

## Recent committers (`git log`)

- Vishal Veera Reddy <veerareddyvishal56@gmail.com> (2026-02-22)
- MichaelAnders <developer@call-home.ch> (2026-01-31)
- vishal veerareddy <vishalveera.reddy@servicenow.com> (2025-12-03)
