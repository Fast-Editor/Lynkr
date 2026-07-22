# Tool Calling

Complete guide to Lynkr's tool calling system.

---

## Overview

Lynkr never executes tool calls itself. It forwards `tool_use` blocks from the model to the client (Claude Code CLI/Cursor), which executes the tools locally and sends the results back as the next request.

This keeps file access, shell commands, and permissions on your machine, with Lynkr acting purely as a proxy between the client and the model provider.

---

## Tool Execution

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

**Configuration:**
```bash
# Nothing to configure - tools always execute on the client
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

Tools run with client user permissions, so they can access the client filesystem and execute commands on the client machine.

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

### Test tool calling

```bash
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
