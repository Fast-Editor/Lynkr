# [MEDIUM] Path traversal via unsanitized agentType in skillbook file path

**File:** [`src/agents/skillbook.js`](https://github.com/Fast-Editor/Lynkr/blob/feat/parallel-tool-execution/blob/feat/src/agents/skillbook.js#L302-L249) (lines 302, 303, 304, 305, 210, 219, 249)
**Project:** claude-code
**Severity:** MEDIUM  •  **Confidence:** medium  •  **Slug:** `path-traversal`

## Owners

**Suggested assignee:** `vishalveera.reddy@servicenow.com` _(via last-committer)_

## Finding

_getFilePath() interpolates `this.agentType.toLowerCase()` directly into a filesystem path: `path.join(dataDir, ${this.agentType.toLowerCase()}.json)`. There is no validation that agentType lacks `..` or path separators. If agentType is influenced by attacker-controlled input (e.g., a prompt that creates a custom agent definition, an agent name loaded from an untrusted definition file, or a user-supplied agent type that propagates through Skillbook.load(context.agentName)), an agentType like `../../etc/passwd` would cause: (1) save() to write attacker-controlled JSON content (`{agentType, skills: [...], savedAt, version}`) to an arbitrary path the process can write to — potentially overwriting config files, ssh keys, or shell rc files; (2) load() to attempt reading arbitrary JSON files. The .json suffix is appended but does not prevent breakout from the data/skillbooks/ directory. Notably, save() also recursively creates directories via fs.mkdir(dir, { recursive: true }), allowing an attacker to create unexpected directory structures.

## Recommendation

Sanitize agentType in _getFilePath: reject any value containing path separators or `..`, or normalize with `path.basename(agentType.toLowerCase()).replace(/[^a-z0-9_-]/g, '')`. After constructing the path, verify it resolves inside dataDir using path.resolve and a startsWith check before performing fs operations.

## Recent committers (`git log`)

- vishal veerareddy <vishalveera.reddy@servicenow.com> (2025-12-18)
