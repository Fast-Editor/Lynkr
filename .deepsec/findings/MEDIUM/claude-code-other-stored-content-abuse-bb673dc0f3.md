# [MEDIUM] Arbitrary file storage with attacker-controlled MIME type can be reflected to victims

**File:** [`src/api/files-router.js`](https://github.com/Fast-Editor/Lynkr/blob/feat/parallel-tool-execution/blob/feat/src/api/files-router.js#L22-L70) (lines 22, 70)
**Project:** claude-code
**Severity:** MEDIUM  •  **Confidence:** medium  •  **Slug:** `other-stored-content-abuse`

## Owners

**Suggested assignee:** `veerareddyvishal144@gmail.com` _(via last-committer)_

## Finding

Lines 22-46: `mimeType` and `filename` are taken from the upload (Content-Type header / multipart Content-Type / x-filename). GET /files/:id/content (line 65) sets `Content-Type: file.mime_type` directly from the uploader's input. An attacker can upload an HTML payload with `Content-Type: text/html`, then send a victim a link to /v1/files/:id/content — the server reflects content as HTML on the operator's origin, enabling XSS / phishing attacks against anyone who trusts the Lynkr origin (e.g., the dashboard at /dashboard mounted on the same origin in src/server.js:151).

## Recommendation

Either force a safe Content-Type (application/octet-stream) on download, or strictly allowlist MIME types. Always set `Content-Disposition: attachment` (already done) AND `X-Content-Type-Options: nosniff`. Consider serving file content from a separate, cookie-less origin.

## Recent committers (`git log`)

- Vishal Veera Reddy <veerareddyvishal144@gmail.com> (2026-04-20)
