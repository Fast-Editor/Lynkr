# [MEDIUM] Public health endpoint discloses provider configuration

**File:** [`src/api/openai-router.js`](https://github.com/Fast-Editor/Lynkr/blob/feat/parallel-tool-execution/blob/feat/src/api/openai-router.js#L1955) (lines 1955)
**Project:** claude-code
**Severity:** MEDIUM  •  **Confidence:** medium  •  **Slug:** `missing-auth`

## Owners

**Suggested assignee:** `veerareddyvishal144@gmail.com` _(via last-committer)_

## Finding

GET /v1/health (line 1955) returns `{ provider: config.modelProvider?.type ... }` with no auth. This lets an unauthenticated attacker fingerprint exactly which paid provider's keys they can drain via the unauthenticated chat/embedding endpoints.

## Recommendation

Either gate this behind auth, or strip the provider field from the public response.

## Recent committers (`git log`)

- Vishal Veera Reddy <veerareddyvishal144@gmail.com> (2026-04-20)
- vishal veerareddy <vishalveera.reddy@servicenow.com> (2026-03-21)
- Vishal Veera Reddy <veerareddyvishal56@gmail.com> (2026-02-22)
