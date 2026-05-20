# [HIGH] validateCwd accepts arbitrary host directories outside the workspace, enabling sandbox escape on the unauthenticated API

**File:** [`src/workspace/index.js`](https://github.com/Fast-Editor/Lynkr/blob/feat/parallel-tool-execution/blob/feat/src/workspace/index.js#L120-L135) (lines 120, 121, 122, 123, 124, 125, 126, 127, 128, 129, 130, 131, 132, 133, 134, 135)
**Project:** claude-code
**Severity:** HIGH  •  **Confidence:** high  •  **Slug:** `other-sandbox-escape`

## Owners

**Suggested assignee:** `developer@call-home.ch` _(via last-committer)_

## Finding

validateCwd (L120-135) only checks that the client-supplied path resolves to an existing directory; it does not confine the result to workspaceRoot. The router exposes this directly: src/api/router.js:301 reads `req.body?.cwd || req.headers['x-workspace-cwd']` and passes the result through validateCwd into processMessage as `clientCwd`. The /v1/messages route has only a rate-limiter and the sessionMiddleware (which auto-generates a session ID when none is provided — no real authentication). The chosen cwd is then handed to runProcess (src/tools/process.js:60-61), which short-circuits when `path.isAbsolute(cwd)` is true and uses the value as spawn's cwd without any workspace check. The shell tool uses `bash -lc <command>` (src/tools/execution.js:60-61), so an attacker can reach any directory the Node process has access to (e.g., cwd=`/etc`, cwd=$HOME, cwd=`/`) and run arbitrary commands relative to it. This converts a path traversal foothold into full read/write/exec on the host, scoped only by the OS user the proxy runs as. Even when the prefix-match bug above is fixed, validateCwd alone breaks the workspace boundary because the resulting cwd never re-enters resolveWorkspacePath.

## Recommendation

Either remove validateCwd entirely and force every cwd through resolveWorkspacePath, or have validateCwd confine the resolved path to workspaceRoot using `resolved === workspaceRoot || resolved.startsWith(workspaceRoot + path.sep)` and return null otherwise. Additionally, gate /v1/messages behind real authentication (API key, bearer token, or at minimum a localhost-only bind) before accepting client-supplied cwd via body or x-workspace-cwd header. In src/tools/process.js, do not bypass resolveWorkspacePath when cwd is absolute — re-validate it against workspaceRoot.

## Recent committers (`git log`)

- Björn Christoph <developer@call-home.ch> (2026-02-11)
- Vishal Veera Reddy <veerareddyvishal56@gmail.com> (2026-01-30)
- vishal veerareddy <vishalveera.reddy@servicenow.com> (2025-12-03)
