# [CRITICAL] Unauthenticated Responses API endpoint enables RCE via server-side tool execution

**File:** [`src/api/openai-router.js`](https://github.com/Fast-Editor/Lynkr/blob/feat/parallel-tool-execution/blob/feat/src/api/openai-router.js#L1397) (lines 1397)
**Project:** claude-code
**Severity:** CRITICAL  •  **Confidence:** high  •  **Slug:** `missing-auth`

## Owners

**Suggested assignee:** `veerareddyvishal144@gmail.com` _(via last-committer)_

## Finding

POST /v1/responses (line 1397) has the same exposure as /v1/chat/completions — it calls orchestrator.processMessage() which can execute `shell` and edit/write tools server-side. No auth, no rate limit. An attacker can drive the model to any tool call by crafting the input prompt.

## Recommendation

Apply the same authentication middleware here. Consider stripping all server-executable tools (shell, write, edit) when serving external clients via an unauthenticated path.

## Recent committers (`git log`)

- Vishal Veera Reddy <veerareddyvishal144@gmail.com> (2026-04-20)
- vishal veerareddy <vishalveera.reddy@servicenow.com> (2026-03-21)
- Vishal Veera Reddy <veerareddyvishal56@gmail.com> (2026-02-22)
