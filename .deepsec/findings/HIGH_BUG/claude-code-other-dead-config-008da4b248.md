# [HIGH_BUG] memoryThreshold is configured and logged but never enforced

**File:** [`src/api/middleware/load-shedding.js`](https://github.com/Fast-Editor/Lynkr/blob/feat/parallel-tool-execution/blob/feat/src/api/middleware/load-shedding.js#L17-L123) (lines 17, 32, 43, 44, 46, 78, 100, 123)
**Project:** claude-code
**Severity:** HIGH_BUG  •  **Confidence:** high  •  **Slug:** `other-dead-config`

## Owners

**Suggested assignee:** `developer@call-home.ch` _(via last-committer)_

## Finding

The constructor sets this.memoryThreshold = options.memoryThreshold || 0.85 (line 17), getLoadShedder() reads LOAD_SHEDDING_MEMORY_THRESHOLD from env (line 100), and initializeLoadShedder() logs the configured memoryThreshold at startup (line 123). However, isOverloaded() (lines 32-73) only checks heapUsedPercent > this.heapThreshold and this.activeRequests > this.activeRequestsThreshold — this.memoryThreshold is never read after construction. getMetrics() (lines 78-89) also omits memoryThreshold from the returned thresholds object. The result: operators who set LOAD_SHEDDING_MEMORY_THRESHOLD believing they have configured RSS/system-memory load shedding get no protection at all, and the startup log misleadingly confirms the value was 'applied'. In production this can lead directly to OOM kills because the only memory signal being honored is heapUsed/heapTotal — which can stay flat while RSS (native buffers, V8 external memory, large strings) explodes.

## Recommendation

Either enforce memoryThreshold by adding a check such as `const rssPercent = memUsage.rss / os.totalmem(); if (rssPercent > this.memoryThreshold) { ... }` inside isOverloaded(), or remove the unused configuration to prevent the false sense of security. Whichever path is chosen, mirror the value in getMetrics() so dashboards reflect reality.

## Recent committers (`git log`)

- MichaelAnders <developer@call-home.ch> (2026-01-23)
- vishal veerareddy <vishalveera.reddy@servicenow.com> (2025-12-08)
