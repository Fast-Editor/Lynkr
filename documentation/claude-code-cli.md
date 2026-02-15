# Claude Code CLI Setup Guide

Complete guide to using Claude Code CLI with Lynkr for provider flexibility, cost savings, and local model support.

---

## Overview

Lynkr acts as a drop-in replacement for Anthropic's backend, enabling Claude Code CLI to work with any LLM provider (Databricks, Bedrock, OpenRouter, Ollama, etc.) while maintaining full compatibility with all Claude Code features.

### Why Use Lynkr with Claude Code CLI?

- 💰 **60-80% cost savings** through token optimization
- 🔓 **Provider choice** - Use any of 9+ supported providers
- 🏠 **Self-hosted** - Full control over your AI infrastructure
- 🔒 **Local option** - Run 100% offline with Ollama or llama.cpp
- ✅ **Zero code changes** - Drop-in replacement for Anthropic backend
- 📊 **Full observability** - Logs, metrics, token tracking

---

## Quick Setup (3 Minutes)

### Step 1: Install Lynkr

```bash
# Option A: NPM (Recommended)
npm install -g lynkr

# Option B: Homebrew (macOS)
brew tap vishalveerareddy123/lynkr
brew install lynkr

# Option C: Git Clone
git clone https://github.com/vishalveerareddy123/Lynkr.git
cd Lynkr && npm install
```

---

### Step 2: Configure Provider

Choose your provider and configure credentials:

**Option A: AWS Bedrock (100+ models)**
```bash
export MODEL_PROVIDER=bedrock
export AWS_BEDROCK_API_KEY=your-bearer-token
export AWS_BEDROCK_REGION=us-east-1
export AWS_BEDROCK_MODEL_ID=anthropic.claude-3-5-sonnet-20241022-v2:0
```

**Option B: Ollama (100% Local, FREE)**
```bash
# Start Ollama first
ollama serve
ollama pull llama3.1:8b

export MODEL_PROVIDER=ollama
export OLLAMA_MODEL=llama3.1:8b
```

**Option C: OpenRouter (Simplest Cloud)**
```bash
export MODEL_PROVIDER=openrouter
export OPENROUTER_API_KEY=sk-or-v1-your-key
export OPENROUTER_MODEL=anthropic/claude-3.5-sonnet
```

**Option D: Databricks (Enterprise)**
```bash
export MODEL_PROVIDER=databricks
export DATABRICKS_API_BASE=https://your-workspace.databricks.com
export DATABRICKS_API_KEY=dapi1234567890abcdef
```

See [Provider Configuration Guide](providers.md) for all 9+ providers.

---

### Step 3: Start Lynkr

```bash
lynkr start
# Or: npm start (if installed from source)

# Wait for: "Server listening at http://0.0.0.0:8081"
```

---

### Step 4: Configure Claude Code CLI

Point Claude Code CLI to Lynkr instead of Anthropic:

```bash
# Set Lynkr as backend
export ANTHROPIC_BASE_URL=http://localhost:8081
export ANTHROPIC_API_KEY=dummy  # Required by CLI, but ignored by Lynkr

# Verify configuration
echo $ANTHROPIC_BASE_URL
# Should show: http://localhost:8081
```

---

### Step 5: Test It

```bash
# Simple test
claude "What is 2+2?"

# Should return response from your configured provider ✅

# File operation test
claude "List files in current directory"

# Should use Read/Bash tools ✅
```

---

## Configuration Options

### Environment Variables

**Core Variables:**
```bash
# Lynkr backend URL (required)
export ANTHROPIC_BASE_URL=http://localhost:8081

# API key (required by CLI, but ignored by Lynkr)
export ANTHROPIC_API_KEY=dummy

# Workspace directory (optional, defaults to current directory)
export WORKSPACE_ROOT=/path/to/your/projects
```

**Make Permanent (Optional):**

Add to `~/.bashrc`, `~/.zshrc`, or `~/.profile`:

```bash
# Add these lines to your shell config
export ANTHROPIC_BASE_URL=http://localhost:8081
export ANTHROPIC_API_KEY=dummy
```

Then reload:
```bash
source ~/.bashrc  # or ~/.zshrc
```

---

## Feature Compatibility

### Fully Supported Features

