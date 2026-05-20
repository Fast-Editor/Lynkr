# [HIGH] Path traversal bypass via prefix matching in resolveWorkspacePath / isExternalPath

**File:** [`src/workspace/index.js`](https://github.com/Fast-Editor/Lynkr/blob/feat/parallel-tool-execution/blob/feat/src/workspace/index.js#L27-L45) (lines 27, 45)
**Project:** claude-code
**Severity:** HIGH  •  **Confidence:** high  •  **Slug:** `path-traversal`

## Owners

**Suggested assignee:** `developer@call-home.ch` _(via last-committer)_

## Finding

Both resolveWorkspacePath (L40-49) and isExternalPath (L24-28) enforce the workspace boundary with `resolved.startsWith(workspaceRoot)`. Because no path separator is required at the boundary, any sibling directory whose name shares a prefix with workspaceRoot satisfies the check. Concrete bypass: with workspaceRoot=`/home/user/work`, supplying `../work-evil/secret` makes path.resolve produce `/home/user/work-evil/secret`, and `startsWith('/home/user/work')` returns true — the function returns the path without throwing. This propagates to every consumer that ultimately calls resolveWorkspacePath: readFile, writeFile, applyFilePatch, fileExists, the fs_read / fs_write / edit_patch tool handlers in src/tools/workspace.js, the indexer in src/indexer/index.js, the edits store in src/edits/index.js, git tooling in src/tools/git.js, and shell cwd resolution in src/tools/process.js / execution.js. An attacker (or compromised LLM) interacting with the unauthenticated /v1/messages endpoint can read and write arbitrary files in any sibling directory of the workspace root.

## Recommendation

Reject the path unless `resolved === workspaceRoot || resolved.startsWith(workspaceRoot + path.sep)`. A safer formulation is `const rel = path.relative(workspaceRoot, resolved); if (rel.startsWith('..') || path.isAbsolute(rel)) throw ...`. Apply the same fix to isExternalPath. Also normalize workspaceRoot once with `path.resolve` and consider using fs.realpath to defeat symlink-based escapes.

## Recent committers (`git log`)

- Björn Christoph <developer@call-home.ch> (2026-02-11)
- Vishal Veera Reddy <veerareddyvishal56@gmail.com> (2026-01-30)
- vishal veerareddy <vishalveera.reddy@servicenow.com> (2025-12-03)
