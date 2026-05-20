# [MEDIUM] No symlink resolution before workspace boundary check

**File:** [`src/tools/workspace.js`](https://github.com/Fast-Editor/Lynkr/blob/feat/parallel-tool-execution/blob/feat/src/tools/workspace.js#L66-L157) (lines 66, 102, 157)
**Project:** claude-code
**Severity:** MEDIUM  •  **Confidence:** medium  •  **Slug:** `other-symlink-escape`

## Owners

**Suggested assignee:** `developer@call-home.ch` _(via last-committer)_

## Finding

resolveWorkspacePath (workspace/index.js L40-49) uses path.resolve, which normalizes `..` and `.` segments but does NOT resolve symlinks. If any directory inside the workspace contains a symlink pointing outside the workspace (planted via fs_write, edit_patch, or pre-existing on disk), subsequent fs_read / fs_write / edit_patch calls that traverse the symlink will read or write outside the workspace while still passing the prefix check. Combined with fs_write being unbounded by user_approved, an attacker who once writes a symlink (e.g. `ln -s / inside`) can subsequently read or overwrite anything via './inside/etc/passwd'.

## Recommendation

Use fs.realpath/fs.realpathSync on the resolved path before the boundary check, then compare with `path.sep`-aware prefix matching. Reject paths whose realpath escapes workspaceRoot.

## Recent committers (`git log`)

- Björn Christoph <developer@call-home.ch> (2026-02-11)
- vishal veerareddy <vishalveera.reddy@servicenow.com> (2025-12-03)