All Claude Code CLI features work through Lynkr:

| Feature | Status | Notes |
|---------|--------|-------|
| **Chat conversations** | ✅ Works | Full streaming support |
| **File operations** | ✅ Works | Read, Write, Edit tools |
| **Bash commands** | ✅ Works | Execute shell commands |
| **Git operations** | ✅ Works | Status, diff, commit, push |
| **Tool calling** | ✅ Works | All standard Claude Code tools |
| **Streaming responses** | ✅ Works | Real-time token streaming |
| **Multi-turn conversations** | ✅ Works | Full context retention |
| **Code generation** | ✅ Works | Works with all providers |
| **Error handling** | ✅ Works | Automatic retries, fallbacks |
| **Token counting** | ✅ Works | Accurate usage tracking |

### Tool Execution Modes

Lynkr supports two tool execution modes:

**Server Mode (Default)**
```bash
# Tools execute on Lynkr server
export TOOL_EXECUTION_MODE=server
```
- Tools run on the machine running Lynkr
- Good for: Standalone proxy, shared team server
- File operations access server filesystem

**Client Mode (Passthrough)**
```bash
# Tools execute on Claude Code CLI side
export TOOL_EXECUTION_MODE=client
```
- Tools run on your local machine (where you run `claude`)
- Good for: Local development, accessing local files
- Full integration with local environment

---

## Usage Examples

### Basic Chat

```bash
# Simple question
claude "Explain async/await in JavaScript"

# Code explanation
claude "Explain this function" < app.js

# Multi-line prompt
claude "Write a function that:
- Takes an array of numbers
- Filters out even numbers
- Returns the sum of odd numbers"
```

---

### File Operations

```bash
# Read file
claude "What does this file do?" < src/server.js

# Create file
claude "Create a new Express server in server.js"

# Edit file
claude "Add error handling to src/api/router.js"

# Multiple files
claude "Refactor authentication across src/auth/*.js files"
```

---

### Git Workflow

```bash
# Status check
claude "What files have changed?"

# Review diff
claude "Review my changes and suggest improvements"

# Commit changes
claude "Commit these changes with a descriptive message"

# Create PR (if gh CLI installed)
claude "Create a pull request for these changes"
```

---

### Code Generation

```bash
# Generate function
claude "Write a binary search function in Python"

# Generate tests
claude "Write unit tests for utils/validation.js"

# Generate documentation
claude "Add JSDoc comments to this file" < src/helpers.js
```

---

## Provider-Specific Considerations

### AWS Bedrock

**Best for:** AWS ecosystem, 100+ models

```bash
export MODEL_PROVIDER=bedrock
export AWS_BEDROCK_MODEL_ID=anthropic.claude-3-5-sonnet-20241022-v2:0
```

**Considerations:**
- ✅ Tool calling works (Claude models only)
- ✅ Streaming supported
- ⚠️ Non-Claude models don't support tools

---

### Ollama (Local)

**Best for:** Privacy, offline work, zero costs

```bash
export MODEL_PROVIDER=ollama
export OLLAMA_MODEL=llama3.1:8b
```

**Considerations:**
- ✅ 100% FREE, runs locally
- ✅ Tool calling supported (llama3.1, llama3.2, qwen2.5, mistral)
- ⚠️ Smaller models may struggle with complex tool usage
- 💡 Use `qwen2.5:14b` for better tool calling

**Recommended models:**
- `llama3.1:8b` - Good balance
- `qwen2.5:14b` - Better reasoning (7b struggles)
- `mistral:7b-instruct` - Fast and capable

---

### OpenRouter

**Best for:** Simplicity, flexibility, 100+ models

```bash
export MODEL_PROVIDER=openrouter
export OPENROUTER_MODEL=anthropic/claude-3.5-sonnet
```

**Considerations:**
- ✅ 100+ models available
- ✅ Excellent tool calling support
- ✅ Automatic fallbacks
- 💰 Competitive pricing

---

### Databricks

**Best for:** Enterprise production, Claude 4.5

```bash
export MODEL_PROVIDER=databricks
```

**Considerations:**
- ✅ Claude Sonnet 4.5, Opus 4.5
- ✅ Enterprise SLA
- ✅ Excellent tool calling
- 💰 Enterprise pricing

