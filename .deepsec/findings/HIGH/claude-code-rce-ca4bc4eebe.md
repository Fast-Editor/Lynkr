# [HIGH] Git argument injection → RCE in workspace_git_pull via --upload-pack

**File:** [`src/tools/git.js`](https://github.com/Fast-Editor/Lynkr/blob/feat/parallel-tool-execution/blob/feat/src/tools/git.js#L659-L662) (lines 659, 660, 661, 662)
**Project:** claude-code
**Severity:** HIGH  •  **Confidence:** high  •  **Slug:** `rce`

## Owners

**Suggested assignee:** `vishalveera.reddy@servicenow.com` _(via last-committer)_

## Finding

workspace_git_pull (lines 656-683) takes args.remote and args.branch directly from the tool-call payload and passes them to git as positional arguments without an end-of-options separator: pullArgs = ['pull', remote, branch] (line 661). git's argument parser accepts options anywhere on the command line, including --upload-pack=<command>. For local-path remotes (which are reachable simply by passing a filesystem path or '.' as the remote), git invokes <command> in place of git-upload-pack on the local machine — i.e., RCE. Concrete attack payload: { remote: '.', branch: '--upload-pack=touch /tmp/pwned' } produces `git pull . --upload-pack=touch /tmp/pwned`, executing the command. Even simpler: { remote: '--upload-pack=...', branch: 'origin' } also works because git parses --upload-pack regardless of position. spawn(shell=false) defends against shell metacharacter injection but does NOT prevent git's own option parser from matching --upload-pack. The same arg-array-without-`--` pattern exists across most git tools in this file. Because Claude Code tools are reachable via prompt-injection (an attacker-controlled web page or file content can talk the model into invoking workspace_git_pull with crafted args), this is a realistic privilege-escalation primitive even without a malicious remote configured in the repo.

## Recommendation

Validate that remote and branch do not begin with '-' (reject or strip). Alternatively, pass --end-of-options before user-controlled args (git supports `git pull --end-of-options <remote> <branch>` since git 2.24). The robust pattern: pullArgs = ['pull', '--end-of-options', remote, branch]. Apply the same fix in every tool below.

## Recent committers (`git log`)

- vishal veerareddy <vishalveera.reddy@servicenow.com> (2025-12-03)
