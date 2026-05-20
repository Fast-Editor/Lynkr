# [HIGH] normaliseCwd trusts context.cwd without workspace containment check

**File:** [`src/tools/execution.js`](https://github.com/Fast-Editor/Lynkr/blob/feat/parallel-tool-execution/blob/feat/src/tools/execution.js#L13-L126) (lines 13, 14, 15, 16, 17, 52, 126)
**Project:** claude-code
**Severity:** HIGH  •  **Confidence:** high  •  **Slug:** `other-workspace-boundary-bypass`

## Owners

**Suggested assignee:** `veerareddyvishal56@gmail.com` _(via last-committer)_

## Finding

normaliseCwd (lines 13-18) has a comment claiming context.cwd is 'Already validated absolute path', but the only validation it received is from `validateCwd()` in src/workspace/index.js, which checks only that the directory exists — it does NOT enforce containment within workspaceRoot. As a result, `args.cwd` is correctly funneled through `resolveWorkspacePath` (line 15) which enforces the boundary, but `context.cwd` (originating from the `x-workspace-cwd` header / `cwd` body field on POST /v1/messages) is returned as-is and reaches `runProcess` where it is used verbatim as the spawn cwd. This is the same root vulnerability as in process.js — the workspace boundary is selectively enforced and bypassable via the request-level cwd. Listed separately here because the comment on line 16 is the proximate misunderstanding to fix.

## Recommendation

Replace the trust-based `if (contextCwd) return contextCwd;` with `if (contextCwd) return resolveWorkspacePath(contextCwd);`, OR fix validateCwd in src/workspace/index.js to enforce `startsWith(workspaceRoot)`. Remove the misleading 'Already validated' comment.

## Recent committers (`git log`)

- Vishal Veera Reddy <veerareddyvishal56@gmail.com> (2026-01-30)
- vishal veerareddy <vishalveera.reddy@servicenow.com> (2025-12-03)
