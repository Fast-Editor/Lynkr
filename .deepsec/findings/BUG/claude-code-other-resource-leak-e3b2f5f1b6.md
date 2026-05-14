# [BUG] Timeout via Promise.race does not cancel the underlying agent loop

**File:** [`src/agents/executor.js`](https://github.com/Fast-Editor/Lynkr/blob/feat/parallel-tool-execution/blob/feat/src/agents/executor.js#L32-L39) (lines 32, 33, 34, 35, 36, 37, 38, 39)
**Project:** claude-code
**Severity:** BUG  •  **Confidence:** high  •  **Slug:** `other-resource-leak`

## Owners

**Suggested assignee:** `161773990+Plaidmustache@users.noreply.github.com` _(via last-committer)_

## Finding

The execute() method races _runAgentLoop against a setTimeout-rejecting promise. When the timeout fires, the Promise.race settles and an error is thrown, but the underlying _runAgentLoop continues running — it has no AbortController, no cancellation token, and no cooperative termination check tied to the timer. Any in-flight model call or tool execution (which can include long-running shell commands or network requests) will continue consuming resources after the agent has been marked failed. Repeated timeouts could thus accumulate orphaned operations, potentially exhausting connections, file descriptors, or token budget. Additionally, the setTimeout handle is never cleared on success path, so the timer fires later and rejects an already-settled promise (handled benignly by Promise.race but still wastes a timer).

## Recommendation

Replace Promise.race with an AbortController passed into _runAgentLoop and downstream into invokeModel and executeToolCall. Check context.aborted in the while-loop condition and at each tool boundary. On success, clearTimeout the timer handle.

## Recent committers (`git log`)

- Plaidmustache <161773990+Plaidmustache@users.noreply.github.com> (2026-02-18)
- Vishal Veera Reddy <veerareddyvishal56@gmail.com> (2026-01-30)
- vishal veerareddy <vishalveera.reddy@servicenow.com> (2025-12-18)
