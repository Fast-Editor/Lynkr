# [BUG] Non-atomic increment-then-reread in getMemory

**File:** [`src/memory/store.js`](https://github.com/Fast-Editor/Lynkr/blob/feat/parallel-tool-execution/blob/feat/src/memory/store.js#L255-L258) (lines 255, 256, 258)
**Project:** claude-code
**Severity:** BUG  •  **Confidence:** medium  •  **Slug:** `other-toctou-read-after-write`

## Owners

**Suggested assignee:** `vishalveera.reddy@servicenow.com` _(via last-committer)_

## Finding

When called with `options.incrementAccess`, getMemory (lines 255-260) issues an UPDATE (incrementAccessCount) and then an immediate SELECT to return the post-increment value. The two statements are not wrapped in a transaction, so a concurrent writer can mutate the row between the UPDATE and the SELECT. The caller may see access_count or last_accessed_at values that do not correspond to what this call wrote, or the row may have been deleted (returning null after a successful increment).

## Recommendation

Wrap incrementAccessCount + the re-fetch in a db.transaction, or use SQLite's RETURNING clause (supported since 3.35) on the UPDATE itself to atomically return the post-update row in a single statement.

## Recent committers (`git log`)

- vishal veerareddy <vishalveera.reddy@servicenow.com> (2025-12-29)
