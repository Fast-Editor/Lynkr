# [HIGH_BUG] Synchronous fs.writeFileSync / readFileSync block the Node event loop on user-controlled data up to 100MB

**File:** [`src/stores/file-store.js`](https://github.com/Fast-Editor/Lynkr/blob/feat/parallel-tool-execution/blob/feat/src/stores/file-store.js#L25-L49) (lines 25, 49)
**Project:** claude-code
**Severity:** HIGH_BUG  •  **Confidence:** high  •  **Slug:** `other-dos`

## Owners

**Suggested assignee:** `veerareddyvishal144@gmail.com` _(via last-committer)_

## Finding

`fs.writeFileSync(storagePath, buffer)` on line 25 and `fs.readFileSync(entry.storage_path)` on line 49 are synchronous I/O. With an unauthenticated `POST /v1/files` accepting up to 100MB (`FILES_MAX_SIZE_MB` default in files-router.js:7), each upload blocks the single-threaded event loop for the duration of the disk write — stalling every other request the proxy is serving (LLM streams included). A handful of concurrent large uploads, or a slow disk, is enough to take the proxy offline. This is a DoS vector that becomes exploitable because the upload route has no auth or rate limiting.

## Recommendation

Use `fs.promises.writeFile` / `createWriteStream` (and `createReadStream` + `res.pipe()` on the read path) so I/O does not block the event loop. Add per-IP rate limiting on the files router.

## Recent committers (`git log`)

- Vishal Veera Reddy <veerareddyvishal144@gmail.com> (2026-04-20)
