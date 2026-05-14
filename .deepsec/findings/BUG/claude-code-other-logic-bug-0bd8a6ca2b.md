# [BUG] Map-iteration eviction is FIFO by insertion order, not LRU as the surrounding code seems to assume

**File:** [`src/stores/response-store.js`](https://github.com/Fast-Editor/Lynkr/blob/feat/parallel-tool-execution/blob/feat/src/stores/response-store.js#L6-L9) (lines 6, 7, 8, 9)
**Project:** claude-code
**Severity:** BUG  •  **Confidence:** high  •  **Slug:** `other-logic-bug`

## Owners

**Suggested assignee:** `veerareddyvishal144@gmail.com` _(via last-committer)_

## Finding

Lines 6-9 evict `store.keys().next().value` when the Map exceeds 1000 entries. Because Map preserves insertion order, this is FIFO — the oldest *inserted* entry is dropped, even if it was just read. There is no `get`-side touch to promote recency. Not a security issue, but worth noting: under load the Responses-API chaining (used in src/api/openai-router.js:1424) can lose conversation contexts that are actively being read while idle ones survive. Same pattern is repeated in file-store.js.

## Recommendation

If LRU semantics are intended, on each `getResponse(id)` hit do `store.delete(id); store.set(id, value)` to reinsert, or use a real LRU library.

## Recent committers (`git log`)

- Vishal Veera Reddy <veerareddyvishal144@gmail.com> (2026-04-20)
