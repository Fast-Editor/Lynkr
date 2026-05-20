# [MEDIUM] Google API key embedded in URL query string

**File:** [`src/clients/databricks.js`](https://github.com/Fast-Editor/Lynkr/blob/feat/parallel-tool-execution/blob/feat/src/clients/databricks.js#L1747-L1790) (lines 1747, 1790)
**Project:** claude-code
**Severity:** MEDIUM  •  **Confidence:** medium  •  **Slug:** `secrets-exposure`

## Owners

**Suggested assignee:** `veerareddyvishal144@gmail.com` _(via last-committer)_

## Finding

The Vertex/Gemini endpoint is constructed with `?key=${apiKey}` (L1747), placing the credential in the URL query string. While the explicit debug log on L1790 properly redacts the key via `endpoint.replace(apiKey, '***')`, putting secrets in URLs is a defense-in-depth anti-pattern: (1) Node's undici fetch errors and stack traces can include URLs, and `err.message` is later logged on L2249 ('Primary provider failed...') and L2388 ('Both primary and fallback...'); (2) URLs end up in upstream HTTP server access logs (Google's side); (3) any intermediate proxy or telemetry collector that records URLs would capture the key; (4) any future log statement that prints `endpoint` without explicit redaction would leak it. The Gemini API supports the `x-goog-api-key` header as a safer alternative.

## Recommendation

Move the API key from the URL query string to the `x-goog-api-key` request header: `const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent`;` and add `headers['x-goog-api-key'] = apiKey;`. This eliminates the leak surface entirely instead of relying on per-call-site redaction.

## Recent committers (`git log`)

- Vishal Veera Reddy <veerareddyvishal144@gmail.com> (2026-04-20)
- vishal veerareddy <vishalveera.reddy@servicenow.com> (2026-04-15)
- Vishal Veera Reddy <veerareddyvishal56@gmail.com> (2026-02-22)
