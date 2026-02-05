# Headroom Context Compression

Headroom is an intelligent context compression system that reduces LLM token usage by 47-92% while preserving semantic meaning. It runs as a Python sidecar container that Lynkr manages automatically via Docker.

---

## Overview

### What is Headroom?

Headroom is a context optimization SDK that compresses LLM prompts and tool outputs using:

1. **Smart Crusher** - Statistical JSON compression based on field analysis
2. **Cache Aligner** - Stabilizes dynamic content (UUIDs, timestamps) for provider cache hits
3. **CCR (Compress-Cache-Retrieve)** - Reversible compression with on-demand retrieval
4. **Rolling Window** - Token budget enforcement with turn-based windowing
5. **LLMLingua** (optional) - ML-based 20x compression using BERT

### Benefits

| Metric | Without Headroom | With Headroom |
|--------|-----------------|---------------|
| Token usage | 100% | 8-53% (47-92% reduction) |
| Cache hit rate | ~20% | ~60-80% |
| Cost per request | $0.01-0.05 | $0.002-0.02 |
| Context overflow | Common | Rare |

---

## Quick Start

### 1. Enable Headroom

Add to your `.env`:

```bash
# Enable Headroom compression
HEADROOM_ENABLED=true
```

### 2. Start Lynkr

```bash
npm start
```

Lynkr will automatically:
1. Pull the `lynkr/headroom-sidecar:latest` Docker image
2. Start the container with configured settings
3. Wait for health checks to pass
4. Begin compressing requests

### 3. Verify It's Working

Check the health endpoint:

```bash
curl http://localhost:8081/health/headroom
```

Expected response:
```json
{
  "enabled": true,
  "healthy": true,
  "service": {
    "available": true,
    "ccrEnabled": true,
    "llmlinguaEnabled": false
  },
  "docker": {
    "running": true,
    "status": "running",
    "health": "healthy"
  }
}
```

---

## How It Works

### Transform Pipeline

When a request arrives, Headroom processes it through a three-stage pipeline:

```
Request → Cache Aligner → Smart Crusher → Context Manager → Compressed Request
                ↓               ↓                ↓
         Stabilize IDs    Compress JSON    Enforce budget
```

### 1. Cache Aligner

**Problem**: Dynamic content like UUIDs and timestamps change every request, preventing provider cache hits.

**Solution**: Replace dynamic values with stable placeholders:

```json
// Before
{"id": "f47ac10b-58cc-4372-a567-0e02b2c3d479", "created": "2024-01-15T10:30:00Z"}

// After
{"id": "[ID:1]", "created": "[TS:1]"}
```

**Result**: 60-80% cache hit rate instead of ~20%.

### 2. Smart Crusher

**Problem**: Tool outputs often contain repetitive JSON with many similar items.

**Solution**: Statistical analysis to identify and compress redundant fields:

```json
// Before (100 search results, ~50KB)
[
  {"title": "Result 1", "url": "...", "snippet": "...", "score": 0.95, ...},
  {"title": "Result 2", "url": "...", "snippet": "...", "score": 0.93, ...},
  // ... 98 more items
]

// After (~5KB)
{
  "_meta": {"compressed": true, "original_count": 100, "kept": 12},
  "items": [
    // Top 12 most relevant items with essential fields only
  ]
}
```

