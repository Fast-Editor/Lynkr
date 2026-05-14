# [MEDIUM] workspace_mcp_call invokes arbitrary MCP server method with arbitrary params

**File:** [`src/tools/mcp.js`](https://github.com/Fast-Editor/Lynkr/blob/feat/parallel-tool-execution/blob/feat/src/tools/mcp.js#L70-L87) (lines 70, 71, 72, 73, 74, 75, 76, 77, 78, 79, 80, 81, 82, 83, 84, 85, 86, 87)
**Project:** claude-code
**Severity:** MEDIUM  •  **Confidence:** medium  •  **Slug:** `other-mcp-method-allowlist`

## Owners

**Suggested assignee:** `vishalveera.reddy@servicenow.com` _(via last-committer)_

## Finding

The `workspace_mcp_call` tool (lines 68-103) takes server id, method name, and params entirely from the LLM/caller and dispatches them to the MCP client with no allow-list, no method validation, and no params schema check (lines 77-87). Configured MCP servers may expose tools with file-system, database, or external-API capabilities; prompt-injection by a remote client can drive the model to call ANY method on ANY configured server. There is also no auditable record beyond the metadata (server, method) — params content is not logged. Combined with `loadConfiguredServers()` being called inside the read-only `workspace_mcp_servers` handler (lines 14-15), an attacker can both enumerate available servers/methods and invoke them. While exposing MCP through the agent is the intended design, the absence of any per-method authorization layer means the security of every MCP server (including their own input validation) is the only line of defense.

## Recommendation

Add a configurable per-server method allow-list/deny-list (similar to evaluateSandboxRequest in src/mcp/permissions.js). At minimum, support a `mcp.callPolicy` config that maps server -> allowed methods, defaulting to deny for unknown methods. Log the full method name and a hash/digest of params for auditability.

## Recent committers (`git log`)

- vishal veerareddy <vishalveera.reddy@servicenow.com> (2025-12-03)
