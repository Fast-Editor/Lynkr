# [CRITICAL] Files API is fully unauthenticated and shared across all callers

**File:** [`src/api/files-router.js`](https://github.com/Fast-Editor/Lynkr/blob/feat/parallel-tool-execution/blob/feat/src/api/files-router.js#L9-L75) (lines 9, 54, 59, 65, 75)
**Project:** claude-code
**Severity:** CRITICAL  •  **Confidence:** high  •  **Slug:** `missing-auth`

## Owners

**Suggested assignee:** `veerareddyvishal144@gmail.com` _(via last-committer)_

## Finding

All five handlers — POST /files (line 9), GET /files (line 54), GET /files/:id (line 59), GET /files/:id/content (line 65), DELETE /files/:id (line 75) — have no auth and no tenant isolation. The backing fileStore (src/stores/file-store.js) keeps a single global metadata Map and a single STORAGE_DIR (default ./data/files). Concrete impacts: (1) Any reachable client can list ALL stored files (line 54), retrieve any file's content (line 65), and delete any file (line 75). (2) Upload (line 9) accepts up to FILES_MAX_SIZE_MB (default 100MB) per file with no per-tenant or per-IP cap — disk-exhaustion DoS. (3) When the global MAX_FILES (default 1000) is hit, fileStore.storeFile evicts the oldest entry (`metadata.keys().next().value`), so an attacker can deliberately delete legitimate users' files by uploading 1000 attacker files. The storage_path is exposed in the metadata response, which leaks the server's filesystem layout.

## Recommendation

Require authentication on every files route and key file ownership by user/session. Apply per-user storage quotas instead of a single global FIFO eviction. Stop returning storage_path to the client.

## Recent committers (`git log`)

- Vishal Veera Reddy <veerareddyvishal144@gmail.com> (2026-04-20)
