# [MEDIUM] Git argument injection across push, merge, checkout, stage, unstage, stash

**File:** [`src/tools/git.js`](https://github.com/Fast-Editor/Lynkr/blob/feat/parallel-tool-execution/blob/feat/src/tools/git.js#L519-L1249) (lines 519, 521, 553, 555, 627, 703, 859, 962, 1124, 1128, 1212, 1248, 1249)
**Project:** claude-code
**Severity:** MEDIUM  •  **Confidence:** high  •  **Slug:** `other-argument-injection`

## Owners

**Suggested assignee:** `vishalveera.reddy@servicenow.com` _(via last-committer)_

## Finding

The same 'positional arg without --' pattern repeats across the file: workspace_git_push (line 627: ['push', remote, branch]; --receive-pack=<cmd> would affect server side, but local-path remotes get RCE), workspace_git_merge (line 703: appends user-controlled source; --strategy and other flags injectable), workspace_git_checkout (line 859: ['checkout', '-b', branch] or ['checkout', branch] — branch may be --orphan or other modifying option, arbitrary branch creation/state mutation), workspace_git_stage (lines 519, 521: ['add', ...paths] — `-f` lets the LLM force-add gitignored files, including .env, secrets, etc.; also --pathspec-from-file=/etc/passwd to leak file contents into errors), workspace_git_unstage (lines 553, 555 similar), workspace_git_branches (line 829, 838 — output parsing assumes well-formed lines; relatively harmless), workspace_diff_by_commit (line 1212-1213: ['show', ..., hash] with hash from earlier git output, but limit/since/until are user-controlled and concatenated in commitsArgs). The cumulative effect is that a prompt-injection attacker can exfiltrate gitignored files, manipulate branch state, and influence operations the operator did not intend — even where direct RCE isn't achievable.

## Recommendation

Adopt a uniform rule: any user-supplied argument that follows a git subcommand must either (a) be validated to not start with '-', or (b) be placed after `--` (or `--end-of-options` for full git option parsing). The simplest universal fix: prepend `'--end-of-options'` before any user-controlled positional in every tool. For workspace_git_stage in particular, also reject paths starting with '-'.

## Recent committers (`git log`)

- vishal veerareddy <vishalveera.reddy@servicenow.com> (2025-12-03)
