# [MEDIUM] Unauthenticated /metrics/observability and /metrics/prometheus endpoints expose cost, token, and routing data

**File:** [`src/server.js`](https://github.com/Fast-Editor/Lynkr/blob/feat/parallel-tool-execution/blob/feat/src/server.js#L82-L110) (lines 82, 102, 103, 104, 107, 108, 109, 110)
**Project:** claude-code
**Severity:** MEDIUM  •  **Confidence:** medium  •  **Slug:** `other-info-disclosure`

## Owners

**Suggested assignee:** `vishalveera.reddy@servicenow.com` _(via last-committer)_

## Finding

The handlers at L102-111 mount `/metrics/observability` and `/metrics/prometheus` with no authentication and no IP allow-list. Tracing into `src/observability/metrics.js#getMetrics`, the JSON payload includes: aggregate token counts (`tokens_input_total`, `tokens_output_total`), **`cost_usd_total` in dollars**, `databricks_requests_total`/`_errors_total`/`_retries_total`, full per-endpoint request counts (`endpoints`), per-status-code counts, latency percentiles, memory and CPU usage, routing breakdown by provider including success/failure counts, fallback reasons, and `cost_savings.ollama_savings_usd`. The startup comment at L82 explicitly tells operators how to expose the server via ngrok / Cloudflare Tunnel for use with Claude Code clients, so in practical deployments these endpoints will be reachable from the public internet. An attacker probing one of these endpoints can: (1) profile the operator's spend and traffic patterns, (2) enumerate the internal API surface via the `endpoints` map, (3) detect which LLM providers are configured and whether fallback is firing, and (4) time their abuse against `/v1/messages` (which has no auth, only header-controlled rate limits) by watching budget/rate-limit-block counters update in real time. Severity is MEDIUM rather than HIGH because no per-user/per-prompt content is leaked, but the cost/abuse-feedback signal is meaningful.

## Recommendation

Gate the `/metrics/*` endpoints behind a shared-secret bearer token (e.g., `METRICS_TOKEN` env var checked in middleware), an IP allow-list, or bind them to a separate loopback-only listener. Prometheus-style auth via basic-auth or a separate `/metrics` server is standard. At minimum, redact `cost_usd_total`, `cost_savings.*`, and the `endpoints` map from the unauthenticated response.

## Recent committers (`git log`)

- vishal veerareddy <vishalveera.reddy@servicenow.com> (2026-05-04)
- Vishal Veera Reddy <veerareddyvishal144@gmail.com> (2026-04-20)
- Vishal Veera Reddy <veerareddyvishal56@gmail.com> (2026-02-22)
