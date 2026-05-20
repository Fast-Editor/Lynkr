# [HIGH] Unauthenticated /admin/reload allows arbitrary clients to hot-reload server config

**File:** [`src/api/providers-handler.js`](https://github.com/Fast-Editor/Lynkr/blob/feat/parallel-tool-execution/blob/feat/src/api/providers-handler.js#L596) (lines 596)
**Project:** claude-code
**Severity:** HIGH  •  **Confidence:** high  •  **Slug:** `missing-auth`

## Owners

**Suggested assignee:** `vishalveera.reddy@servicenow.com` _(via last-committer)_

## Finding

POST /admin/reload (line 596) calls config.reloadConfig() with no authentication. An attacker on the network (or via a tunnel) can repeatedly trigger config reloads. If the operator's .env is writable through any other means (e.g., separate file-upload endpoint, mounted volume, sibling process), this becomes a primitive for in-process credential rotation. Even without a write primitive, repeated reloads can be used as a DoS vector and timing oracle to detect when the operator updates secrets. The endpoint advertises itself with `object: 'admin_reload'` and full circuit-breaker state — strongly implying it should be admin-protected.

## Recommendation

Require an admin token for /admin/* endpoints. Prefer binding admin endpoints to loopback only (separate listener/port) instead of mixing them into the public router.

## Recent committers (`git log`)

- vishal veerareddy <vishalveera.reddy@servicenow.com> (2026-04-15)
- Vishal Veera Reddy <veerareddyvishal56@gmail.com> (2026-02-22)
