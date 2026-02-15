# Troubleshooting Guide

Common issues and solutions for Lynkr, Claude Code CLI, and Cursor IDE integration.

---

## Quick Diagnosis

### Is Lynkr Running?

```bash
# Check if Lynkr is running on port 8081
lsof -i :8081
# Should show node process

# Test health endpoint
curl http://localhost:8081/health/live
# Should return: {"status":"ok"}
```

### Are Environment Variables Set?

```bash
# Check core configuration
echo $MODEL_PROVIDER
echo $ANTHROPIC_BASE_URL  # For Claude CLI

# Check provider-specific
echo $DATABRICKS_API_KEY
echo $AWS_BEDROCK_API_KEY
echo $OPENROUTER_API_KEY
```

### Enable Debug Logging

```bash
# In .env or export
export LOG_LEVEL=debug

# Restart Lynkr
lynkr start

# Check logs for detailed info
```

---

## Lynkr Server Issues

### Server Won't Start

**Issue:** Lynkr fails to start

**Symptoms:**
```
Error: MODEL_PROVIDER requires credentials
Error: Port 8081 already in use
Error: Cannot find module 'xxx'
```

**Solutions:**

1. **Missing credentials:**
   ```bash
   # Check provider is configured
   echo $MODEL_PROVIDER
   echo $DATABRICKS_API_KEY  # or other provider key

   # If empty, set them:
   export MODEL_PROVIDER=databricks
   export DATABRICKS_API_KEY=your-key
   ```

2. **Port already in use:**
   ```bash
   # Find process using port 8081
   lsof -i :8081

   # Kill the process
   kill -9 <PID>

   # Or use different port
   export PORT=8082
   lynkr start
   ```

3. **Missing dependencies:**
   ```bash
   # Reinstall dependencies
   npm install

   # Or for global install
   npm install -g lynkr --force
   ```

---

### Connection Refused

**Issue:** `ECONNREFUSED` when connecting to Lynkr

**Symptoms:**
- Claude CLI: `Connection refused`
- Cursor: `Network error`

**Solutions:**

1. **Verify Lynkr is running:**
   ```bash
   lsof -i :8081
   # Should show node process
   ```

2. **Check port number:**
   ```bash
   # For Claude CLI
   echo $ANTHROPIC_BASE_URL
   # Should be: http://localhost:8081

   # For Cursor
   # Check Base URL in settings: http://localhost:8081/v1
   ```

3. **Test health endpoint:**
   ```bash
   curl http://localhost:8081/health/live
   # Should return: {"status":"ok"}
   ```

4. **Check firewall:**
   ```bash
   # macOS: System Preferences → Security & Privacy → Firewall
   # Allow incoming connections for node
   ```

---

### High Memory Usage

**Issue:** Lynkr consuming too much memory

**Symptoms:**
- Memory usage > 2GB
- System slowdown
- Crashes due to OOM

**Solutions:**

1. **Enable load shedding:**
   ```bash
   export LOAD_SHEDDING_MEMORY_THRESHOLD=0.85
   export LOAD_SHEDDING_HEAP_THRESHOLD=0.90
   ```

2. **Reduce cache size:**
   ```bash
   export PROMPT_CACHE_MAX_ENTRIES=32  # Default: 64
   export MEMORY_MAX_COUNT=5000  # Default: 10000
   ```

3. **Restart Lynkr periodically:**
   ```bash
   # Use process manager like PM2
   npm install -g pm2
   pm2 start lynkr --name lynkr --max-memory-restart 1G
   ```

---

## Provider Issues

### AWS Bedrock

**Issue:** Authentication failed

**Symptoms:**
- `401 Unauthorized`
- `Invalid API key`

**Solutions:**

1. **Check API key format:**
   ```bash
   # Should be bearer token, not Access Key ID
   echo $AWS_BEDROCK_API_KEY
   # Format: Should look like a long random string
   ```

2. **Regenerate API key:**
   - AWS Console → Bedrock → API Keys
   - Generate new key
   - Update environment variable

3. **Check model access:**
   - AWS Console → Bedrock → Model access
   - Request access to Claude models
   - Wait for approval (can take 5-10 minutes)

**Issue:** Model not found

**Symptoms:**
- `Model not available in region`
- `Access denied to model`

