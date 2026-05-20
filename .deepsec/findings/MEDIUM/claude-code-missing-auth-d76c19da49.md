# [MEDIUM] Unauthenticated /v1/usage and /api/tokens/stats expose spend telemetry

**File:** [`src/api/router.js`](https://github.com/Fast-Editor/Lynkr/blob/feat/parallel-tool-execution/blob/feat/src/api/router.js#L68-L776) (lines 68, 776)
**Project:** claude-code
**Severity:** MEDIUM  •  **Confidence:** medium  •  **Slug:** `missing-auth`

## Owners

**Suggested assignee:** `vishalveera.reddy@servicenow.com` _(via last-committer)_

## Finding

GET /v1/usage (line 68) and GET /api/tokens/stats (line 776) reveal spend, savings, and token consumption summaries with no auth. While not catastrophic alone, combined with the expensive-api-abuse vector this gives an attacker direct feedback on the cost they are inflicting and visibility into the operator's usage patterns.

## Recommendation

Gate behind auth or restrict to loopback.

## Recent committers (`git log`)

- vishal veerareddy <vishalveera.reddy@servicenow.com> (2026-04-28)
- Vishal Veera Reddy <veerareddyvishal144@gmail.com> (2026-04-20)
- Vishal Veera Reddy <veerareddyvishal56@gmail.com> (2026-02-22)
