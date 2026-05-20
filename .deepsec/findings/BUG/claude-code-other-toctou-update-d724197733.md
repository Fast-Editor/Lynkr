# [BUG] TOCTOU race between read and write in updateMemory

**File:** [`src/memory/store.js`](https://github.com/Fast-Editor/Lynkr/blob/feat/parallel-tool-execution/blob/feat/src/memory/store.js#L269-L285) (lines 269, 275, 285)
**Project:** claude-code
**Severity:** BUG  •  **Confidence:** medium  •  **Slug:** `other-toctou-update`

## Owners

**Suggested assignee:** `vishalveera.reddy@servicenow.com` _(via last-committer)_

## Finding

updateMemory (lines 268-288) issues a SELECT (via getMemory) at line 269, then an UPDATE at line 275 outside any transaction. If a concurrent caller deletes the row in between, the UPDATE silently matches 0 rows (better-sqlite3 does not throw on zero-row updates) and the function then re-SELECTs at line 287 returning null — masking the failure. More importantly, last-writer-wins behavior across the read-modify-write window can clobber concurrent updates: the function merges `updates` over the snapshot read at line 269, so any field a concurrent updater changed for which `updates` does not provide a value gets reverted to the stale value. This is a logical data-corruption hazard whenever the SQLite database is shared across processes/workers.

## Recommendation

Wrap the read-modify-write in a transaction using db.transaction(...) (better-sqlite3 supports synchronous transactions). Alternatively, rewrite the UPDATE to be self-contained — use COALESCE on each column so the SELECT is unnecessary — and check `result.changes > 0` to detect a missing row instead of returning null silently.

## Recent committers (`git log`)

- vishal veerareddy <vishalveera.reddy@servicenow.com> (2025-12-29)
