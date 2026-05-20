# [MEDIUM] IDOR — agent transcripts and execution details readable by anyone

**File:** [`src/api/router.js`](https://github.com/Fast-Editor/Lynkr/blob/feat/parallel-tool-execution/blob/feat/src/api/router.js#L702-L719) (lines 702, 719)
**Project:** claude-code
**Severity:** MEDIUM  •  **Confidence:** high  •  **Slug:** `cross-tenant-id`

## Owners

**Suggested assignee:** `vishalveera.reddy@servicenow.com` _(via last-committer)_

## Finding

GET /v1/agents/:agentId/transcript (line 702) and GET /v1/agents/:executionId (line 719) accept user-supplied IDs and return the full transcript / execution details with no auth and no ownership check. An attacker who can guess or enumerate agent IDs can read other users' agent conversation history (which often contains sensitive code, files, and prompts).

## Recommendation

Require auth and filter results to records owned by the caller. If transcript IDs are timestamp-based, switch to UUIDs.

## Recent committers (`git log`)

- vishal veerareddy <vishalveera.reddy@servicenow.com> (2026-04-28)
- Vishal Veera Reddy <veerareddyvishal144@gmail.com> (2026-04-20)
- Vishal Veera Reddy <veerareddyvishal56@gmail.com> (2026-02-22)
