# [MEDIUM] Unauthenticated /metrics/circuit-breakers, /metrics/load-shedding, /metrics/worker-pool, /metrics/semantic-cache, /metrics/lazy-tools expose internal architecture

**File:** [`src/server.js`](https://github.com/Fast-Editor/Lynkr/blob/feat/parallel-tool-execution/blob/feat/src/server.js#L113-L141) (lines 113, 114, 115, 118, 124, 132, 141)
**Project:** claude-code
**Severity:** MEDIUM  •  **Confidence:** medium  •  **Slug:** `other-info-disclosure`

## Owners

**Suggested assignee:** `vishalveera.reddy@servicenow.com` _(via last-committer)_

## Finding

Handlers at L113-146 expose internal subsystem state with no auth. While each individual endpoint leaks limited data (worker-pool size, cache hit-rate, circuit breaker state per upstream, load-shedding thresholds, lazy-tool registry stats), in aggregate they hand an unauthenticated attacker a complete map of the proxy's internal architecture, which provider clients are wired up, current saturation, and whether load shedding is active — useful for amplifying the abuse of the unauthenticated `/v1/messages` endpoint. Same exposure model as the prior finding: the README/startup comment instructs operators to tunnel the server publicly. The /metrics/circuit-breakers handler (L113) calls `registry.getAll()` which typically includes upstream URL fragments and failure samples, depending on the registry implementation.

## Recommendation

Apply the same auth gate as the previous finding. If you keep them public, audit each underlying `getStats()`/`getMetrics()` to ensure no upstream URLs, sample errors, or session/user identifiers can leak.

## Recent committers (`git log`)

- vishal veerareddy <vishalveera.reddy@servicenow.com> (2026-05-04)
- Vishal Veera Reddy <veerareddyvishal144@gmail.com> (2026-04-20)
- Vishal Veera Reddy <veerareddyvishal56@gmail.com> (2026-02-22)
