# [MEDIUM] Entire process.env forwarded to spawned MCP server child processes

**File:** [`src/mcp/client.js`](https://github.com/Fast-Editor/Lynkr/blob/feat/parallel-tool-execution/blob/feat/src/mcp/client.js#L30-L40) (lines 30, 31, 32, 33, 40)
**Project:** claude-code
**Severity:** MEDIUM  •  **Confidence:** high  •  **Slug:** `secrets-exposure`

## Owners

**Suggested assignee:** `vishalveera.reddy@servicenow.com` _(via last-committer)_

## Finding

When starting an MCP server via stdio, the client merges the proxy's full process.env into the child's environment: `env = { ...process.env, ...(this.server.env ?? {}) }`. The proxy's process.env carries every credential the host loads — DATABRICKS_API_KEY, OPENAI_API_KEY, AZURE_OPENAI_API_KEY, AZURE_ANTHROPIC_API_KEY, AWS_BEDROCK_API_KEY, OPENROUTER_API_KEY, ZAI_API_KEY, MOONSHOT_API_KEY, VERTEX_API_KEY/GOOGLE_API_KEY, TINYFISH_API_KEY, WEB_SEARCH_API_KEY, etc. (see src/config/index.js). A community/third-party MCP server that only needs (e.g.) filesystem access therefore gains unrestricted read access to every API key the proxy holds, and can silently exfiltrate them. Notably, src/mcp/sandbox.js (lines 124-139) implements an explicit `passthroughEnv` whitelist for the sandboxed path; the non-sandboxed McpClient does not. Defaults for `MCP_SANDBOX_PASSTHROUGH_ENV` are `PATH,LANG,LC_ALL,TERM,HOME` — strong evidence the project considers wholesale env passthrough unsafe, yet client.js does exactly that.

## Recommendation

Mirror the sandbox's whitelist model: derive the child env from a small allowlist (PATH, HOME, LANG, LC_ALL, TERM) plus `serverConfig.env` and an opt-in `serverConfig.passthroughEnv` list. Never blindly forward the entire process.env to MCP server processes whose code is not part of the proxy's trust boundary.

## Recent committers (`git log`)

- vishal veerareddy <vishalveera.reddy@servicenow.com> (2025-12-04)
