# Tool Calling & Execution Modes

Complete guide to Lynkr's tool calling system, execution modes, and custom tool development.

---

## Overview

Lynkr supports two tool execution modes:

- **Server Mode (default)**: Tools execute on Lynkr server
- **Client Mode (passthrough)**: Tools execute on client (Claude Code CLI/Cursor)

This enables flexible deployment scenarios: centralized tooling, security policies, or client-side file access.

---

## Tool Execution Modes

### Server Mode (Default)

**How it works:**
- Client sends request without tools
- Lynkr injects standard tools
- Model requests tool execution
- Tools run on Lynkr server
- Results sent back to model

**Benefits:**
- ✅ Centralized control
- ✅ Policy enforcement
- ✅ Consistent environment
- ✅ Works with any client

**Use cases:**
- Production deployments
- Team environments
- Policy-enforced workflows
- Air-gapped deployments

**Configuration:**
```bash
# Default - no configuration needed
# Server mode activates when client doesn't send tools
```

### Client Mode (Passthrough)

**How it works:**
- Client sends request with tools
- Lynkr passes tools to model
- Model requests tool execution
- Client executes tools locally
- Results sent back through Lynkr

**Benefits:**
- ✅ Local file system access
- ✅ User-specific permissions
- ✅ No server-side execution
- ✅ Familiar CLI behavior

**Use cases:**
- Claude Code CLI (default behavior)
- Local development
- Personal use
- Custom tooling

**Configuration:**
```bash
# Client sends tools in request
# Lynkr automatically uses passthrough mode
```

---

## Built-in Tools

### File Operations

#### Read Tool
**Purpose:** Read file contents

**Parameters:**
- `file_path` (string, required): Absolute path to file
- `offset` (number, optional): Line number to start reading from
- `limit` (number, optional): Number of lines to read

**Example:**
```json
{
  "name": "Read",
  "input": {
    "file_path": "/path/to/file.js",
    "offset": 0,
    "limit": 100
  }
}
```

**Features:**
- Automatic truncation (2,000 lines max)
- Line numbering
- UTF-8 support

#### Write Tool
**Purpose:** Write content to file

**Parameters:**
- `file_path` (string, required): Absolute path to file
- `content` (string, required): File content

**Example:**
```json
{
  "name": "Write",
  "input": {
    "file_path": "/path/to/file.js",
    "content": "console.log('Hello');"
  }
}
```

**Features:**
- Creates directories if needed
- Overwrites existing files
- UTF-8 encoding

#### Edit Tool
**Purpose:** Find and replace in file

**Parameters:**
- `file_path` (string, required): Absolute path to file
- `old_string` (string, required): Text to find
- `new_string` (string, required): Replacement text
- `replace_all` (boolean, optional): Replace all occurrences

**Example:**
```json
{
  "name": "Edit",
  "input": {
    "file_path": "/path/to/file.js",
    "old_string": "var x = 1;",
    "new_string": "const x = 1;",
    "replace_all": true
  }
}
```

### Git Operations

#### git_status Tool
**Purpose:** Check git repository status

**Example:**
```json
{
  "name": "git_status",
  "input": {}
}
```

**Returns:**
- Untracked files
- Modified files
- Staged changes
- Current branch

#### git_diff Tool
**Purpose:** Show git diff

**Parameters:**
- `staged` (boolean, optional): Show staged changes only

**Example:**
```json
{
  "name": "git_diff",
  "input": {
    "staged": false
  }
}
```

#### git_commit Tool
**Purpose:** Create git commit

**Parameters:**
- `message` (string, required): Commit message
- `files` (array, optional): Files to stage and commit

**Example:**
```json
{
  "name": "git_commit",
  "input": {
    "message": "Fix authentication bug",
    "files": ["src/auth.js", "test/auth.test.js"]
  }
}
```

**Policy enforcement:**
```bash
# Prevent git push
POLICY_GIT_ALLOW_PUSH=false

# Require tests before commit
POLICY_GIT_REQUIRE_TESTS=true
POLICY_GIT_TEST_COMMAND="npm test"
```

### Bash Execution

#### Bash Tool
**Purpose:** Execute shell commands

**Parameters:**
- `command` (string, required): Shell command to execute
- `timeout` (number, optional): Timeout in milliseconds (default: 120000)

**Example:**
```json
{
  "name": "Bash",
  "input": {
    "command": "npm test",
    "timeout": 60000
  }
}
```

**Features:**
- Automatic truncation (1,000 lines max)
- Working directory preservation
- Environment variable access
- Timeout protection

**Security:**
```bash
# Commands are NOT sandboxed by default
# Use with caution in server mode
```

