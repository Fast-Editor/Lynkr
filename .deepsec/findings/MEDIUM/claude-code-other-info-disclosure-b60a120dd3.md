# [MEDIUM] Workspace auto-detection from attacker-controlled message file paths

**File:** [`src/tools/code-graph.js`](https://github.com/Fast-Editor/Lynkr/blob/feat/parallel-tool-execution/blob/feat/src/tools/code-graph.js#L99-L134) (lines 99, 101, 105, 123, 132, 134)
**Project:** claude-code
**Severity:** MEDIUM  •  **Confidence:** high  •  **Slug:** `other-info-disclosure`

## Owners

**Suggested assignee:** `vishalveera.reddy@servicenow.com` _(via last-committer)_

## Finding

detectWorkspaceFromPaths (lines 99-135) uses absolute file paths supplied via the conversation messages to compute a workspace via longest-common-prefix. An attacker who can include arbitrary absolute paths in their messages (e.g., `/home/victim/.ssh/id_rsa`, `/var/lib/postgres/...`) can manipulate which directory is treated as the workspace and queried by graphify. The depth>=2 floor (line 132) prevents `/etc` (depth 1) but allows `/var/log`, `/home/<user>`, `/opt/<app>`, etc. This is an information-disclosure vector that compounds with the workspace header injection above.

## Recommendation

Constrain auto-detected workspaces to be within an allow-listed set of roots (e.g., must start with workspaceRoot). Do not derive trust from message content.

## Recent committers (`git log`)

- vishal veerareddy <vishalveera.reddy@servicenow.com> (2026-04-08)
