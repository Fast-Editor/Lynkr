# [HIGH] Dashboard and its API endpoints have no authentication

**File:** [`public/dashboard.html`](https://github.com/Fast-Editor/Lynkr/blob/feat/parallel-tool-execution/blob/feat/public/dashboard.html#L191-L199) (lines 191, 192, 193, 194, 199)
**Project:** claude-code
**Severity:** HIGH  •  **Confidence:** high  •  **Slug:** `missing-auth`

## Owners

**Suggested assignee:** `vishalveera.reddy@servicenow.com` _(via last-committer)_

## Finding

The dashboard router (src/dashboard/router.js) is mounted at `/dashboard` in src/server.js:151 with no authentication middleware in front of it. The four data endpoints — `/dashboard/api/overview`, `/dashboard/api/usage`, `/dashboard/api/routing`, `/dashboard/api/logs` — directly query telemetry and config and return them as JSON. There is no `x-api-key`, bearer-token, or session-cookie check anywhere in the dashboard or main server middleware chain (verified by grepping the `src/api/middleware/` directory for auth tokens — none present). Combined with `app.listen(config.port)` in src/server.js:215 (no host argument), Node defaults to binding all interfaces (`0.0.0.0`), so the dashboard is reachable from anywhere on the local network. The dashboard.html client (lines 191-199) fetches and renders: configured LLM providers (with their types), full request logs (timestamps, providers, models, tiers, latencies, status codes, error types, per-request costs, fallback flags), per-day usage breakdowns, routing accuracy and circuit-breaker state. This is sensitive operational data — it leaks which paid LLM providers are configured, request volumes, cost data, and request error patterns to anyone who can reach the proxy.

## Recommendation

Add an authentication middleware in front of `app.use('/dashboard', ...)` in src/server.js (e.g., a shared `x-api-key` check or basic auth). Additionally, change `app.listen(config.port)` to `app.listen(config.port, '127.0.0.1')` by default, with explicit opt-in (e.g. `BIND_HOST=0.0.0.0`) to expose externally. The same auth should also be applied to the `/metrics/*` endpoints, which leak similar info.

## Recent committers (`git log`)

- vishal veerareddy <vishalveera.reddy@servicenow.com> (2026-05-04)
