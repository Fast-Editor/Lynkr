# [HIGH] Git argument injection → RCE in workspace_git_rebase via --exec

**File:** [`src/tools/git.js`](https://github.com/Fast-Editor/Lynkr/blob/feat/parallel-tool-execution/blob/feat/src/tools/git.js#L729-L753) (lines 729, 738, 747, 753)
**Project:** claude-code
**Severity:** HIGH  •  **Confidence:** high  •  **Slug:** `rce`

## Owners

**Suggested assignee:** `vishalveera.reddy@servicenow.com` _(via last-committer)_

## Finding

workspace_git_rebase (lines 727-775) appends args.onto / args.upstream / args.branch as the upstream positional arg (line 753) without an end-of-options separator. git rebase supports --exec=<command>, which causes git to invoke <command> after every replayed commit. Payload { onto: '--exec=arbitrary_command' } produces `git rebase --exec=arbitrary_command`; if the workspace has commits ahead of upstream, the command is executed locally for each one. Even with --interactive, --exec lines are seeded into the todo list and run on resume. Because argv parsing happens before rebase decides what to replay, an attacker can also smuggle --exec via { onto: '--exec=cmd; valid-upstream' } depending on git version.

## Recommendation

Reject onto values starting with '-', or insert ['rebase', ...flags, '--end-of-options', onto]. Same fix for args.upstream / args.branch fallbacks.

## Recent committers (`git log`)

- vishal veerareddy <vishalveera.reddy@servicenow.com> (2025-12-03)
