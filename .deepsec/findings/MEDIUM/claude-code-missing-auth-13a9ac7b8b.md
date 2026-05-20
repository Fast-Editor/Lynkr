# [MEDIUM] Unauthenticated headroom service control endpoints

**File:** [`src/api/router.js`](https://github.com/Fast-Editor/Lynkr/blob/feat/parallel-tool-execution/blob/feat/src/api/router.js#L820-L875) (lines 820, 853, 864, 875)
**Project:** claude-code
**Severity:** MEDIUM  •  **Confidence:** high  •  **Slug:** `missing-auth`

## Owners

**Suggested assignee:** `vishalveera.reddy@servicenow.com` _(via last-committer)_

## Finding

POST /headroom/restart (line 864) lets any client restart the Headroom sidecar service. GET /headroom/logs (line 875) returns logs (which may include sensitive configuration or request metadata). GET /headroom/status (line 853) and /metrics/compression (line 820) expose service internals.

## Recommendation

Require an admin token (or local-loopback-only) for all /headroom/* and /admin/* routes. Treat these as administrative APIs.

## Recent committers (`git log`)

- vishal veerareddy <vishalveera.reddy@servicenow.com> (2026-04-28)
- Vishal Veera Reddy <veerareddyvishal144@gmail.com> (2026-04-20)
- Vishal Veera Reddy <veerareddyvishal56@gmail.com> (2026-02-22)
