# [MEDIUM] IDOR on previous_response_id with predictable response IDs

**File:** [`src/api/openai-router.js`](https://github.com/Fast-Editor/Lynkr/blob/feat/parallel-tool-execution/blob/feat/src/api/openai-router.js#L1422-L1626) (lines 1422, 1442, 1626)
**Project:** claude-code
**Severity:** MEDIUM  •  **Confidence:** high  •  **Slug:** `cross-tenant-id`

## Owners

**Suggested assignee:** `veerareddyvishal144@gmail.com` _(via last-committer)_

## Finding

Lines 1422-1442 look up `req.body.previous_response_id` directly in the in-memory response store (src/stores/response-store.js, a global Map shared across all clients) with no ownership check, then prepend the stored conversation messages and assistant content to the current request. Combined with line 1626 (`responseId = responsesResponse.id || \`resp_${Date.now()}\``), the response IDs are timestamp-based and trivially enumerable — an attacker can iterate `resp_<timestamp>` values within a window to harvest other users' assistant content and message history into their own LLM context (and subsequently coerce the model to echo it back).

## Recommendation

Bind responses to a session/owner at storeResponse time and verify ownership on getResponse. Use crypto.randomUUID() for response IDs instead of Date.now().

## Recent committers (`git log`)

- Vishal Veera Reddy <veerareddyvishal144@gmail.com> (2026-04-20)
- vishal veerareddy <vishalveera.reddy@servicenow.com> (2026-03-21)
- Vishal Veera Reddy <veerareddyvishal56@gmail.com> (2026-02-22)