**Solutions:**

1. **Use correct model ID:**
   ```bash
   # Claude 3.5 Sonnet
   export AWS_BEDROCK_MODEL_ID=anthropic.claude-3-5-sonnet-20241022-v2:0

   # Claude 4.5 Sonnet (requires inference profile)
   export AWS_BEDROCK_MODEL_ID=us.anthropic.claude-sonnet-4-5-20250929-v1:0
   ```

2. **Check region:**
   ```bash
   # Not all models available in all regions
   export AWS_BEDROCK_REGION=us-east-1  # Most models available here
   ```

---

### Databricks

**Issue:** Authentication failed

**Symptoms:**
- `401 Unauthorized`
- `Invalid token`

**Solutions:**

1. **Check token format:**
   ```bash
   echo $DATABRICKS_API_KEY
   # Should start with: dapi...
   ```

2. **Regenerate PAT:**
   - Databricks workspace → Settings → User Settings
   - Generate new token
   - Copy and update environment variable

3. **Check workspace URL:**
   ```bash
   echo $DATABRICKS_API_BASE
   # Should be: https://your-workspace.cloud.databricks.com
   # No trailing slash
   ```

**Issue:** Endpoint not found

**Symptoms:**
- `404 Not Found`
- `Endpoint does not exist`

**Solutions:**

1. **Check endpoint name:**
   ```bash
   # Default endpoint path
   export DATABRICKS_ENDPOINT_PATH=/serving-endpoints/databricks-claude-sonnet-4-5/invocations

   # Or customize for your endpoint
   export DATABRICKS_ENDPOINT_PATH=/serving-endpoints/your-endpoint-name/invocations
   ```

2. **Verify endpoint exists:**
   - Databricks workspace → Serving → Endpoints
   - Check endpoint name matches

---

### OpenRouter

**Issue:** Rate limiting

**Symptoms:**
- `429 Too Many Requests`
- `Rate limit exceeded`

**Solutions:**

1. **Add credits:**
   - Visit openrouter.ai/account
   - Add more credits

2. **Switch models:**
   ```bash
   # Use cheaper model
   export OPENROUTER_MODEL=openai/gpt-4o-mini  # Faster, cheaper
   ```

3. **Enable fallback:**
   ```bash
   export FALLBACK_ENABLED=true
   export FALLBACK_PROVIDER=databricks
   ```

**Issue:** Model not found

**Symptoms:**
- `Invalid model`
- `Model not available`

**Solutions:**

1. **Check model name format:**
   ```bash
   # Must include provider prefix
   export OPENROUTER_MODEL=anthropic/claude-3.5-sonnet  # Correct
   # NOT: claude-3.5-sonnet (missing provider)
   ```

2. **Verify model exists:**
   - Visit openrouter.ai/models
   - Check model is available

---

### Ollama

**Issue:** Connection refused

**Symptoms:**
- `ECONNREFUSED`
- `Cannot connect to Ollama`

**Solutions:**

1. **Start Ollama service:**
   ```bash
   ollama serve
   # Leave running in separate terminal
   ```

2. **Check endpoint:**
   ```bash
   echo $OLLAMA_ENDPOINT
   # Should be: http://localhost:11434

   # Test endpoint
   curl http://localhost:11434/api/tags
   # Should return JSON with models
   ```

**Issue:** Model not found

**Symptoms:**
- `Error: model "llama3.1:8b" not found`

**Solutions:**

1. **Pull the model:**
   ```bash
   ollama pull llama3.1:8b
   ```

2. **List available models:**
   ```bash
   ollama list
   ```

3. **Verify model name:**
   ```bash
   echo $OLLAMA_MODEL
   # Should match model from `ollama list`
   ```

**Issue:** Poor tool calling

**Symptoms:**
- Tools not invoked correctly
- Malformed tool calls

**Solutions:**

1. **Use tool-capable model:**
   ```bash
   # Good tool calling
   ollama pull llama3.1:8b       # Recommended
   ollama pull qwen2.5:14b       # Better (7b struggles)
   ollama pull mistral:7b-instruct

   # Poor tool calling
   # Avoid: qwen2.5-coder, codellama
   ```

