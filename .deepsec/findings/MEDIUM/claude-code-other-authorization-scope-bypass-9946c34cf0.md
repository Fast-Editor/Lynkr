# [MEDIUM] mcp_execute forwards arbitrary JSON-RPC methods, bypassing the 'tool' authorization scope

**File:** [`src/tools/code-mode.js`](https://github.com/Fast-Editor/Lynkr/blob/feat/parallel-tool-execution/blob/feat/src/tools/code-mode.js#L248-L278) (lines 248, 252, 258, 263, 278)
**Project:** claude-code
**Severity:** MEDIUM  •  **Confidence:** high  •  **Slug:** `other-authorization-scope-bypass`

## Owners

**Suggested assignee:** `vishalveera.reddy@servicenow.com` _(via last-committer)_

## Finding

The mcp_execute meta-tool (lines 247-275) forwards args.tool_name verbatim into client.request(toolName.trim(), toolArgs) on line 263. Looking at McpClient.request() in src/mcp/client.js:122-145, this writes a raw JSON-RPC payload {method: <whatever the LLM provided>, params: <args>} to the MCP server's stdin. Crucially, mcp_execute does NOT validate that toolName appears in the list of tools returned by tools/list; it does not call tools/call with {name, arguments} per MCP convention. As a result, the LLM can call ANY JSON-RPC method the MCP server exposes — for example: 'resources/read' to read arbitrary file:// or https:// URIs the server has been granted, 'prompts/get' to extract templated prompts, 'logging/setLevel' to flip server log verbosity, 'completion/complete', server-specific debug/admin methods, or even 'initialize' to re-handshake with elevated capabilities. The introductory description (line 278) describes this as 'execute an MCP tool by name', but the implementation grants the LLM full RPC reach into every connected MCP server, effectively widening the attack surface beyond what the operator intended when they exposed certain tools. Compare with the conventional implementation in src/tools/mcp-remote.js:50-57, which fixes the method per registered tool — there the LLM cannot pivot to other methods.

## Recommendation

Before calling client.request, look up toolName in the cached tools/list result for serverId. Reject if not present. Better: invoke MCP tools the standard way — client.request('tools/call', { name: toolName, arguments: toolArgs }) — so non-tool methods (resources/*, prompts/*, logging/*, etc.) are never reachable from this surface. If reaching resources or prompts is desired, add explicit, separately authorized meta-tools (mcp_resource_read, mcp_prompt_get) so an operator can opt in.

## Recent committers (`git log`)

- vishal veerareddy <vishalveera.reddy@servicenow.com> (2026-04-15)
