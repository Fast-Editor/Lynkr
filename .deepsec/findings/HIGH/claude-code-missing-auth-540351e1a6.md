# [HIGH] Unauthenticated /admin/circuit-breakers/reset enables DoS amplification

**File:** [`src/api/providers-handler.js`](https://github.com/Fast-Editor/Lynkr/blob/feat/parallel-tool-execution/blob/feat/src/api/providers-handler.js#L619) (lines 619)
**Project:** claude-code
**Severity:** HIGH  •  **Confidence:** high  •  **Slug:** `missing-auth`

## Owners

**Suggested assignee:** `vishalveera.reddy@servicenow.com` _(via last-committer)_

## Finding

POST /admin/circuit-breakers/reset (line 619) lets any unauthenticated client clear the circuit-breaker state for any provider (or all of them). An attacker can pair this with the unauthenticated /v1/chat/completions endpoint to defeat the operator's failure protection — repeatedly tripping breakers via abusive traffic, then resetting them to keep the abusive traffic flowing to the upstream API.

## Recommendation

Auth-gate. Same as /admin/reload.

## Recent committers (`git log`)

- vishal veerareddy <vishalveera.reddy@servicenow.com> (2026-04-15)
- Vishal Veera Reddy <veerareddyvishal56@gmail.com> (2026-02-22)