2. **Upgrade to larger model:**
   ```bash
   ollama pull qwen2.5:14b  # Better than 7b for tools
   ```

3. **Enable fallback:**
   ```bash
   export FALLBACK_ENABLED=true
   export FALLBACK_PROVIDER=databricks
   ```

---

### llama.cpp

**Issue:** Server not responding

**Symptoms:**
- `ECONNREFUSED`
- `Connection timeout`

**Solutions:**

1. **Start llama-server:**
   ```bash
   cd llama.cpp
   ./llama-server -m model.gguf --port 8080
   ```

2. **Check endpoint:**
   ```bash
   echo $LLAMACPP_ENDPOINT
   # Should be: http://localhost:8080

   curl http://localhost:8080/health
   # Should return: {"status":"ok"}
   ```

**Issue:** Out of memory

**Symptoms:**
- Server crashes
- `Failed to allocate memory`

**Solutions:**

1. **Use smaller quantization:**
   ```bash
   # Q4 = 4-bit quantization (smaller, faster)
   # Q8 = 8-bit quantization (larger, better quality)

   # Download Q4 model instead of Q8
   wget https://huggingface.co/.../model.Q4_K_M.gguf  # Smaller
   ```

2. **Reduce context size:**
   ```bash
   ./llama-server -m model.gguf --ctx-size 2048  # Default: 4096
   ```

3. **Enable GPU offloading:**
   ```bash
   # For NVIDIA
   ./llama-server -m model.gguf --n-gpu-layers 32

   # For Apple Silicon
   ./llama-server -m model.gguf --n-gpu-layers 32
   ```

---

## Claude Code CLI Issues

### CLI Can't Connect

**Issue:** Claude CLI can't reach Lynkr

**Symptoms:**
- `Connection refused`
- `Failed to connect to Anthropic API`

**Solutions:**

1. **Check environment variables:**
   ```bash
   echo $ANTHROPIC_BASE_URL
   # Should be: http://localhost:8081

   echo $ANTHROPIC_API_KEY
   # Can be any value: dummy, test, etc.
   ```

2. **Set permanently:**
   ```bash
   # Add to ~/.bashrc or ~/.zshrc
   export ANTHROPIC_BASE_URL=http://localhost:8081
   export ANTHROPIC_API_KEY=dummy

   # Reload
   source ~/.bashrc
   ```

3. **Test Lynkr:**
   ```bash
   curl http://localhost:8081/health/live
   # Should return: {"status":"ok"}
   ```

---

### Tools Not Working

**Issue:** File/Bash tools fail

**Symptoms:**
- `Tool execution failed`
- `Permission denied`
- Tools return errors

**Solutions:**

1. **Check tool execution mode:**
   ```bash
   echo $TOOL_EXECUTION_MODE
   # Should be: server (default) or client
   ```

2. **Check workspace root:**
   ```bash
   echo $WORKSPACE_ROOT
   # Should be valid directory

   # Verify permissions
   ls -la $WORKSPACE_ROOT
   ```

3. **For server mode:**
   ```bash
   # Lynkr needs read/write access to workspace
   chmod -R u+rw $WORKSPACE_ROOT
   ```

4. **Switch to client mode:**
   ```bash
   # Tools execute on CLI side
   export TOOL_EXECUTION_MODE=client
   lynkr start
   ```

---

### Slow Responses

**Issue:** Responses take 5+ seconds

**Solutions:**

1. **Check provider latency:**
   ```bash
   # In Lynkr logs, look for:
   # "Response time: 2500ms"
   ```

2. **Use local provider:**
   ```bash
   export MODEL_PROVIDER=ollama
   export OLLAMA_MODEL=llama3.1:8b
   ```

3. **Enable tier-based routing:**
   ```bash
   # Set all 4 TIER_* env vars to enable tier-based routing
   export TIER_SIMPLE=ollama:llama3.2
   export TIER_MEDIUM=openrouter:openai/gpt-4o-mini
   export TIER_COMPLEX=azure-openai:gpt-4o
   export TIER_REASONING=azure-openai:gpt-4o
   export FALLBACK_ENABLED=true
   ```

---

## Cursor IDE Issues

### Can't Connect to Lynkr

**Issue:** Cursor shows connection errors

**Solutions:**

