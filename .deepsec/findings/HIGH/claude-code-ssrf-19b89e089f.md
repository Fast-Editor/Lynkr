# [HIGH] SSRF: redirects bypass caller's host allowlist

**File:** [`src/tools/web-client.js`](https://github.com/Fast-Editor/Lynkr/blob/feat/parallel-tool-execution/blob/feat/src/tools/web-client.js#L24-L50) (lines 24, 47, 48, 50)
**Project:** claude-code
**Severity:** HIGH  •  **Confidence:** high  •  **Slug:** `ssrf`

## Owners

**Suggested assignee:** `vishalveera.reddy@servicenow.com` _(via last-committer)_

## Finding

fetchWithAgent() (line 47-52) uses an undici Agent configured with maxRedirections: 5 (line 24), causing redirects to be followed transparently. Callers like src/tools/web.js's web_fetch tool validate the initial URL hostname against an allowlist (ensureHostAllowed at web.js:201) BEFORE invoking fetchWithAgent, but the redirect target is never re-validated against that allowlist. An attacker who controls or can post on an allowlisted host can issue an HTTP 30x redirect to an internal address — e.g., 127.0.0.1, 10.x.x.x, or the cloud metadata endpoint http://169.254.169.254/latest/meta-data/iam/security-credentials/ — and the Agent will silently follow it. The Response is returned to the caller, leaking internal service responses (and potentially IAM credentials) up to the LLM. Because the LLM-driven web fetch is the precise attack surface for prompt-injection-driven SSRF, this is exploitable in practice. Note: file:// is rejected by Node fetch, but http(s):// to RFC1918 / link-local space is allowed by default.

## Recommendation

Either (a) set maxRedirections: 0 here and have callers manually inspect Location headers and re-run ensureHostAllowed before refetching, or (b) attach an interceptor on the Agent that rejects redirect targets resolving to private/loopback/link-local IPs. Pre-resolving the hostname and rejecting RFC1918 / 127.0.0.0/8 / 169.254.0.0/16 / fc00::/7 / ::1 / fe80::/10 is the standard mitigation. DNS rebinding should also be considered (resolve once, fetch by IP).

## Recent committers (`git log`)

- vishal veerareddy <vishalveera.reddy@servicenow.com> (2025-12-10)
