# [MEDIUM] parseUrl accepts any URL scheme — defense-in-depth missing

**File:** [`src/tools/web.js`](https://github.com/Fast-Editor/Lynkr/blob/feat/parallel-tool-execution/blob/feat/src/tools/web.js#L192-L331) (lines 192, 193, 194, 195, 196, 197, 198, 199, 331)
**Project:** claude-code
**Severity:** MEDIUM  •  **Confidence:** medium  •  **Slug:** `other-missing-validation`

## Owners

**Suggested assignee:** `vishalveera.reddy@servicenow.com` _(via last-committer)_

## Finding

parseUrl at L192-199 only verifies `new URL(rawUrl)` parses successfully. It does not constrain the protocol. While undici's fetch implementation rejects schemes other than http/https at runtime, that is an undocumented internal behavior of a transitive dependency. If undici's behavior changes, or if a future refactor swaps to a fetcher that supports more schemes, immediate exposure to file://, gopher://, or data:// SSRF/LFI variants becomes possible. The check should be explicit at the application boundary.

Additionally, `URL` parsing accepts unusual hosts that may be normalized later by lower layers (e.g., embedded credentials `http://user:pass@target/`, IPv6 zone IDs, IDN homograph hostnames). Combined with the hostname-only allowlist in ensureHostAllowed (L201-211), edge cases like `http://allowed.example.com@evil.example.com/` parse with hostname `evil.example.com` (so allowlist works) but IDN normalization issues remain.

## Recommendation

After parseUrl, add an explicit check: `if (!['http:', 'https:'].includes(url.protocol)) throw error`. Also reject URLs that contain userinfo (`url.username || url.password`). Consider rejecting non-ASCII hostnames or running them through `url.hostname` (which is ASCII/punycode form) for the allowlist comparison.

## Recent committers (`git log`)

- vishal veerareddy <vishalveera.reddy@servicenow.com> (2026-04-28)
