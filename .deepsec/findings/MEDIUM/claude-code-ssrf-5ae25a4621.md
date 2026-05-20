# [MEDIUM] web_agent URL accepts arbitrary schemes and internal hosts

**File:** [`src/tools/tinyfish.js`](https://github.com/Fast-Editor/Lynkr/blob/feat/parallel-tool-execution/blob/feat/src/tools/tinyfish.js#L27-L171) (lines 27, 33, 38, 171)
**Project:** claude-code
**Severity:** MEDIUM  •  **Confidence:** medium  •  **Slug:** `ssrf`

## Owners

**Suggested assignee:** `vishalveera.reddy@servicenow.com` _(via last-committer)_

## Finding

normalizeUrl (L27-39) only validates that the input is parseable by `new URL()`. It accepts file://, javascript:, data:, blob:, gopher:, ftp://, and any internal IP (127.0.0.1, 10.0.0.0/8, 192.168.x.x, 169.254.169.254 — AWS/GCP metadata, ::1, etc.). The URL is then forwarded to the configured TinyFish endpoint, which performs a remote browser navigation against it. Although the request is not made directly from this server, the server still acts as a relay for SSRF: an attacker who can prompt-inject the LLM (highly realistic — the agent ingests web content via this very tool) can exfiltrate or scan resources reachable from TinyFish's infrastructure (cloud metadata services, internal SaaS APIs), or trigger script execution via javascript:/data: URLs in TinyFish's headless browser, then receive the rendered output back through the SSE stream. The result is round-tripped to the LLM (and thus the user), so any data the metadata IMDS exposes leaks back. Additionally, URLs containing credentials (https://user:pass@host/) are logged at debug/error (L300-307, L322-325).

## Recommendation

Restrict scheme to http/https only. Block private/loopback/link-local IP ranges and DNS names that resolve to them (10/8, 172.16/12, 192.168/16, 127/8, 169.254/16, 100.64/10, fc00::/7, fe80::/10, ::1). Strip userinfo from URLs before forwarding/logging. Optionally add an allowlist of permitted target domains. Redact URL credentials in logger calls.

## Recent committers (`git log`)

- vishal veerareddy <vishalveera.reddy@servicenow.com> (2026-02-23)
