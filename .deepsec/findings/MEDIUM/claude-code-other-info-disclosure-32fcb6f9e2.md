# [MEDIUM] Full response headers from fetched URLs returned to caller

**File:** [`src/tools/web.js`](https://github.com/Fast-Editor/Lynkr/blob/feat/parallel-tool-execution/blob/feat/src/tools/web.js#L232-L349) (lines 232, 233, 349)
**Project:** claude-code
**Severity:** MEDIUM  •  **Confidence:** high  •  **Slug:** `other-info-disclosure`

## Owners

**Suggested assignee:** `vishalveera.reddy@servicenow.com` _(via last-committer)_

## Finding

fetchDocument at L232-236 returns ALL response headers from the fetched URL to the caller via `Object.fromEntries(response.headers.entries())`, and registerWebFetchTool at L349 surfaces those headers in the tool result `headers: document.headers`. There is no allowlist or stripping of sensitive headers.

When combined with the SSRF finding above, an attacker who can reach an internal service (via prompt injection + the SSRF default allow-all) can extract:
  • `Set-Cookie` from internal admin panels (potentially containing session tokens, especially if the target service has misconfigured CORS or accepts unauthenticated requests but issues anonymous session cookies).
  • `WWW-Authenticate` realms and challenges that reveal internal auth schemes.
  • Server version banners, internal X-* headers (X-Powered-By, X-Backend-Server, X-Request-ID with internal trace IDs, internal IPs in X-Real-IP echoes, etc.).
  • CSRF tokens echoed in headers.
  • For cloud metadata endpoints, the headers include x-aws-ec2-metadata-token info that aids further exploitation.

Even without SSRF, this exposes the LLM/caller to data the user might not have requested when fetching a public URL.

## Recommendation

Either (a) drop the headers field entirely from the tool response (the LLM rarely needs raw response headers), or (b) return only an explicit allowlist of safe headers (Content-Type, Content-Length, Last-Modified, ETag, Cache-Control). Strip Set-Cookie, Authorization, WWW-Authenticate, Proxy-Authenticate, and any header starting with X- by default.

## Recent committers (`git log`)

- vishal veerareddy <vishalveera.reddy@servicenow.com> (2026-04-28)
