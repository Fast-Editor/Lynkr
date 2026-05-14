# [HIGH] web_fetch tool defaults to allowing ANY URL host (open SSRF)

**File:** [`src/config/index.js`](https://github.com/Fast-Editor/Lynkr/blob/feat/parallel-tool-execution/blob/feat/src/config/index.js#L387-L394) (lines 387, 392, 393, 394)
**Project:** claude-code
**Severity:** HIGH  •  **Confidence:** high  •  **Slug:** `ssrf`

## Owners

**Suggested assignee:** `vishalveera.reddy@servicenow.com` _(via last-committer)_

## Finding

The configuration default `process.env.WEB_SEARCH_ALLOW_ALL !== "false"` evaluates to TRUE when the env var is unset, missing, or set to anything other than the literal string "false". Combined with src/tools/web.js:201-211 (`ensureHostAllowed` returns early when `allowedHosts === null`) and src/config/index.js:392-394 (`webAllowedHosts = null` when allowAllHosts is true), the LLM-callable web_fetch tool will fetch ARBITRARY URLs by default — including:
- Cloud metadata services (http://169.254.169.254/latest/meta-data/iam/security-credentials/ on AWS, http://metadata.google.internal/ on GCP, http://169.254.170.2/v2/credentials/ on ECS) which can leak IAM credentials
- Internal/private network targets (10.0.0.0/8, 172.16/12, 192.168/16, link-local fe80::/10)
- Localhost-bound services (databases, admin panels, debug endpoints)

No SSRF allowlist/denylist filters cloud metadata IPs (`169.254.169.254`) or RFC1918 private ranges anywhere in src/tools/web.js or src/tools/web-client.js. The undici Agent at src/tools/web-client.js:24 is configured with `maxRedirections: 5`, so even narrowly-scoped allowlists can be bypassed via DNS rebinding or HTTP 302 redirects toward internal targets. Additionally, when WEB_SEARCH_ALLOW_ALL is explicitly disabled, line 394 always hardcodes `localhost` and `127.0.0.1` into the allowlist, so loopback SSRF is impossible to disable without code changes.

Attack scenario: An attacker who can influence the user's prompt, a tool result (e.g., a malicious search result), or any LLM input can cause Lynkr to fetch internal cloud metadata. Since this is an HTTP proxy that is meant to be deployed in dev/cloud environments, default-permissive SSRF combined with cloud-metadata endpoints exposes IAM credentials.

## Recommendation

Default `allowAllWebHosts` to FALSE (i.e., use `=== "true"` rather than `!== "false"`). Enforce a denylist that rejects the metadata IP `169.254.169.254`, `169.254.170.2`, IPv6 link-local (fe80::), private RFC1918 ranges, and loopback before host-allowlist evaluation. Resolve the URL's hostname to all A/AAAA records and re-validate each IP after redirects (avoid TOCTOU/DNS rebinding). Consider running web_fetch through a dedicated egress proxy or PROXY env that blocks RFC1918/metadata endpoints. Localhost should require an explicit opt-in (e.g., `WEB_SEARCH_ALLOW_LOCALHOST=true`) rather than being unconditionally trusted.

## Recent committers (`git log`)

- vishal veerareddy <vishalveera.reddy@servicenow.com> (2026-04-28)
- Vishal Veera Reddy <veerareddyvishal144@gmail.com> (2026-04-20)
