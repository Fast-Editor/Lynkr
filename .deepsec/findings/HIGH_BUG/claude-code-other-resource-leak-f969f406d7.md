# [HIGH_BUG] Files persist on disk forever after restart — MAX_FILES eviction is in-memory only

**File:** [`src/stores/file-store.js`](https://github.com/Fast-Editor/Lynkr/blob/feat/parallel-tool-execution/blob/feat/src/stores/file-store.js#L9-L22) (lines 9, 19, 20, 21, 22)
**Project:** claude-code
**Severity:** HIGH_BUG  •  **Confidence:** high  •  **Slug:** `other-resource-leak`

## Owners

**Suggested assignee:** `veerareddyvishal144@gmail.com` _(via last-committer)_

## Finding

`metadata` is an in-process `Map` (line 9). On each restart the Map starts empty, but the actual files in `STORAGE_DIR` survive on disk. The eviction logic on lines 19-22 (`if (metadata.size >= MAX_FILES) deleteFile(oldest)`) only fires while files have been re-uploaded into the current process; previously-stored files are unreachable via the API after restart yet continue to occupy disk. Combined with the lack of authentication on `POST /v1/files` (in files-router.js) and the configurable 100MB-per-file limit, an attacker who can hit the port can fill the disk indefinitely — they upload, the server restarts (operator OOM, etc.), the orphan files are never evicted, and they upload again. Even without an attacker, normal usage leads to unbounded disk growth.

## Recommendation

On startup, scan `STORAGE_DIR` and either rebuild metadata from disk (e.g., persist metadata in JSON/SQLite alongside the blobs) or purge orphan files. At minimum, also enforce a total-bytes-on-disk budget, not just a count.

## Recent committers (`git log`)

- Vishal Veera Reddy <veerareddyvishal144@gmail.com> (2026-04-20)
