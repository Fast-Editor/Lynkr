# [MEDIUM] python_exec accepts arbitrary executable, allowing it to run any binary

**File:** [`src/tools/execution.js`](https://github.com/Fast-Editor/Lynkr/blob/feat/parallel-tool-execution/blob/feat/src/tools/execution.js#L125-L152) (lines 125, 134, 135, 139, 152)
**Project:** claude-code
**Severity:** MEDIUM  •  **Confidence:** high  •  **Slug:** `other-misnamed-exec-tool`

## Owners

**Suggested assignee:** `veerareddyvishal56@gmail.com` _(via last-committer)_

## Finding

The `python_exec` tool (lines 108-160) accepts a fully attacker-controlled `executable` parameter (line 125: `args.executable ?? args.python ?? "python3"`) and pipes the supplied `code` string into stdin via `args: ['-']`. There is no validation that the executable is python — it can be any binary on $PATH or any absolute path (e.g., `executable: '/bin/sh'`, `executable: '/usr/bin/perl'`, `executable: 'curl'`). Combined with the cwd boundary bypass in process.js (see separate finding), this gives the LLM (and via prompt injection, a remote client) a generic exec primitive with a misleading name. The metadata returned only shows `path.basename(executable)` (line 152), making forensic detection harder if a non-python binary is invoked. While the generic `shell` tool already provides RCE capabilities for the proxy operator's own use, the misnamed tool is more likely to slip past policy/audit allow-lists that look for known dangerous tool names.

## Recommendation

Either rename the tool to `code_exec`/`script_exec` (truth in advertising) and document the executable parameter explicitly, OR validate that `executable` is one of an allow-list of interpreters (`python3`, `python`, configured interpreter paths). At minimum, log the full executable path (not just basename) for auditability.

## Recent committers (`git log`)

- Vishal Veera Reddy <veerareddyvishal56@gmail.com> (2026-01-30)
- vishal veerareddy <vishalveera.reddy@servicenow.com> (2025-12-03)
