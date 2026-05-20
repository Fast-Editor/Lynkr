# [BUG] Shared cache timestamp causes stale provider stats

**File:** [`src/routing/telemetry.js`](https://github.com/Fast-Editor/Lynkr/blob/feat/parallel-tool-execution/blob/feat/src/routing/telemetry.js#L479-L490) (lines 479, 480, 482, 484, 489, 490)
**Project:** claude-code
**Severity:** BUG  •  **Confidence:** high  •  **Slug:** `other-stale-cache`

## Owners

**Suggested assignee:** `veerareddyvishal144@gmail.com` _(via last-committer)_

## Finding

getProviderStatsCached uses a single module-level providerStatsCacheTs that is overwritten on every fetch of any provider. Once provider A's stats are cached, subsequent fetches for providers B, C, … keep refreshing the shared timestamp, so the staleness check `now - providerStatsCacheTs < STATS_CACHE_TTL` for provider A passes long after A's data has aged past the 5-second TTL. In a steady stream of provider queries this can return arbitrarily stale data for any individual provider, never refreshing it. The stats cache (statsCache/statsCacheTs) is fine because there is only one entry, but the per-provider Map needs per-key timestamps.

## Recommendation

Track timestamps per provider, e.g. store {value, ts} pairs in providerStatsCache, or use a Map<provider, number> alongside the Map<provider, value>. Check `now - entry.ts < STATS_CACHE_TTL` against the per-provider timestamp.

## Recent committers (`git log`)

- Vishal Veera Reddy <veerareddyvishal144@gmail.com> (2026-04-20)
- vishal veerareddy <vishalveera.reddy@servicenow.com> (2026-04-08)
