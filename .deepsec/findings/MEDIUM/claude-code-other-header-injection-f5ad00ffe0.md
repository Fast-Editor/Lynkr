# [MEDIUM] User-controlled filename interpolated into Content-Disposition response header

**File:** [`src/api/files-router.js`](https://github.com/Fast-Editor/Lynkr/blob/feat/parallel-tool-execution/blob/feat/src/api/files-router.js#L44-L71) (lines 44, 71)
**Project:** claude-code
**Severity:** MEDIUM  •  **Confidence:** high  •  **Slug:** `other-header-injection`

## Owners

**Suggested assignee:** `veerareddyvishal144@gmail.com` _(via last-committer)_

## Finding

Line 71: `res.setHeader('Content-Disposition', \`attachment; filename="${file.filename}"\`)`. The filename is taken from the multipart upload (`fnMatch[1]` in src/api/files-multipart.js) or from the `x-filename` request header (line 44 of this file) — both attacker-controllable. If the filename contains a `"` it can break out of the quoted parameter; combined with `;` it can inject arbitrary parameters. Modern Node validates CR/LF in header values so full response splitting is blocked, but the unsanitized double-quote allows filename spoofing in browsers, can interfere with anti-virus / DLP filename pattern matches at edge proxies, and (depending on Node version + downstream proxies) can confuse parsers. There is also no check for path separators or null bytes in the served filename.

## Recommendation

Sanitize the filename before placing it in the header — strip quotes, control chars, and path separators, and use the RFC 6266 `filename*=UTF-8''<encoded>` form for non-ASCII names. Also validate filename at upload time (allowlist of characters).

## Recent committers (`git log`)

- Vishal Veera Reddy <veerareddyvishal144@gmail.com> (2026-04-20)
