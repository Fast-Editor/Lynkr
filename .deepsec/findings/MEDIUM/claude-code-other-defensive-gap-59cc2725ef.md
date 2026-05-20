# [MEDIUM] Inconsistent case handling between Task block and tool allowlist check

**File:** [`src/agents/executor.js`](https://github.com/Fast-Editor/Lynkr/blob/feat/parallel-tool-execution/blob/feat/src/agents/executor.js#L231-L326) (lines 231, 232, 233, 314, 325, 326)
**Project:** claude-code
**Severity:** MEDIUM  •  **Confidence:** low  •  **Slug:** `other-defensive-gap`

## Owners

**Suggested assignee:** `161773990+Plaidmustache@users.noreply.github.com` _(via last-committer)_

## Finding

Line 231 uses case-sensitive equality (`toolUse.name === "Task"`) to block subagent recursion, while _isToolAllowed (L325) normalizes both sides to lowercase. _getFilteredTools also uses case-sensitive comparison for Task (L314). If the tool registry/dispatcher in executeToolCall is case-insensitive (mirroring _isToolAllowed) and a subagent's allowedTools list happens to permit a tool that lowercases to 'task' (or the model returns 'task' in lowercase), the recursion guard at L231 would be bypassed while the dispatcher could still match and execute the Task tool. This would allow infinite/deep subagent recursion leading to resource exhaustion and bypassing the explicit `Subagents cannot spawn other subagents` invariant. Likelihood depends on the dispatcher implementation, but the inconsistency itself is a defensive lapse.

## Recommendation

Normalize toolUse.name to lowercase before comparing to 'task': `if (toolUse.name.toLowerCase() === 'task')`. Apply the same normalization in _getFilteredTools at L314. Consider centralizing the recursion guard inside executeToolCall as defense in depth.

## Recent committers (`git log`)

- Plaidmustache <161773990+Plaidmustache@users.noreply.github.com> (2026-02-18)
- Vishal Veera Reddy <veerareddyvishal56@gmail.com> (2026-01-30)
- vishal veerareddy <vishalveera.reddy@servicenow.com> (2025-12-18)
