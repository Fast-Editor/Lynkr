# [MEDIUM] Unvalidated workspace path passed to graphify CLI as --workspace argument

**File:** [`src/tools/code-graph.js`](https://github.com/Fast-Editor/Lynkr/blob/feat/parallel-tool-execution/blob/feat/src/tools/code-graph.js#L169-L132) (lines 169, 170, 171, 172, 215, 216, 99, 100, 101, 132)
**Project:** claude-code
**Severity:** MEDIUM  •  **Confidence:** high  •  **Slug:** `other-workspace-path-injection`

## Owners

**Suggested assignee:** `vishalveera.reddy@servicenow.com` _(via last-committer)_

## Finding

`resolveWorkspace` (lines 169-186) accepts `options.workspace` directly from the caller without any validation. Per the module-level comment at lines 8-12, this value can be supplied via the `X-Lynkr-Workspace` HTTP header — meaning a remote client controls the workspace path that gets passed to the graphify CLI as `--workspace <path>` (lines 215-216). While `execFile` is used (preventing shell metacharacter injection), the graphify CLI will run with attacker-controlled --workspace and may return graph data for paths the user should not access. If an admin or prior tenant indexed sensitive directories (e.g., /etc, /home/other-user, repository roots of other projects), the attacker can query that graph data via getBlastRadius/getRelevantContext/getComplexitySignals/getGraphStats. Combined with `detectWorkspaceFromPaths` (lines 99-135) — which derives the workspace from absolute file paths embedded in conversation messages by computing their longest common prefix — an attacker who controls message content can also manipulate the workspace selection, bounded only by a `depth >= 2` heuristic that doesn't prevent paths like /var/log or /home/<user>/.ssh.

## Recommendation

Validate the workspace path against an allow-list (e.g., must start with workspaceRoot or one of a configured set of indexable roots). Reject absolute paths that resolve outside the configured workspace base. Additionally, in detectWorkspaceFromPaths, restrict the detected prefix to be within workspaceRoot to prevent message-content-driven workspace probing.

## Recent committers (`git log`)

- vishal veerareddy <vishalveera.reddy@servicenow.com> (2026-04-08)
