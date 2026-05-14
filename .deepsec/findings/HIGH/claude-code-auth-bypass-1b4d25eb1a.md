# [HIGH] fs_read external-file gate trusts an LLM-controlled `user_approved` flag

**File:** [`src/tools/workspace.js`](https://github.com/Fast-Editor/Lynkr/blob/feat/parallel-tool-execution/blob/feat/src/tools/workspace.js#L42-L56) (lines 42, 50, 56)
**Project:** claude-code
**Severity:** HIGH  •  **Confidence:** high  •  **Slug:** `auth-bypass`

## Owners

**Suggested assignee:** `developer@call-home.ch` _(via last-committer)_

## Finding

fs_read (L36-77) treats `args.user_approved === true` as proof that the human user approved reading a file outside the workspace, and on that basis calls readExternalFile() — which uses path.resolve() with no allowlist or workspace constraint (workspace/index.js L30-38) and will return the contents of ANY readable file on the host. The 'approval' is just a parameter inside the tool-call JSON, which is produced by the LLM. The tool merely embeds an English instruction asking the model to seek consent first (L50). Under prompt injection — extremely realistic given the agent has tools like web_agent and fs_read that ingest external content — an attacker can instruct the LLM to call fs_read with `user_approved: true` and `path: '~/.ssh/id_rsa'`, `'/etc/passwd'`, `'~/.aws/credentials'`, `'~/.env'`, `'~/.gnupg/'` etc. The expandTilde helper (workspace/index.js L13-22) honors `~`, making home-directory secrets directly addressable. There is no out-of-band human confirmation, no allowlist, no symlink check, and no audit gate — only the model's self-reported approval status.

## Recommendation

Replace the in-band `user_approved` flag with a real out-of-band approval mechanism (e.g. an interactive prompt to the human via the host application, MCP elicitation, or a signed approval token bound to a specific path and session). At minimum, maintain a strict allowlist of permitted external roots, reject paths under sensitive directories (~/.ssh, ~/.aws, ~/.gnupg, /etc, /proc, /sys, /root, /var/lib, /etc/shadow, etc.), resolve symlinks before access, and log every external read.

## Recent committers (`git log`)

- Björn Christoph <developer@call-home.ch> (2026-02-11)
- vishal veerareddy <vishalveera.reddy@servicenow.com> (2025-12-03)
