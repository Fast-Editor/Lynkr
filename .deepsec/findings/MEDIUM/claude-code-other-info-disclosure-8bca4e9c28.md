# [MEDIUM] Configuration enumeration via unauthenticated /v1/config and /v1/providers

**File:** [`src/api/providers-handler.js`](https://github.com/Fast-Editor/Lynkr/blob/feat/parallel-tool-execution/blob/feat/src/api/providers-handler.js#L287-L378) (lines 287, 334, 378)
**Project:** claude-code
**Severity:** MEDIUM  •  **Confidence:** medium  •  **Slug:** `other-info-disclosure`

## Owners

**Suggested assignee:** `vishalveera.reddy@servicenow.com` _(via last-committer)_

## Finding

GET /v1/config (line 378) returns model_provider, fallback_provider, fallback_enabled, tool_execution_mode, configured_providers (list of all upstream provider slugs), memory_enabled, smart_tool_selection. GET /v1/providers (line 287) returns each provider's base_url, type, and model list. GET /v1/providers/:name (line 334) returns the same per-provider. While baseUrl/type are not credentials, this lets an unauthenticated attacker fingerprint exactly which upstream providers' keys they can drain (combined with the missing auth on chat/embedding endpoints), and which environments are reachable from the server (for SSRF planning if any other endpoint accepts a target URL).

## Recommendation

Require auth, or omit base_url and provider list from the public response. The 'is /v1/config a public-by-design endpoint?' question should be answered explicitly in the threat model.

## Recent committers (`git log`)

- vishal veerareddy <vishalveera.reddy@servicenow.com> (2026-04-15)
- Vishal Veera Reddy <veerareddyvishal56@gmail.com> (2026-02-22)
