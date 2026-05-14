# [MEDIUM] `/dashboard/api/logs` returns raw telemetry rows with no auth and minimal filtering

**File:** [`src/dashboard/api.js`](https://github.com/Fast-Editor/Lynkr/blob/feat/parallel-tool-execution/blob/feat/src/dashboard/api.js#L83-L167) (lines 83, 95, 110, 156, 162, 167)
**Project:** claude-code
**Severity:** MEDIUM  •  **Confidence:** medium  •  **Slug:** `other-info-disclosure`

## Owners

**Suggested assignee:** `vishalveera.reddy@servicenow.com` _(via last-committer)_

## Finding

The `logs` handler (lines 156-168) returns every column of the telemetry table — including provider, tier, latency, error_type, cost_usd, status_code, model — for up to 500 rows per call. There is no authentication on the route (see router.js finding) and no rate limiting on this handler. Combined with the `/api/overview` endpoint (lines 83-112) which leaks the full list of configured providers and the runtime port, an unauthenticated network attacker who reaches the port can enumerate which paid providers are in use, observe error patterns (useful for detecting key revocation, quota exhaustion, etc.), and time their own requests against the proxy.

## Recommendation

Apply auth middleware on the dashboard router, redact provider names in unauthenticated responses, and consider stripping `error_type` / cost fields from `logs` unless the caller is authenticated.

## Recent committers (`git log`)

- vishal veerareddy <vishalveera.reddy@servicenow.com> (2026-05-04)
