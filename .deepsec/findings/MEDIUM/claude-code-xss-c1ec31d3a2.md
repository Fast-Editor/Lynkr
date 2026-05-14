# [MEDIUM] innerHTML rendering with unescaped template literals across all four pages

**File:** [`public/dashboard.html`](https://github.com/Fast-Editor/Lynkr/blob/feat/parallel-tool-execution/blob/feat/public/dashboard.html#L155-L548) (lines 155, 185, 212, 213, 232, 253, 261, 262, 263, 266, 336, 346, 356, 425, 428, 434, 449, 531, 541, 542, 543, 548)
**Project:** claude-code
**Severity:** MEDIUM  •  **Confidence:** medium  •  **Slug:** `xss`

## Owners

**Suggested assignee:** `vishalveera.reddy@servicenow.com` _(via last-committer)_

## Finding

Every renderer (`_renderOverview`, `_renderUsage`, `_renderRouting`, `_renderLogs`) builds HTML with template literals and assigns to `innerHTML` (lines 155, 185, 212-213, 232). Data fields are interpolated raw, including: `${r.provider}`, `${r.model}`, `${r.error_type}`, `${r.tier}`, `${name}` (provider/tier names from `Object.entries(...)`), and the byModel/byProvider keys (lines 261-266, 336, 346, 356, 425-428, 434, 449, 540-548). Of particular note, line 542 inserts `r.model` into both an HTML attribute (`title="${r.model||''}"`) and as text content — attribute injection is much easier to exploit since a single `"` breaks out. Today these telemetry fields are populated from server-side values (verified via src/clients/databricks.js: `model: routingDecision.model` where `routingDecision.model = tierSelectedModel` from config; `provider` from a fixed set; `error_type: err.code || err.name`; `tier` from a fixed enum). However: (1) `error_type` derives from JS error objects whose `.code`/`.name` could in some upstream-failure paths reflect attacker-influenced strings; (2) `tierSelectedModel` is sourced from configuration that an operator may set from untrusted sources; (3) any future feature that exposes a user-controllable field (e.g. session_id, request_type, agentic_type — already in telemetry but not yet rendered) immediately becomes XSS. The defensive posture is missing entirely — there is no `escapeHtml()` helper in the file. Combined with the missing-auth finding, an attacker who can reach the proxy and inject any value into telemetry would get XSS in the operator's browser, with same-origin access to the dashboard host (allowing CSRF against other localhost services and reading further telemetry).

## Recommendation

Introduce an `escapeHtml(s)` helper that encodes `&<>"'` and apply it to every interpolation of a string field. For attribute interpolation (e.g. line 542 `title=...`), the same helper plus quote-wrapping is sufficient. Alternatively, refactor renderers to build DOM nodes via `document.createElement` + `textContent` instead of innerHTML, which makes the safe path the default. At minimum, escape `r.model`, `r.provider`, `r.error_type`, `r.tier`, and the byModel/byProvider/providerStats/circuitBreakers keys.

## Recent committers (`git log`)

- vishal veerareddy <vishalveera.reddy@servicenow.com> (2026-05-04)
