# [MEDIUM] Dashboard and dashboard API routes have no authentication and bind to all interfaces

**File:** [`src/dashboard/router.js`](https://github.com/Fast-Editor/Lynkr/blob/feat/parallel-tool-execution/blob/feat/src/dashboard/router.js#L7-L11) (lines 7, 8, 9, 10, 11)
**Project:** claude-code
**Severity:** MEDIUM  •  **Confidence:** medium  •  **Slug:** `missing-auth`

## Owners

**Suggested assignee:** `vishalveera.reddy@servicenow.com` _(via last-committer)_

## Finding

`/dashboard`, `/dashboard/api/overview`, `/dashboard/api/usage`, `/dashboard/api/routing`, and `/dashboard/api/logs` (lines 7-11) are mounted without any auth/authorization middleware. The Express server starts via `app.listen(config.port, …)` in src/server.js:215 with no host argument, which defaults to binding on `0.0.0.0` (the printed `localhost` message is misleading — Node's default bind is all interfaces). On a multi-tenant host, in a Docker container with port mapping, on a dev laptop on a coffee-shop network, or behind a tunnel (the file even references ngrok/Cloudflare tunnels), anyone who can reach the port can read live operational data: configured providers, internal version, uptime, every telemetry row including `provider`, `tier`, `status_code`, `error_type`, `cost_usd`, `tool_calls_made`, and timestamps. This is information disclosure of operator data and a strong recon surface for attacking the underlying provider keys.

## Recommendation

Either (a) bind the listener to `127.0.0.1` by default (`app.listen(port, '127.0.0.1', …)`) and require an explicit opt-in env var to bind elsewhere, or (b) place the dashboard routes behind a shared-secret/Bearer-token middleware. Most LLM proxy projects do both.

## Recent committers (`git log`)

- vishal veerareddy <vishalveera.reddy@servicenow.com> (2026-05-04)
