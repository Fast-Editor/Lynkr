# Per-Client Model Routing Implementation Plan

## Current State

### How Model Routing Works Now

1. **Global Provider**: Set via `MODEL_PROVIDER` in `.env`
2. **No Per-Client Routing**: All clients use the same provider
3. **Smart Routing**: Only when `PREFER_OLLAMA=true` (routes based on tool count/complexity)
4. **No Client-Side Indication**: Clients don't know which model was used

### Current Configuration Options

| Config | Purpose | Example Values |
|--------|---------|-----------------|
| `MODEL_PROVIDER` | Primary provider | databricks, ollama, openrouter, azure-openai, bedrock |
| `PREFER_OLLAMA` | Enable smart routing | true/false |
| `FALLBACK_ENABLED` | Allow fallback to cloud | true/false (default: true) |
| `FALLBACK_PROVIDER` | Cloud fallback provider | databricks, azure-anthropic, bedrock |
| `OLLAMA_MAX_TOOLS_FOR_ROUTING` | Tool threshold for Ollama | 3 (default) |

---

## Implementation Plan

### Phase 1: Add Client-to-Provider Mapping Config

**File**: `.env`

```bash
# Per-client provider mapping (new)
CLIENT_PROVIDER_MAP=claude-code:ollama,codex:azure-openai,cline:openrouter,kilo:zai
CLIENT_PROVIDER_DEFAULT=azure-openai
```

**File**: `src/config/index.js`

```javascript
// Add helper function
function parseClientProviderMap(envValue) {
  if (!envValue) return {};
  const map = {};
  envValue.split(',').forEach(pair => {
    const [client, provider] = pair.split(':').map(s => s.trim().toLowerCase());
    if (client && provider) {
      map[client] = provider;
    }
  });
  return map;
}

// Add to config object
clientProviderMap: parseClientProviderMap(process.env.CLIENT_PROVIDER_MAP),
clientProviderDefault: process.env.CLIENT_PROVIDER_DEFAULT || process.env.MODEL_PROVIDER || 'azure-openai',
```

---

### Phase 2: Detect Client & Override Provider

**File**: `src/orchestrator/index.js` (around line 769)

```javascript
// Add at top of file
const VALID_PROVIDERS = new Set([
  'databricks', 'azure-anthropic', 'azure-openai', 'openrouter',
  'openai', 'ollama', 'llamacpp', 'lmstudio', 'bedrock', 'zai', 'vertex'
]);

// Add helper function
function detectClientType(headers) {
  const userAgent = (headers?.["user-agent"] || "").toLowerCase();
  const clientHeader = (headers?.["x-client"] || headers?.["x-client-name"] || "").toLowerCase();

  if (userAgent.includes("claude") || clientHeader.includes("claude")) return "claude-code";
  if (userAgent.includes("codex") || clientHeader.includes("codex")) return "codex";
  if (userAgent.includes("kilo") || clientHeader.includes("kilo")) return "kilo";
  if (userAgent.includes("cline") || clientHeader.includes("cline")) return "cline";
  if (userAgent.includes("continue") || clientHeader.includes("continue")) return "continue";
  if (userAgent.includes("cursor") || clientHeader.includes("cursor")) return "cursor";
  if (userAgent.includes("windsurf") || clientHeader.includes("windsurf")) return "windsurf";

  return "unknown";
}

function getProviderForClient(headers, defaultProvider) {
  const clientType = detectClientType(headers);
  const clientMap = config.clientProviderMap || {};

  // 1. Check for explicit header override
  const headerOverride = headers?.["x-model-provider"]?.toLowerCase();
  if (headerOverride && VALID_PROVIDERS.has(headerOverride)) {
    logger.info({ clientType, headerOverride }, "Using header-specified provider");
    return headerOverride;
  }

  // 2. Check client-specific mapping from config
  if (clientMap[clientType]) {
    logger.info({ clientType, provider: clientMap[clientType] }, "Using client-mapped provider");
    return clientMap[clientType];
  }

  // 3. Fall back to default
  logger.debug({ clientType, defaultProvider }, "Using default provider");
  return config.clientProviderDefault || defaultProvider;
}

// Replace current static provider selection:
// OLD: const providerType = config.modelProvider?.type ?? "databricks";
// NEW:
const providerType = getProviderForClient(headers, config.modelProvider?.type ?? "databricks");
```

