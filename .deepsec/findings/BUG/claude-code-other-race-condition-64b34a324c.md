# [BUG] TOCTOU between MAX_FILES check and Map insertion under concurrency

**File:** [`src/stores/file-store.js`](https://github.com/Fast-Editor/Lynkr/blob/feat/parallel-tool-execution/blob/feat/src/stores/file-store.js#L19-L36) (lines 19, 20, 21, 22, 36)
**Project:** claude-code
**Severity:** BUG  •  **Confidence:** medium  •  **Slug:** `other-race-condition`

## Owners

**Suggested assignee:** `veerareddyvishal144@gmail.com` _(via last-committer)_

## Finding

Lines 19-22 read `metadata.size` and conditionally evict the oldest entry, then line 36 inserts the new entry. Because `storeFile` is `async`-callable and the request handler in files-router.js runs the multipart parse before invoking `storeFile`, multiple concurrent uploads can each observe `size < MAX_FILES`, all skip eviction, and all insert — exceeding the cap. More importantly, two concurrent uploads at the boundary can race the eviction such that one upload's blob is deleted from disk while another expects it to remain. In practice the synchronous fs writeFileSync masks most of this, but if it's switched to async (which it should be), the race becomes real.

## Recommendation

Wrap the eviction + insert in a single critical section (e.g., a small async-mutex), or compute eviction targets after the insert lands.

## Recent committers (`git log`)

- Vishal Veera Reddy <veerareddyvishal144@gmail.com> (2026-04-20)
