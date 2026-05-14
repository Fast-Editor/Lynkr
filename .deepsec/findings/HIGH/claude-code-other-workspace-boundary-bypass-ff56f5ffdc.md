# [HIGH] Absolute cwd from client header bypasses workspace sandbox boundary

**File:** [`src/tools/process.js`](https://github.com/Fast-Editor/Lynkr/blob/feat/parallel-tool-execution/blob/feat/src/tools/process.js#L60-L94) (lines 60, 61, 94)
**Project:** claude-code
**Severity:** HIGH  •  **Confidence:** high  •  **Slug:** `other-workspace-boundary-bypass`

## Owners

**Suggested assignee:** `veerareddyvishal56@gmail.com` _(via last-committer)_

## Finding

process.js trusts already-absolute cwd values without re-validating them against workspaceRoot (lines 60-61: `if (path.isAbsolute(cwd)) { resolvedCwd = cwd; }`). When the shell/python_exec tools call runProcess with `context.cwd` (originating from the `x-workspace-cwd` HTTP header or `cwd` body field of /v1/messages), that value was only validated by `validateCwd()` in src/workspace/index.js:120-135, which checks only that the path is a directory — it does NOT enforce containment within `workspaceRoot`. The comment in src/tools/execution.js:16 ('Already validated absolute path') is misleading: validation in validateCwd() is incomplete. Attack flow: (1) attacker sends POST /v1/messages with header `x-workspace-cwd: /` (or any path on disk), (2) prompt-injects the model into calling the `shell` tool, (3) the proxy spawns commands with cwd anywhere on the host. The codebase clearly intends to enforce a workspace boundary — `resolveWorkspacePath` rejects paths outside `workspaceRoot` (workspace/index.js:45-47), and explicit `args.cwd` IS routed through it (execution.js:15). But the parallel context.cwd path is not. This makes the workspace sandbox bypassable for the agent execution tools and is a privilege escalation: even if an operator audited `resolveWorkspacePath` and concluded the workspace is contained, the cwd header completely defeats that containment.

## Recommendation

Either (a) always re-validate cwd against workspaceRoot in process.js by routing absolute paths through a `assertWithinWorkspace(cwd)` check, or (b) fix validateCwd in src/workspace/index.js to verify `resolved.startsWith(workspaceRoot)` before returning. The simplest fix is to make validateCwd reject any path outside workspaceRoot to keep the boundary consistent: `if (!resolved.startsWith(workspaceRoot)) return null;` after the existing isDirectory check.

## Recent committers (`git log`)

- Vishal Veera Reddy <veerareddyvishal56@gmail.com> (2026-01-30)
- vishal veerareddy <vishalveera.reddy@servicenow.com> (2025-12-03)