**Compression strategies**:
- **High-variance fields**: Keep (they're informative)
- **Low-variance fields**: Remove (they're redundant)
- **Unique fields**: Keep first occurrence only
- **Repetitive arrays**: Sample representative items

### 3. CCR (Compress-Cache-Retrieve)

**Problem**: Sometimes you need to retrieve compressed content later.

**Solution**: Hash-based reversible compression:

```json
// Compressed message
{
  "content": "[CCR:abc123] 100 files found. Use ccr_retrieve to explore.",
  "ccr_available": true
}

// Tool definition injected
{
  "name": "ccr_retrieve",
  "description": "Retrieve compressed content by hash",
  "input_schema": {
    "hash": "string",
    "query": "string (optional search within results)"
  }
}
```

When the LLM calls `ccr_retrieve`, Headroom returns the full original content.

---

## Configuration

### Basic Settings

```bash
# Enable/disable Headroom
HEADROOM_ENABLED=true

# Sidecar endpoint
HEADROOM_ENDPOINT=http://localhost:8787

# Request timeout (ms)
HEADROOM_TIMEOUT_MS=5000

# Skip compression for small requests (tokens)
HEADROOM_MIN_TOKENS=500

# Mode: "audit" (observe) or "optimize" (apply)
HEADROOM_MODE=optimize
```

### Docker Settings

```bash
# Enable automatic container management
HEADROOM_DOCKER_ENABLED=true

# Docker image
HEADROOM_DOCKER_IMAGE=lynkr/headroom-sidecar:latest

# Container name
HEADROOM_DOCKER_CONTAINER_NAME=lynkr-headroom

# Port mapping
HEADROOM_DOCKER_PORT=8787

# Resource limits
HEADROOM_DOCKER_MEMORY_LIMIT=512m
HEADROOM_DOCKER_CPU_LIMIT=1.0

# Restart policy
HEADROOM_DOCKER_RESTART_POLICY=unless-stopped
```

### Transform Settings

```bash
# Smart Crusher (statistical JSON compression)
HEADROOM_SMART_CRUSHER=true
HEADROOM_SMART_CRUSHER_MIN_TOKENS=200
HEADROOM_SMART_CRUSHER_MAX_ITEMS=15

# Tool Crusher (fixed-rules compression)
HEADROOM_TOOL_CRUSHER=true

# Cache Aligner (stabilize dynamic content)
HEADROOM_CACHE_ALIGNER=true

# Rolling Window (context overflow management)
HEADROOM_ROLLING_WINDOW=true
HEADROOM_KEEP_TURNS=3
```

### CCR Settings

```bash
# Enable CCR for reversible compression
HEADROOM_CCR=true

# Cache TTL in seconds
HEADROOM_CCR_TTL=300
```

### LLMLingua Settings (Optional)

LLMLingua provides ML-based compression using BERT token classification. Requires GPU for reasonable performance.

```bash
# Enable LLMLingua (default: false)
HEADROOM_LLMLINGUA=true

# Device: cuda, cpu, auto
HEADROOM_LLMLINGUA_DEVICE=cuda
```

**Note**: LLMLingua adds 100-500ms latency per request. Only enable if you have a GPU and need maximum compression.

---

## API Endpoints

### Health Check

```bash
GET /health/headroom
```

Returns Headroom health status including container and service state.

### Compression Metrics

```bash
GET /metrics/compression
```

Returns compression statistics:

```json
{
  "enabled": true,
  "endpoint": "http://localhost:8787",
  "client": {
    "totalCalls": 150,
    "successfulCompressions": 120,
    "skippedCompressions": 25,
    "failures": 5,
    "totalTokensSaved": 450000,
    "averageLatencyMs": 45,
    "compressionRate": 80,
    "failureRate": 3
  },
  "server": {
    "requests_total": 150,
    "compressions_applied": 120,
    "average_compression_ratio": 0.35,
    "ccr_retrievals": 45
  }
}
```

### Detailed Status

```bash
GET /headroom/status
```

Returns full status including configuration, metrics, and recent logs.

### Container Restart

```bash
POST /headroom/restart
```

Restarts the Headroom container (useful for applying config changes).

### Container Logs

```bash
GET /headroom/logs?tail=100
```

Returns recent container logs for debugging.

---

## Monitoring

### Health Check Integration

Headroom status is included in the `/health/ready` endpoint:

```json
{
  "status": "ready",
  "checks": {
    "database": { "healthy": true },
    "memory": { "healthy": true },
    "headroom": {
      "healthy": true,
      "enabled": true,
      "service": "available",
      "docker": "running"
    }
  }
}
```

**Note**: Headroom is non-critical. If it fails, Lynkr continues without compression.

### Logging

Headroom logs compression events:

```
INFO: Headroom compression applied
  tokensBefore: 15000
  tokensAfter: 5200
  savingsPercent: 65.3
  latencyMs: 42
  transforms: ["cache_aligner", "smart_crusher"]
```

---

## Troubleshooting

### Container Won't Start

**Check Docker is running:**
```bash
docker ps
```

**Check for port conflicts:**
```bash
lsof -i :8787
```

**View container logs:**
```bash
curl http://localhost:8081/headroom/logs
# or
docker logs lynkr-headroom
```

### High Latency

1. **Reduce transforms**: Disable LLMLingua if not needed
2. **Increase resources**: Raise `HEADROOM_DOCKER_MEMORY_LIMIT`
3. **Skip small requests**: Increase `HEADROOM_MIN_TOKENS`

### Compression Not Applied

Check:
1. `HEADROOM_ENABLED=true` in `.env`
2. Request has more than `HEADROOM_MIN_TOKENS` tokens
3. Health endpoint shows `healthy: true`

### CCR Retrieval Fails

1. Check `HEADROOM_CCR=true`
2. Verify TTL hasn't expired (`HEADROOM_CCR_TTL`)
3. Ensure same session is used (CCR is session-scoped)

---

## Architecture

### System Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                         Lynkr (Node.js)                         │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  Request Handler                                          │  │
│  │    ↓                                                      │  │
│  │  src/headroom/client.js ──HTTP──→ Headroom Sidecar       │  │
│  │    ↓                              (Python Container)      │  │
│  │  Compressed Request                    │                  │  │
│  │    ↓                                   ↓                  │  │
│  │  LLM Provider                    ┌─────────────┐         │  │
│  │                                  │ Transforms  │         │  │
│  └──────────────────────────────────│ - Aligner   │─────────┘  │
│                                     │ - Crusher   │            │
│                                     │ - CCR Store │            │
│                                     │ - LLMLingua │            │
│                                     └─────────────┘            │
└─────────────────────────────────────────────────────────────────┘
```

### Request Flow

1. **Request arrives** at Lynkr
2. **Token estimation** - Skip if below `HEADROOM_MIN_TOKENS`
3. **Send to sidecar** - HTTP POST to `/compress`
4. **Transform pipeline** executes:
   - Cache Aligner stabilizes dynamic content
   - Smart Crusher compresses JSON structures
   - Context Manager enforces token budget
5. **Return compressed** messages and tools
6. **Forward to LLM** provider
7. **On CCR tool call** - Retrieve original content

### File Structure

```
src/headroom/
├── index.js        # HeadroomManager singleton, exports
├── launcher.js     # Docker container lifecycle (dockerode)
├── client.js       # HTTP client for sidecar API
└── health.js       # Health check functionality
```

---

## Best Practices

### 1. Start with Defaults

The default configuration is optimized for most use cases:
- Smart Crusher: Enabled
- Cache Aligner: Enabled
- CCR: Enabled
- LLMLingua: Disabled (enable only with GPU)

### 2. Monitor Compression Rates

Check `/metrics/compression` regularly:
- **Good**: 60-80% compression rate
- **Warning**: Below 40% (check transform settings)
- **Issue**: High failure rate (check container health)

### 3. Tune for Your Workload

| Workload | Recommended Settings |
|----------|---------------------|
| Code assistance | `SMART_CRUSHER_MAX_ITEMS=20` |
| Search-heavy | `SMART_CRUSHER_MAX_ITEMS=10`, CCR enabled |
| Long conversations | `ROLLING_WINDOW=true`, `KEEP_TURNS=5` |
| Cost-sensitive | Enable LLMLingua with GPU |

### 4. Use Audit Mode First

Test compression without applying it:

```bash
HEADROOM_MODE=audit
```

This logs what would be compressed without modifying requests.

---

## FAQ

### Does Headroom affect response quality?

Minimal impact. Smart Crusher preserves high-variance (informative) fields and CCR allows full retrieval when needed. LLMLingua may have ~1.5% quality reduction.

### Can I use Headroom without Docker?

Yes. Disable Docker management and run the sidecar manually:

```bash
HEADROOM_DOCKER_ENABLED=false
HEADROOM_ENDPOINT=http://your-headroom-server:8787
```

### Is Headroom required?

No. If Headroom fails or is disabled, Lynkr works normally without compression.

### What providers benefit most?

All providers benefit from compression. Anthropic and OpenAI see additional benefits from Cache Aligner improving cache hit rates.

---

## References

- [Headroom GitHub Repository](https://github.com/chopratejas/headroom)
- [LLMLingua Paper](https://arxiv.org/abs/2310.05736)
- [Anthropic Prompt Caching](https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching)
