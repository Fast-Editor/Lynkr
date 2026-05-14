# [MEDIUM] Unbounded growth in requestsByEndpoint Map enables memory-exhaustion DoS

**File:** [`src/observability/metrics.js`](https://github.com/Fast-Editor/Lynkr/blob/feat/parallel-tool-execution/blob/feat/src/observability/metrics.js#L21-L237) (lines 21, 87, 88, 89, 90, 237)
**Project:** claude-code
**Severity:** MEDIUM  •  **Confidence:** high  •  **Slug:** `other-unbounded-cardinality-dos`

## Owners

**Suggested assignee:** `developer@call-home.ch` _(via last-committer)_

## Finding

MetricsCollector.recordRequest() inserts an entry into this.requestsByEndpoint keyed by `${method} ${path}` for every incoming HTTP request. The middleware at src/api/middleware/metrics.js:17 passes `req.path || req.url` — both attacker-controlled. There is no bound, eviction, normalization, or known-route allowlist on this Map (in contrast to this.requestLatencies, which uses a 1000-entry circular buffer via addToBuffer). An unauthenticated attacker can send requests to many distinct paths (e.g., GET /foo/<random>, /bar/<random>, ...) and force the Map to grow indefinitely, eventually exhausting Node.js heap memory and causing the proxy to OOM-crash. The same concern applies (to a lesser degree) to this.fallbackReasons if reason strings are dynamically formatted, though status codes and provider names are bounded in practice. Note also that the per-endpoint dictionary is exposed via getMetrics().endpoints (line 237), so an attacker who can reach the metrics endpoint also gets a memory-amplified information-disclosure read of every path probed.

## Recommendation

Cap requestsByEndpoint to a fixed size (e.g., 500 entries) using an LRU/circular-buffer pattern similar to addToBuffer, or — preferably — record requests against a normalized route template (e.g., `${method} ${matchedRoutePath}`) extracted from the framework router rather than the raw URL. When the cap is exceeded, increment an `requests_other_total` bucket instead of inserting a new key. Apply the same guard to this.fallbackReasons if reason strings can be dynamic.

## Recent committers (`git log`)

- MichaelAnders <developer@call-home.ch> (2026-01-23)
- vishal veerareddy <vishalveera.reddy@servicenow.com> (2025-12-08)