### Search Operations

#### Grep Tool
**Purpose:** Search file contents (ripgrep-powered)

**Parameters:**
- `pattern` (string, required): Regex pattern to search
- `path` (string, optional): Directory to search (default: workspace)
- `glob` (string, optional): File pattern filter (e.g., "*.js")
- `type` (string, optional): File type (e.g., "js", "py")
- `output_mode` (string, optional): "content", "files_with_matches", "count"

**Example:**
```json
{
  "name": "Grep",
  "input": {
    "pattern": "function.*Auth",
    "glob": "*.js",
    "output_mode": "content"
  }
}
```

#### Glob Tool
**Purpose:** Find files by pattern

**Parameters:**
- `pattern` (string, required): Glob pattern (e.g., "**/*.js")
- `path` (string, optional): Directory to search

**Example:**
```json
{
  "name": "Glob",
  "input": {
    "pattern": "src/**/*.test.js"
  }
}
```

### Memory Operations

#### memory_search Tool
**Purpose:** Search long-term memories

**Parameters:**
- `query` (string, required): Search query

**Example:**
```json
{
  "name": "memory_search",
  "input": {
    "query": "authentication preferences"
  }
}
```

**Returns:**
- Top N relevant memories (default: 5)
- Memory type, content, importance
- Creation and access timestamps

#### memory_add Tool
**Purpose:** Manually add memory

**Parameters:**
- `content` (string, required): Memory content
- `memory_type` (string, required): "preference", "decision", "fact", "entity", "relationship"
- `importance` (number, optional): 0.0-1.0 (default: 1.0)

**Example:**
```json
{
  "name": "memory_add",
  "input": {
    "content": "User prefers TypeScript over JavaScript",
    "memory_type": "preference",
    "importance": 0.9
  }
}
```

#### memory_forget Tool
**Purpose:** Delete specific memory

**Parameters:**
- `query` (string, required): Search query to find memory to delete

**Example:**
```json
{
  "name": "memory_forget",
  "input": {
    "query": "old preference about MongoDB"
  }
}
```

---

## MCP Integration

### Model Context Protocol (MCP)

Lynkr supports MCP for dynamic tool registration.

**Features:**
- Automatic MCP server discovery
- JSON-RPC 2.0 communication
- Dynamic tool registration
- Optional sandbox isolation

### MCP Configuration

**Enable MCP:**
```bash
MCP_ENABLED=true  # default: true
```

**Sandbox mode:**
```bash
# Enable Docker sandbox for MCP tools
MCP_SANDBOX_ENABLED=true  # default: true

# Docker image for sandbox
MCP_SANDBOX_IMAGE=ubuntu:22.04
```

### MCP Server Discovery

**Locations searched:**
1. `./mcp-servers/` (workspace directory)
2. `~/.mcp/servers/` (user directory)
3. Environment variable: `MCP_SERVER_PATH`

**Example MCP server:**
```json
{
  "name": "my-custom-tool",
  "description": "Does something useful",
  "inputSchema": {
    "type": "object",
    "properties": {
      "input": {
        "type": "string",
        "description": "Input parameter"
      }
    },
    "required": ["input"]
  }
}
```

### Using MCP Tools

MCP tools are automatically registered and available to models:

```json
{
  "name": "my-custom-tool",
  "input": {
    "input": "test value"
  }
}
```

---

## Custom Tool Development

### Creating Custom Tools

**File structure:**
```
src/tools/
  ├── workspace.js    (Read, Write, Edit)
  ├── git.js          (git_status, git_diff, git_commit)
  ├── bash.js         (Bash)
  ├── search.js       (Grep, Glob)
  ├── memory.js       (memory_search, memory_add, memory_forget)
  └── custom.js       (Your custom tools)
```

**Custom tool template:**
```javascript
// src/tools/custom.js

const logger = require("pino")();

/**
 * Custom tool definition
 */
const myCustomTool = {
  name: "my_custom_tool",
  description: "Does something useful",
  input_schema: {
    type: "object",
    properties: {
      input: {
        type: "string",
        description: "Input parameter"
      }
    },
    required: ["input"]
  }
};

/**
 * Custom tool implementation
 */
async function executeMyCustomTool(input) {
  try {
    logger.info({ input }, "Executing my_custom_tool");

    // Your tool logic here
    const result = doSomething(input);

    return {
      success: true,
      result: result
    };
  } catch (error) {
    logger.error({ error }, "my_custom_tool failed");
    throw error;
  }
}

module.exports = {
  myCustomTool,
  executeMyCustomTool
};
```

### Registering Custom Tools