1. **Check Base URL:**
   - Cursor Settings → Models → Base URL
   - ✅ Correct: `http://localhost:8081/v1`
   - ❌ Wrong: `http://localhost:8081` (missing `/v1`)

2. **Verify port:**
   ```bash
   echo $PORT
   # Should match Cursor Base URL port
   ```

3. **Test endpoint:**
   ```bash
   curl http://localhost:8081/v1/health
   # Should return: {"status":"ok"}
   ```

---

### @Codebase Doesn't Work

**Issue:** @Codebase search returns no results

**Solutions:**

1. **Check embeddings configured:**
   ```bash
   curl http://localhost:8081/v1/embeddings \
     -H "Content-Type: application/json" \
     -d '{"input":"test","model":"text-embedding-ada-002"}'

   # Should return embeddings, not 501
   ```

2. **Configure embeddings:**
   ```bash
   # Option A: Ollama (local, free)
   ollama pull nomic-embed-text
   export OLLAMA_EMBEDDINGS_MODEL=nomic-embed-text

   # Option B: OpenRouter (cloud)
   export OPENROUTER_API_KEY=sk-or-v1-your-key

   # Option C: OpenAI (cloud)
   export OPENAI_API_KEY=sk-your-key
   ```

3. **Restart Lynkr** after adding embeddings config

4. **Restart Cursor** to re-index codebase

See [Embeddings Guide](embeddings.md) for details.

---

### Poor Search Results

**Issue:** @Codebase returns irrelevant files

**Solutions:**

1. **Upgrade embedding model:**
   ```bash
   # Ollama: Use larger model
   ollama pull mxbai-embed-large
   export OLLAMA_EMBEDDINGS_MODEL=mxbai-embed-large

   # OpenRouter: Use code-specialized model
   export OPENROUTER_EMBEDDINGS_MODEL=voyage/voyage-code-2
   ```

2. **Switch to cloud embeddings:**
   - Local (Ollama/llama.cpp): Good
   - Cloud (OpenRouter/OpenAI): Excellent

3. **Re-index workspace:**
   - Close and reopen workspace in Cursor

---

### Model Not Found

**Issue:** Cursor can't find model

**Solutions:**

1. **Match model to provider:**
   - Bedrock: `claude-3.5-sonnet`
   - Databricks: `claude-sonnet-4.5`
   - OpenRouter: `anthropic/claude-3.5-sonnet`
   - Ollama: `llama3.1:8b` (actual model name)

2. **Try generic names:**
   - `claude-3.5-sonnet`
   - `gpt-4o`
   - Lynkr translates these across providers

---

## Embeddings Issues

### 501 Not Implemented

**Issue:** Embeddings endpoint returns 501

**Symptoms:**
```bash
curl http://localhost:8081/v1/embeddings
# Returns: {"error":"Embeddings not configured"}
```

**Solutions:**

Configure ONE embeddings provider:

```bash
# Option A: Ollama
ollama pull nomic-embed-text
export OLLAMA_EMBEDDINGS_MODEL=nomic-embed-text

# Option B: llama.cpp
export LLAMACPP_EMBEDDINGS_ENDPOINT=http://localhost:8080/embeddings

# Option C: OpenRouter
export OPENROUTER_API_KEY=sk-or-v1-your-key

# Option D: OpenAI
export OPENAI_API_KEY=sk-your-key
```

Restart Lynkr after configuration.

---

### Ollama Embeddings Connection Refused

**Issue:** Can't connect to Ollama embeddings

**Solutions:**

1. **Verify Ollama is running:**
   ```bash
   curl http://localhost:11434/api/tags
   # Should return models list
   ```

2. **Check model is pulled:**
   ```bash
   ollama list
   # Should show: nomic-embed-text
   ```

3. **Test embeddings:**
   ```bash
   curl http://localhost:11434/api/embeddings \
     -d '{"model":"nomic-embed-text","prompt":"test"}'
   # Should return embedding vector
   ```

---

## Performance Issues

### High CPU Usage

**Issue:** Lynkr consuming 100% CPU

**Solutions:**

1. **Reduce concurrent requests:**
   ```bash
   export LOAD_SHEDDING_ACTIVE_REQUESTS_THRESHOLD=100
   ```

