# [MEDIUM] Path traversal in readTranscript via unsanitized agentId

**File:** [`src/agents/context-manager.js`](https://github.com/Fast-Editor/Lynkr/blob/feat/parallel-tool-execution/blob/feat/src/agents/context-manager.js#L181-L188) (lines 181, 182, 188)
**Project:** claude-code
**Severity:** MEDIUM  •  **Confidence:** medium  •  **Slug:** `path-traversal`

## Owners

**Suggested assignee:** `vishalveera.reddy@servicenow.com` _(via last-committer)_

## Finding

readTranscript(agentId) interpolates agentId directly into a filesystem path: `path.join(this.transcriptsDir, agent-${agentId}.jsonl)`. While agent IDs created by generateAgentId() are server-controlled and safe (they're `${Date.now()}_${Math.random()...}`), this method accepts any string. If readTranscript is exposed via any debug/admin endpoint or callable with attacker-influenced input, an agentId of `../../some-other-file` would resolve outside the transcripts directory (the .jsonl extension is appended but does not prevent traversal of directory boundaries). The function then reads the file and parses each line as JSON, so an attacker could read arbitrary .jsonl files on disk and partially exfiltrate JSON-formatted data from anywhere the process can reach.

## Recommendation

Validate that agentId matches the expected format produced by generateAgentId() (e.g., `/^\d+_[a-z0-9]{1,8}$/`) before using it in path.join, and/or use path.resolve to verify the resolved path stays within this.transcriptsDir before reading.

## Recent committers (`git log`)

- vishal veerareddy <vishalveera.reddy@servicenow.com> (2025-12-11)
