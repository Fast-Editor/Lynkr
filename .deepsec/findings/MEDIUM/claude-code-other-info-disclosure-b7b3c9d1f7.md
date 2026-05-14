# [MEDIUM] Internal absolute filesystem path leaked in `storage_path` field

**File:** [`src/stores/file-store.js`](https://github.com/Fast-Editor/Lynkr/blob/feat/parallel-tool-execution/blob/feat/src/stores/file-store.js#L34-L64) (lines 34, 41, 64)
**Project:** claude-code
**Severity:** MEDIUM  •  **Confidence:** high  •  **Slug:** `other-info-disclosure`

## Owners

**Suggested assignee:** `veerareddyvishal144@gmail.com` _(via last-committer)_

## Finding

On line 34 the entry stored in `metadata` includes `storage_path: storagePath` — the absolute filesystem path on the server (e.g., `/Users/vishalveera.reddy/claude-code/data/files/file-<uuid>`). This entry is returned verbatim by `getFile()` (line 41-43) and `listFiles()` (line 63-67), which are themselves exposed to unauthenticated network callers via `GET /v1/files` and `GET /v1/files/:id` in src/api/files-router.js. The path discloses the home directory, the project layout, and confirms the running user — useful reconnaissance for further attacks (e.g., guessing log paths, config locations, or tailoring path-traversal payloads against other endpoints). It also leaks via `FILES_STORAGE_PATH` env var values that an operator may not realize are public.

## Recommendation

Keep `storage_path` only on the server-side entry. When returning to API callers, project to a public-safe shape (id, object, filename, purpose, bytes, mime_type, created_at).

## Recent committers (`git log`)

- Vishal Veera Reddy <veerareddyvishal144@gmail.com> (2026-04-20)
