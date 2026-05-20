# [MEDIUM] readExternalFile reads any absolute path with no validation, gated only by an LLM-set boolean flag

**File:** [`src/workspace/index.js`](https://github.com/Fast-Editor/Lynkr/blob/feat/parallel-tool-execution/blob/feat/src/workspace/index.js#L30-L38) (lines 30, 31, 32, 33, 34, 35, 36, 37, 38)
**Project:** claude-code
**Severity:** MEDIUM  •  **Confidence:** medium  •  **Slug:** `path-traversal`

## Owners

**Suggested assignee:** `developer@call-home.ch` _(via last-committer)_

## Finding

readExternalFile (L30-38) calls path.resolve on the supplied target and immediately reads it — there is no allow/deny list, no boundary check, no symlink resolution. The only guardrail lives one layer up in src/tools/workspace.js, where the fs_read handler refuses external paths unless `args.user_approved === true`. That flag is part of the tool arguments produced by the LLM, not by the server or an out-of-band human consent mechanism, so the gate relies entirely on the model behaving as instructed in its prompt. A prompt-injection or jailbroken model can simply set user_approved=true on a path like `~/.ssh/id_rsa`, `/etc/shadow`, or `~/.aws/credentials` and exfiltrate the contents through the tool result. There is also no audit log of approved external reads inside readExternalFile itself.

## Recommendation

Treat user_approved as untrusted input. Enforce a server-side allowlist (or at minimum a denylist that includes `/etc`, dotfile directories like `~/.ssh`, `~/.aws`, `~/.gnupg`, and the project's `.env`) inside readExternalFile, log every external read with the resolved path and session id, and consider requiring a separate out-of-band confirmation token (e.g., minted by an authenticated user surface) instead of trusting a boolean from the model's tool args. Resolve symlinks with fs.realpath before stat to prevent symlink-based escapes.

## Recent committers (`git log`)

- Björn Christoph <developer@call-home.ch> (2026-02-11)
- Vishal Veera Reddy <veerareddyvishal56@gmail.com> (2026-01-30)
- vishal veerareddy <vishalveera.reddy@servicenow.com> (2025-12-03)
