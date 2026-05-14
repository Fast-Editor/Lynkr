# [MEDIUM] TOCTOU race in checkRateLimit allows rate-limit bypass under cluster mode

**File:** [`src/budget/index.js`](https://github.com/Fast-Editor/Lynkr/blob/feat/parallel-tool-execution/blob/feat/src/budget/index.js#L119-L177) (lines 119, 123, 139, 145, 174, 175, 177)
**Project:** claude-code
**Severity:** MEDIUM  •  **Confidence:** high  •  **Slug:** `rate-limit-bypass`

## Owners

**Suggested assignee:** `veerareddyvishal56@gmail.com` _(via last-committer)_

## Finding

`checkRateLimit()` reads the current counter via `getRateLimit.get()` (line 123), evaluates and increments it in JS (lines 174-175), then writes back via `upsertRateLimit.run()` (line 177). Within a single Node.js process this is safe because better-sqlite3 is synchronous and the function does not await. However, the production Dockerfile defaults `CLUSTER_ENABLED="true"` (Dockerfile:86), which forks multiple worker processes that each instantiate their own `BudgetManager` against the shared SQLite file. Two workers handling concurrent requests for the same user can both read count=N, both compute N+1, and both upsert N+1 — losing one of the two increments. The undercount is unbounded as concurrency increases, allowing an attacker to send substantially more than the configured per-minute / per-hour ceiling. The window expiry logic (lines 139-148) compounds the problem: each worker independently resets windows based on its own read, so two near-simultaneous requests at the boundary can both reset to count=0. Additionally, `setBudget()` (line 310-323) and the implicit usage check in `checkBudget()` (which gates a downstream record-usage step that is never wired) have similar non-atomic patterns.

## Recommendation

Wrap the read-modify-write inside a SQLite transaction (`db.transaction(() => { ... })()`), or — preferably — perform the increment and limit check atomically in a single SQL statement using `INSERT ... ON CONFLICT DO UPDATE SET request_count_minute = CASE WHEN ... THEN 1 ELSE request_count_minute + 1 END RETURNING ...`. For cluster-safe rate limiting, consider a centralized counter (Redis with INCR + EXPIRE) instead of per-process SQLite reads. The same fix applies to the equivalent pattern in `setBudget()`.

## Recent committers (`git log`)

- Vishal Veera Reddy <veerareddyvishal56@gmail.com> (2026-02-22)
- Plaidmustache <161773990+Plaidmustache@users.noreply.github.com> (2026-02-19)
- vishal veerareddy <vishalveera.reddy@servicenow.com> (2026-02-18)