---

## Tier-Based Routing (Cost Optimization)

Use local Ollama for simple tasks, cloud for complex ones:

```bash
# Configure tier-based routing (set all 4 to enable)
export TIER_SIMPLE=ollama:llama3.2
export TIER_MEDIUM=openrouter:openai/gpt-4o-mini
export TIER_COMPLEX=databricks:databricks-claude-sonnet-4-5
export TIER_REASONING=databricks:databricks-claude-sonnet-4-5
export FALLBACK_ENABLED=true
export FALLBACK_PROVIDER=databricks
export DATABRICKS_API_BASE=https://your-workspace.databricks.com
export DATABRICKS_API_KEY=your-key

# Start Lynkr
lynkr start
```

**How it works:**
- Each request is scored for complexity (0-100) and mapped to a tier
- **SIMPLE (0-25)**: Ollama (free, local, fast)
- **MEDIUM (26-50)**: OpenRouter (affordable cloud)
- **COMPLEX (51-75)**: Databricks (most capable)
- **REASONING (76-100)**: Databricks (best available)
- **Provider failures**: Automatic transparent fallback to cloud

**Cost savings:**
- **65-100%** for requests routed to local models
- **40-87%** faster for simple requests

---

## Verification & Testing

### Check Lynkr Health

```bash
curl http://localhost:8081/health/live

# Expected response:
{
  "status": "ok",
  "provider": "bedrock",
  "timestamp": "2026-01-12T00:00:00.000Z"
}
```

### Test API Endpoint

```bash
curl http://localhost:8081/v1/messages \
  -H "Content-Type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -d '{
    "model": "claude-3-5-sonnet-20241022",
    "max_tokens": 1024,
    "messages": [
      {"role": "user", "content": "Hello!"}
    ]
  }'

# Should return Claude-compatible response from your provider
```

### Test Claude CLI

```bash
# Simple test
claude "Hello, can you see this?"

# Tool calling test
claude "What files are in the current directory?"

# Should use Read/Bash tools and return results
```

---

## Troubleshooting

### Connection Refused

**Symptoms:** `Connection refused` or `ECONNREFUSED`

**Solutions:**

1. **Verify Lynkr is running:**
   ```bash
   lsof -i :8081
   # Should show node process
   ```

2. **Check URL configuration:**
   ```bash
   echo $ANTHROPIC_BASE_URL
   # Should be: http://localhost:8081
   ```

3. **Test health endpoint:**
   ```bash
   curl http://localhost:8081/health/live
   # Should return: {"status":"ok"}
   ```

---

### Provider Authentication Errors

**Symptoms:** `401 Unauthorized` or `403 Forbidden`

**Solutions:**

1. **Check provider credentials:**
   ```bash
   # For Bedrock
   echo $AWS_BEDROCK_API_KEY

   # For Databricks
   echo $DATABRICKS_API_KEY

   # For OpenRouter
   echo $OPENROUTER_API_KEY
   ```

2. **Verify credentials are valid:**
   - Bedrock: Check AWS Console → Bedrock → API Keys
   - Databricks: Check workspace → Settings → User Settings → Tokens
   - OpenRouter: Check openrouter.ai/keys

3. **Check Lynkr logs:**
   ```bash
   # In Lynkr terminal, look for authentication errors
   ```

---

### Tool Execution Errors

**Symptoms:** Tools fail to execute or return errors

**Solutions:**

1. **Check tool execution mode:**
   ```bash
   echo $TOOL_EXECUTION_MODE
   # Should be: server (default) or client
   ```

2. **Verify workspace root:**
   ```bash
   echo $WORKSPACE_ROOT
   # Should be valid directory path
   ```

3. **Check file permissions:**
   ```bash
   # For server mode, Lynkr needs read/write access
   ls -la $WORKSPACE_ROOT
   ```

---

### Model Not Found

**Symptoms:** `Model not found` or `Invalid model`

**Solutions:**

1. **Verify model is available:**
   ```bash
   # For Ollama
   ollama list
   # Should show your configured model

   # For Bedrock
   # Check AWS Console → Bedrock → Model access
   ```