2. **Use tier-based routing to send simple requests to local models:**
   ```bash
   # Set all 4 TIER_* env vars to enable tier-based routing
   export TIER_SIMPLE=ollama:llama3.2
   export TIER_MEDIUM=openrouter:openai/gpt-4o-mini
   export TIER_COMPLEX=azure-openai:gpt-4o
   export TIER_REASONING=azure-openai:gpt-4o
   ```

3. **Enable circuit breaker:**
   ```bash
   export CIRCUIT_BREAKER_FAILURE_THRESHOLD=5
   export CIRCUIT_BREAKER_TIMEOUT=60000
   ```

---

### Slow First Request / Cold Start Warning

**Issue:** First request is slow, or you see this warning in logs:
```
WARN: Potential cold start detected - duration: 14088
```

**Why this happens:**
- **Ollama/llama.cpp**: Model loading into memory (10-30+ seconds for large models)
- **Cloud providers**: Cold start initialization (2-5 seconds)
- Ollama unloads models after 5 minutes of inactivity by default

**Solutions for Ollama:**

1. **Keep models loaded with OLLAMA_KEEP_ALIVE** (Recommended):
   ```bash
   # macOS - set environment variable for Ollama
   launchctl setenv OLLAMA_KEEP_ALIVE "24h"
   # Then restart Ollama app

   # Linux (systemd)
   sudo systemctl edit ollama
   # Add: Environment="OLLAMA_KEEP_ALIVE=24h"
   sudo systemctl daemon-reload && sudo systemctl restart ollama

   # Docker
   docker run -e OLLAMA_KEEP_ALIVE=24h -d ollama/ollama
   ```

2. **Per-request keep alive:**
   ```bash
   curl http://localhost:11434/api/generate \
     -d '{"model":"llama3.1:8b","keep_alive":"24h"}'
   ```

3. **Warm up after startup:**
   ```bash
   # Send test request after starting Lynkr
   curl http://localhost:8081/v1/messages \
     -H "Content-Type: application/json" \
     -d '{"model":"claude-3-5-sonnet","max_tokens":10,"messages":[{"role":"user","content":"hi"}]}'
   ```

**Keep Alive Values:**
| Value | Behavior |
|-------|----------|
| `5m` | Default - unload after 5 minutes idle |
| `24h` | Keep loaded for 24 hours |
| `-1` | Never unload |
| `0` | Unload immediately |

**Note:** The cold start warning is informational - it helps identify latency issues but is not an error.

---

## Memory System Issues

### Too Many Memories

**Issue:** Memory database growing too large

**Solutions:**

1. **Reduce max count:**
   ```bash
   export MEMORY_MAX_COUNT=5000  # Default: 10000
   ```

2. **Reduce max age:**
   ```bash
   export MEMORY_MAX_AGE_DAYS=30  # Default: 90
   ```

3. **Increase surprise threshold:**
   ```bash
   export MEMORY_SURPRISE_THRESHOLD=0.5  # Default: 0.3 (higher = less stored)
   ```

4. **Manually prune:**
   ```bash
   # Delete old database
   rm data/memories.db
   # Will be recreated on next start
   ```

---

## Getting More Help

### Enable Debug Logging

```bash
export LOG_LEVEL=debug
lynkr start

# Check logs for detailed request/response info
```

### Check Logs

```bash
# Lynkr logs (in terminal where you started it)
# Look for errors, warnings, response times

# For systemd
journalctl -u lynkr -f

# For PM2
pm2 logs lynkr
```

### Community Support

- **[GitHub Discussions](https://github.com/vishalveerareddy123/Lynkr/discussions)** - Ask questions
- **[GitHub Issues](https://github.com/vishalveerareddy123/Lynkr/issues)** - Report bugs
- **[FAQ](faq.md)** - Frequently asked questions

---

## Still Having Issues?

If you've tried the above solutions and still have problems:

1. **Enable debug logging** and check logs
2. **Search [GitHub Issues](https://github.com/vishalveerareddy123/Lynkr/issues)** for similar problems
3. **Ask in [GitHub Discussions](https://github.com/vishalveerareddy123/Lynkr/discussions)** with:
   - Lynkr version
   - Provider being used
   - Full error message
   - Debug logs
   - Steps to reproduce