---

### Phase 3: Add Response Header for Model Indication

**File**: `src/api/openai-router.js`

In the streaming response section, add headers:

```javascript
// After res.setHeader("Content-Type", "text/event-stream");
res.setHeader("X-Lynkr-Provider", providerType);
res.setHeader("X-Lynkr-Client-Detected", clientType);
```

**File**: `src/api/openai-router.js` (in /v1/responses endpoint)

In the response.completed event, add metadata:

```javascript
const completedEvent = {
  type: "response.completed",
  response: {
    id: responseId,
    object: "response",
    status: "completed",
    // ... existing fields

    // NEW: Add provider metadata
    _lynkr: {
      provider: providerType,
      client_detected: clientType,
      model_actual: actualModelUsed
    }
  },
  sequence_number: sequenceNumber++
};
```

---

### Phase 4: Hot Reload Support

**File**: `src/config/index.js`

```javascript
reloadConfig() {
  // ... existing reload logic

  // Add client provider map reload
  this.clientProviderMap = parseClientProviderMap(process.env.CLIENT_PROVIDER_MAP);
  this.clientProviderDefault = process.env.CLIENT_PROVIDER_DEFAULT || process.env.MODEL_PROVIDER;

  logger.info({
    clientProviderMap: this.clientProviderMap,
    clientProviderDefault: this.clientProviderDefault
  }, "Client provider mapping reloaded");
}
```

---

### Phase 5: Logging & Observability

**File**: `src/orchestrator/index.js`

Add logging for routing decisions:

```javascript
logger.info({
  sessionId: session?.id,
  clientType,
  requestedModel: payload.model,
  resolvedProvider: providerType,
  headerOverride: headers?.["x-model-provider"],
  configuredMapping: config.clientProviderMap[clientType]
}, "Model routing decision");
```

---

## Files to Modify

| File | Changes |
|------|---------|
| `.env` | Add `CLIENT_PROVIDER_MAP`, `CLIENT_PROVIDER_DEFAULT` |
| `src/config/index.js` | Parse new config, add helper function, add to exports |
| `src/orchestrator/index.js` | Add `getProviderForClient()`, `detectClientType()`, use headers |
| `src/api/openai-router.js` | Add `X-Lynkr-Provider` response header, add `_lynkr` metadata |

---

## Example Configuration

```bash
# .env

# Default provider (used if no client mapping matches)
MODEL_PROVIDER=azure-openai
CLIENT_PROVIDER_DEFAULT=azure-openai

# Per-client provider mapping
# Format: client1:provider1,client2:provider2,...
CLIENT_PROVIDER_MAP=claude-code:ollama,codex:azure-openai,cline:openrouter,kilo:zai,cursor:databricks

# Individual provider configs
OLLAMA_MODEL=qwen2.5-coder:7b
AZURE_OPENAI_DEPLOYMENT=gpt-4o
OPENROUTER_MODEL=anthropic/claude-3.5-sonnet
ZAI_MODEL=GLM-4.7
```

**Result**:
- Claude Code → Ollama (local, fast, free)
- Codex CLI → Azure OpenAI (GPT-4o/GPT-5)
- Cline → OpenRouter (Claude 3.5 Sonnet)
- Kilo Code → Z.AI (GLM-4.7, cheap)
- Cursor → Databricks (Claude via Databricks)
- Unknown → Azure OpenAI (default)

---

## Testing

1. Start server with new config
2. Make request from Claude Code → should route to Ollama
3. Check logs for "Model routing decision"
4. Check response header `X-Lynkr-Provider`
5. Make request from Codex → should route to Azure OpenAI
6. Test header override: `curl -H "X-Model-Provider: ollama" ...`

---

## Future Enhancements

1. **Per-Model Routing**: Route based on requested model name, not just client
2. **Cost-Based Routing**: Route to cheapest provider that supports the request
3. **Latency-Based Routing**: Route to fastest available provider
4. **Load Balancing**: Distribute across multiple providers
5. **UI Dashboard**: Visual config for routing rules