2. **Check model name matches provider:**
   - Bedrock: Use full model ID (e.g., `anthropic.claude-3-5-sonnet-20241022-v2:0`)
   - Ollama: Use exact model name (e.g., `llama3.1:8b`)
   - OpenRouter: Use provider prefix (e.g., `anthropic/claude-3.5-sonnet`)

---

### Slow Responses

**Symptoms:** Responses take 5+ seconds

**Solutions:**

1. **Check provider latency:**
   - Local (Ollama): Should be 100-500ms
   - Cloud: Should be 500ms-2s

2. **Enable tier-based routing:**
   ```bash
   # Set all 4 TIER_* env vars to enable tier-based routing
   export TIER_SIMPLE=ollama:llama3.2
   export TIER_MEDIUM=openrouter:openai/gpt-4o-mini
   export TIER_COMPLEX=azure-openai:gpt-4o
   export TIER_REASONING=azure-openai:gpt-4o
   export FALLBACK_ENABLED=true
   ```

3. **Check Lynkr logs for actual response times**

---

### Enable Debug Logging

For detailed troubleshooting:

```bash
# In .env or export
export LOG_LEVEL=debug

# Restart Lynkr
lynkr start

# Check logs for detailed request/response info
```

---

## Advanced Configuration

### Custom Port

```bash
# Change Lynkr port
export PORT=8082

# Update Claude CLI configuration
export ANTHROPIC_BASE_URL=http://localhost:8082
```

---

### Custom Workspace Root

```bash
# Set specific workspace directory
export WORKSPACE_ROOT=/path/to/your/projects

# Claude CLI will use this as base directory for file operations
```

---

### Tool Execution Policies

```bash
# Allow git push (default: disabled)
export POLICY_GIT_ALLOW_PUSH=true

# Require tests before commit (default: disabled)
export POLICY_GIT_REQUIRE_TESTS=true

# Custom test command
export POLICY_GIT_TEST_COMMAND="npm test"
```

---

### Memory System

```bash
# Enable long-term memory (default: enabled)
export MEMORY_ENABLED=true

# Memories to inject per request
export MEMORY_RETRIEVAL_LIMIT=5

# Surprise threshold (0.0-1.0)
export MEMORY_SURPRISE_THRESHOLD=0.3
```

See [Memory System Guide](memory-system.md) for details.

---

## Cost Comparison

**Scenario:** 100,000 requests/month, average 50k input tokens, 2k output tokens

| Provider | Without Lynkr | With Lynkr (60% savings) | Monthly Savings |
|----------|---------------|-------------------------|-----------------|
| **Claude Sonnet 4.5** (via Databricks) | $16,000 | $6,400 | **$9,600** |
| **GPT-4o** (via OpenRouter) | $12,000 | $4,800 | **$7,200** |
| **Ollama (Local)** | API costs + compute | Local compute only | **$12,000+** |

**Token optimization includes:**
- Smart tool selection (50-70% reduction for simple queries)
- Prompt caching (30-45% reduction for repeated prompts)
- Memory deduplication (20-30% reduction for long conversations)
- Tool truncation (15-25% reduction for tool responses)

See [Token Optimization Guide](token-optimization.md) for details.

---

## Architecture

```
Claude Code CLI
    ↓ Anthropic API format
Lynkr Proxy (localhost:8081)
    ↓ Format conversion
Your Provider (Databricks/Bedrock/OpenRouter/Ollama/etc.)
    ↓ Returns response
Lynkr Proxy
    ↓ Format conversion back
Claude Code CLI (displays result)
```

---

## Next Steps

- **[Provider Configuration](providers.md)** - Configure all 9+ providers
- **[Installation Guide](installation.md)** - Detailed installation
- **[Features Guide](features.md)** - Learn about advanced features
- **[Token Optimization](token-optimization.md)** - Maximize cost savings
- **[Memory System](memory-system.md)** - Long-term memory
- **[Production Deployment](production.md)** - Deploy to production

---

## Getting Help

- **[Troubleshooting Guide](troubleshooting.md)** - Common issues and solutions
- **[FAQ](faq.md)** - Frequently asked questions
- **[GitHub Discussions](https://github.com/vishalveerareddy123/Lynkr/discussions)** - Community Q&A
- **[GitHub Issues](https://github.com/vishalveerareddy123/Lynkr/issues)** - Report bugs