**File:** `src/tools/index.js`

```javascript
const { myCustomTool, executeMyCustomTool } = require("./custom");

// Add to STANDARD_TOOLS
const STANDARD_TOOLS = [
  // ... existing tools
  myCustomTool
];

// Add to tool executor
async function executeTool(toolName, toolInput) {
  switch (toolName) {
    // ... existing cases
    case "my_custom_tool":
      return await executeMyCustomTool(toolInput);
    default:
      throw new Error(`Unknown tool: ${toolName}`);
  }
}
```

### Tool Best Practices

1. **Error handling:**
```javascript
try {
  // Tool logic
} catch (error) {
  logger.error({ error, input }, "Tool execution failed");
  throw new Error(`Tool failed: ${error.message}`);
}
```

2. **Input validation:**
```javascript
function validateInput(input) {
  if (!input || typeof input !== "string") {
    throw new Error("Invalid input: expected string");
  }
}
```

3. **Logging:**
```javascript
logger.info({
  toolName: "my_custom_tool",
  input: input,
  duration: Date.now() - startTime
}, "Tool executed successfully");
```

4. **Timeout protection:**
```javascript
const timeout = 30000; // 30 seconds
const result = await Promise.race([
  executeTool(input),
  new Promise((_, reject) =>
    setTimeout(() => reject(new Error("Tool timeout")), timeout)
  )
]);
```

---

## Tool Policies

### Git Policies

**Prevent git push:**
```bash
POLICY_GIT_ALLOW_PUSH=false
```

**Require tests before commit:**
```bash
POLICY_GIT_REQUIRE_TESTS=true
POLICY_GIT_TEST_COMMAND="npm test"
```

**Example:**
```
User: "Commit these changes"
Assistant: *Runs git commit*
Lynkr: [Blocks] Running tests first (POLICY_GIT_REQUIRE_TESTS=true)
Lynkr: *Executes npm test*
Lynkr: Tests passed, proceeding with commit
```

### Web Fetch Policies

**Restrict allowed hosts:**
```bash
WEB_SEARCH_ALLOWED_HOSTS=github.com,stackoverflow.com
```

**Custom search endpoint:**
```bash
WEB_SEARCH_ENDPOINT=http://localhost:8888/search
```

### Workspace Policies

**Restrict workspace access:**
```bash
WORKSPACE_ROOT=/path/to/projects
```

**Max agent loop iterations:**
```bash
POLICY_MAX_STEPS=8
```

---

## Tool Security

### Server Mode Security

**Risks:**
- Tools run with Lynkr server permissions
- Can access server filesystem
- Can execute arbitrary commands

**Mitigations:**
1. **Run as unprivileged user:**
```bash
# Create dedicated user
useradd -r -s /bin/false lynkr

# Run as lynkr user
sudo -u lynkr npm start
```

2. **Use Docker isolation:**
```yaml
# docker-compose.yml
services:
  lynkr:
    user: "1000:1000"  # Non-root user
    read_only: true     # Read-only root filesystem
    volumes:
      - ./workspace:/workspace  # Limited access
```

3. **Enable policies:**
```bash
POLICY_GIT_ALLOW_PUSH=false
POLICY_GIT_REQUIRE_TESTS=true
WEB_SEARCH_ALLOWED_HOSTS=github.com
WORKSPACE_ROOT=/workspace
```

### Client Mode Security

**Risks:**
- Tools run with client user permissions
- Can access client filesystem
- Can execute commands on client machine

**Mitigations:**
- Review tool calls before execution
- Use Claude Code CLI safety features
- Run client in restricted environment

---

## Debugging Tools

### Enable tool logging

```bash
LOG_LEVEL=debug npm start
```

**Output:**
```json
{
  "level": "debug",
  "msg": "Tool executed",
  "toolName": "Read",
  "input": {"file_path": "/path/to/file.js"},
  "duration": 12,
  "success": true
}
```

### Test tool execution

```bash
# Test Read tool
curl -X POST http://localhost:8081/v1/messages \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-3.5-sonnet",
    "messages": [{"role": "user", "content": "Read package.json"}],
    "max_tokens": 1024
  }'
```

---

## Next Steps

- **[MCP Integration Guide](mcp.md)** - Model Context Protocol setup
- **[Production Guide](production.md)** - Production deployment
- **[API Reference](api.md)** - API endpoints
- **[FAQ](faq.md)** - Common questions

---

## Getting Help

- **[GitHub Discussions](https://github.com/Fast-Editor/Lynkr/discussions)** - Ask questions
- **[GitHub Issues](https://github.com/Fast-Editor/Lynkr/issues)** - Report issues
