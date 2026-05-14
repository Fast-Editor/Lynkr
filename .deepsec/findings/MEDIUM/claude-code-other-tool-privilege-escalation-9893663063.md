# [MEDIUM] Filesystem agent files can override built-in agents' allowedTools

**File:** [`src/agents/definitions/loader.js`](https://github.com/Fast-Editor/Lynkr/blob/feat/parallel-tool-execution/blob/feat/src/agents/definitions/loader.js#L409-L528) (lines 409, 417, 421, 426, 449, 455, 500, 517, 528)
**Project:** claude-code
**Severity:** MEDIUM  •  **Confidence:** medium  •  **Slug:** `other-tool-privilege-escalation`

## Owners

**Suggested assignee:** `veerareddyvishal56@gmail.com` _(via last-committer)_

## Finding

`loadFilesystemAgents` (lines 409-435) reads `.claude/agents/*.md` from `process.cwd()` and `parseAgentFile` (lines 440-461) takes the YAML frontmatter's `tools` field verbatim into `allowedTools`. The precedence check on line 426 — `if (!this.agents.has(agent.name) || !this.agents.get(agent.name).builtIn)` — only protects built-ins from being clobbered by *first* filesystem load, but the order of `loadBuiltInAgentsSync()` then `loadFilesystemAgents()` means built-ins are already in the map when filesystem agents load, so this check correctly prevents override. However, an attacker who can write a NEW agent file (any name not in the built-in list) gets to define an agent with arbitrary `allowedTools` (including `Bash`, `Write`, `Edit`) and an arbitrary `systemPrompt`. If that agent is later invoked by the auto-delegation path (`findAgentForTask`, lines 500-538) — which scores agents by keyword match against the task description — the attacker-defined agent can hijack a benign-looking task and execute commands. Combined with the fact that `findAgentForTask` requires only `bestScore >= 5` (line 528), an attacker can craft a description with several long keywords (the keyword match on line 517 is `score += keyword.length`, so a single quoted phrase >5 chars wins) that selects their agent. This is local-only (requires write access to `.claude/agents`) but it's a real privilege escalation vector if any process or user with weaker filesystem privileges can drop files into that directory before the proxy starts.

## Recommendation

(1) Validate `config.tools` from filesystem agent files against an allowlist of permitted tool names, and reject filesystem agents that request privileged tools (Bash, Write, Edit) unless the file is signed or the user has explicitly opted in. (2) Refuse to register filesystem agents whose name matches a built-in (currently you silently keep the built-in but the filesystem one is still parsed). (3) Document that `.claude/agents` is a trust boundary equivalent to running arbitrary shell code, so users restrict its permissions. (4) Consider raising the `findAgentForTask` minimum score and excluding filesystem agents from auto-delegation entirely.

## Recent committers (`git log`)

- Vishal Veera Reddy <veerareddyvishal56@gmail.com> (2026-01-30)
- vishal veerareddy <vishalveera.reddy@servicenow.com> (2025-12-18)
