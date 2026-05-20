# [HIGH] Workspace boundary check bypassable via sibling-directory prefix match

**File:** [`src/tools/workspace.js`](https://github.com/Fast-Editor/Lynkr/blob/feat/parallel-tool-execution/blob/feat/src/tools/workspace.js#L41-L157) (lines 41, 66, 102, 157)
**Project:** claude-code
**Severity:** HIGH  •  **Confidence:** high  •  **Slug:** `path-traversal`

## Owners

**Suggested assignee:** `developer@call-home.ch` _(via last-committer)_

## Finding

All three workspace tools (fs_read at L36, fs_write at L82, edit_patch at L146) rely on resolveWorkspacePath / isExternalPath in src/workspace/index.js to enforce the workspace boundary. Both helpers use `resolved.startsWith(workspaceRoot)` (workspace/index.js L27, L45) without appending `path.sep`. With workspaceRoot = '/foo/work', a relative path like '../work2/secret' resolves to '/foo/work2/secret', and the string `'/foo/work2/secret'.startsWith('/foo/work')` returns true. This means: (1) isExternalPath returns false (treats sibling-directory paths as INTERNAL, completely skipping the user_approved gate at L42), and (2) resolveWorkspacePath then accepts the path as in-workspace. As a result, fs_read can silently read, fs_write can silently write, and edit_patch can silently mutate any file under any sibling directory whose name shares the workspaceRoot prefix (e.g. '/foo/workspace_backup', '/foo/workspace2', '/foo/workspace.bak'). No user approval flow is triggered. This is the classic 'startsWith-without-sep' path traversal CWE-22.

## Recommendation

Fix the prefix check in src/workspace/index.js to require a trailing separator, e.g. `resolved === workspaceRoot || resolved.startsWith(workspaceRoot + path.sep)`. Alternatively use `path.relative(workspaceRoot, resolved)` and reject results that start with `..` or are absolute. Apply the fix in both isExternalPath (L27) and resolveWorkspacePath (L45).

## Recent committers (`git log`)

- Björn Christoph <developer@call-home.ch> (2026-02-11)
- vishal veerareddy <vishalveera.reddy@servicenow.com> (2025-12-03)
