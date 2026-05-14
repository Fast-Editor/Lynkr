# [MEDIUM] No size limit on fetched response body — memory DoS

**File:** [`src/tools/web.js`](https://github.com/Fast-Editor/Lynkr/blob/feat/parallel-tool-execution/blob/feat/src/tools/web.js#L108-L234) (lines 108, 220, 234)
**Project:** claude-code
**Severity:** MEDIUM  •  **Confidence:** high  •  **Slug:** `other-resource-exhaustion`

## Owners

**Suggested assignee:** `vishalveera.reddy@servicenow.com` _(via last-committer)_

## Finding

fetchDocument at L220 calls `response.text()` to buffer the entire response body into memory before any size check. The body_preview is sliced afterward (L342) to `config.webSearch.bodyPreviewMax` (default 10000), but by then the full body is already resident in V8 heap. An attacker-controlled URL serving a multi-GB stream — or chunked response with no Content-Length — exhausts memory and crashes the proxy. There is also no Content-Length pre-check or stream-with-cutoff.

The per-request timeoutMs (default 10000) provides only weak protection: a malicious server can deliver bytes steadily under the bodyTimeout (30s, web-client.js L20) and still buffer hundreds of MBs.

## Recommendation

Replace `response.text()` with a streaming read that aborts when bytes exceed a hard cap (e.g., 5MB). Pre-check `response.headers.get('content-length')` and reject early if it exceeds the cap. Apply the same to performSearch's `response.text()` at L108. The undici Agent's `bodyTimeout: 30000` should also be lowered.

## Recent committers (`git log`)

- vishal veerareddy <vishalveera.reddy@servicenow.com> (2026-04-28)
