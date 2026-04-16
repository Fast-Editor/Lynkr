# API Reference

Complete API reference for all Lynkr endpoints, including Claude Code CLI (Anthropic format) and Cursor IDE (OpenAI format) compatibility.

---

## Base URL

**Development:**
```
http://localhost:8081
```

**Production:**
```
https://your-domain.com
```

---

## Authentication

Lynkr acts as a proxy, so authentication depends on the configured provider:

**For Claude Code CLI:**
```bash
export ANTHROPIC_API_KEY=dummy  # Any value works
export ANTHROPIC_BASE_URL=http://localhost:8081
```

**For Cursor IDE:**
```
API Key: sk-lynkr  # Any value starting with "sk-" works
Base URL: http://localhost:8081/v1
```

**Note:** Real authentication happens between Lynkr and the provider (Databricks, Bedrock, etc.).

---

## Endpoints

### Chat Completion (Anthropic Format)

#### POST /v1/messages

Create a message using Anthropic's Messages API format.

**Request:**
```bash
curl -X POST http://localhost:8081/v1/messages \
  -H "Content-Type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -d '{
    "model": "claude-3-5-sonnet-20241022",
    "messages": [
      {
        "role": "user",
        "content": "What is the capital of France?"
      }
    ],
    "max_tokens": 1024,
    "temperature": 0.7
  }'
```

**Request Body:**
```typescript
{
  model: string;              // Model name (e.g., "claude-3-5-sonnet-20241022")
  messages: Message[];        // Conversation history
  max_tokens?: number;        // Max tokens to generate (default: 4096)
  temperature?: number;       // 0.0-1.0 (default: 0.7)
  top_p?: number;            // 0.0-1.0 (default: 1.0)
  top_k?: number;            // Top-k sampling (default: null)
  stop_sequences?: string[]; // Stop generation at these sequences
  stream?: boolean;          // Enable streaming (default: false)
  tools?: Tool[];            // Available tools for the model
  system?: string;           // System prompt
}

interface Message {
  role: "user" | "assistant";
  content: string | Content[];
}

interface Content {
  type: "text" | "image" | "tool_use" | "tool_result";
  text?: string;
  source?: ImageSource;
  id?: string;
  name?: string;
  input?: object;
  tool_use_id?: string;
  content?: string | object;
}

interface Tool {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties: object;
    required?: string[];
  };
}
```

**Response (Non-Streaming):**
```json
{
  "id": "msg_01ABC123",
  "type": "message",
  "role": "assistant",
  "content": [
    {
      "type": "text",
      "text": "The capital of France is Paris."
    }
  ],
  "model": "claude-3-5-sonnet-20241022",
  "stop_reason": "end_turn",
  "stop_sequence": null,
  "usage": {
    "input_tokens": 15,
    "output_tokens": 8
  }
}
```

**Response (Streaming):**
```
event: message_start
data: {"type":"message_start","message":{"id":"msg_01ABC123","type":"message","role":"assistant","content":[],"model":"claude-3-5-sonnet-20241022","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":15,"output_tokens":0}}}

event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"The"}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" capital"}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" of"}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" France"}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" is"}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" Paris"}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"."}}

event: content_block_stop
data: {"type":"content_block_stop","index":0}

event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":8}}

event: message_stop
data: {"type":"message_stop"}
```

---

### Chat Completion (OpenAI Format)

#### POST /v1/chat/completions

Create a chat completion using OpenAI's Chat Completions API format.

**Request:**
```bash
curl -X POST http://localhost:8081/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-lynkr" \
  -d '{
    "model": "claude-3.5-sonnet",
    "messages": [
      {
        "role": "user",
        "content": "What is the capital of France?"
      }
    ],
    "max_tokens": 1024,
    "temperature": 0.7,
    "stream": false
  }'
```

**Request Body:**
```typescript
{
  model: string;              // Model name
  messages: Message[];        // Conversation history
  max_tokens?: number;        // Max tokens to generate
  temperature?: number;       // 0.0-2.0 (default: 0.7)
  top_p?: number;            // 0.0-1.0
  n?: number;                // Number of completions (default: 1)
  stop?: string | string[];  // Stop sequences
  stream?: boolean;          // Enable streaming
  tools?: Tool[];            // Function calling tools
}

interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  name?: string;             // For tool messages
  tool_call_id?: string;     // For tool result messages
  tool_calls?: ToolCall[];   // For assistant tool call messages
}

interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;  // JSON string
  };
}

interface Tool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: object;  // JSON Schema
  };
}
```

**Response (Non-Streaming):**
```json
{
  "id": "chatcmpl-ABC123",
  "object": "chat.completion",
  "created": 1677858242,
  "model": "claude-3.5-sonnet",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "The capital of France is Paris."
      },
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": 15,
    "completion_tokens": 8,
    "total_tokens": 23
  }
}
```

**Response (Streaming):**
```
data: {"id":"chatcmpl-ABC123","object":"chat.completion.chunk","created":1677858242,"model":"claude-3.5-sonnet","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}

data: {"id":"chatcmpl-ABC123","object":"chat.completion.chunk","created":1677858242,"model":"claude-3.5-sonnet","choices":[{"index":0,"delta":{"content":"The"},"finish_reason":null}]}

data: {"id":"chatcmpl-ABC123","object":"chat.completion.chunk","created":1677858242,"model":"claude-3.5-sonnet","choices":[{"index":0,"delta":{"content":" capital"},"finish_reason":null}]}

data: {"id":"chatcmpl-ABC123","object":"chat.completion.chunk","created":1677858242,"model":"claude-3.5-sonnet","choices":[{"index":0,"delta":{"content":" of"},"finish_reason":null}]}

data: {"id":"chatcmpl-ABC123","object":"chat.completion.chunk","created":1677858242,"model":"claude-3.5-sonnet","choices":[{"index":0,"delta":{"content":" France"},"finish_reason":null}]}

data: {"id":"chatcmpl-ABC123","object":"chat.completion.chunk","created":1677858242,"model":"claude-3.5-sonnet","choices":[{"index":0,"delta":{"content":" is"},"finish_reason":null}]}

data: {"id":"chatcmpl-ABC123","object":"chat.completion.chunk","created":1677858242,"model":"claude-3.5-sonnet","choices":[{"index":0,"delta":{"content":" Paris"},"finish_reason":null}]}

data: {"id":"chatcmpl-ABC123","object":"chat.completion.chunk","created":1677858242,"model":"claude-3.5-sonnet","choices":[{"index":0,"delta":{"content":"."},"finish_reason":null}]}

data: {"id":"chatcmpl-ABC123","object":"chat.completion.chunk","created":1677858242,"model":"claude-3.5-sonnet","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}

data: [DONE]
```

---

### Embeddings

#### POST /v1/embeddings

Generate embeddings for text input.

**Request:**
```bash
curl -X POST http://localhost:8081/v1/embeddings \
  -H "Content-Type: application/json" \
  -d '{
    "input": "function to sort array",
    "model": "text-embedding-ada-002"
  }'
```

**Request Body:**
```typescript
{
  input: string | string[];  // Text to embed
  model: string;             // Embedding model name
}
```

**Supported Models:**
- `text-embedding-ada-002` (OpenAI)
- `text-embedding-3-small` (OpenAI)
- `text-embedding-3-large` (OpenAI)
- `nomic-embed-text` (Ollama)
- `all-minilm` (llama.cpp)

**Response:**
```json
{
  "object": "list",
  "data": [
    {
      "object": "embedding",
      "embedding": [0.123, -0.456, 0.789, ...],
      "index": 0
    }
  ],
  "model": "text-embedding-ada-002",
  "usage": {
    "prompt_tokens": 8,
    "total_tokens": 8
  }
}
```

**Configuration:**
```bash
# Ollama embeddings (local)
EMBEDDINGS_PROVIDER=ollama
OLLAMA_API_BASE=http://localhost:11434
OLLAMA_EMBEDDINGS_MODEL=nomic-embed-text

# OpenAI embeddings (cloud)
EMBEDDINGS_PROVIDER=openai
OPENAI_API_KEY=sk-...
OPENAI_EMBEDDINGS_MODEL=text-embedding-3-small

# OpenRouter embeddings (cloud)
EMBEDDINGS_PROVIDER=openrouter
OPENROUTER_API_KEY=sk-or-v1-...
OPENROUTER_EMBEDDINGS_MODEL=openai/text-embedding-3-small
```

---

### Models

#### GET /v1/models

List available models.

**Request:**
```bash
curl http://localhost:8081/v1/models
```

**Response:**
```json
{
  "object": "list",
  "data": [
    {
      "id": "claude-3-5-sonnet-20241022",
      "object": "model",
      "created": 1677649963,
      "owned_by": "anthropic"
    },
    {
      "id": "claude-3-opus-20240229",
      "object": "model",
      "created": 1677649963,
      "owned_by": "anthropic"
    },
    {
      "id": "qwen2.5-coder:7b",
      "object": "model",
      "created": 1677649963,
      "owned_by": "ollama"
    }
  ]
}
```

---

### Health Checks

#### GET /health/live

Liveness probe - checks if server is running.

**Request:**
```bash
curl http://localhost:8081/health/live
```

**Response:**
```json
{
  "status": "ok",
  "provider": "databricks",
  "timestamp": "2026-01-12T00:00:00.000Z"
}
```

**HTTP Status:**
- `200 OK` - Server is running
- `503 Service Unavailable` - Server is not ready

#### GET /health/ready

Readiness probe - checks if server can handle requests.

**Request:**
```bash
curl http://localhost:8081/health/ready
```

**Response:**
```json
{
  "status": "ready",
  "checks": {
    "database": "ok",
    "provider": "ok"
  }
}
```

**HTTP Status:**
- `200 OK` - Server is ready
- `503 Service Unavailable` - Server is not ready

#### GET /health/ready?deep=true

Deep health check with detailed information.

**Request:**
```bash
curl "http://localhost:8081/health/ready?deep=true"
```

**Response:**
```json
{
  "status": "ready",
  "checks": {
    "database": "ok",
    "provider": "ok",
    "memory": {
      "used": "50%",
      "status": "ok"
    },
    "circuit_breaker": {
      "state": "closed",
      "status": "ok"
    }
  }
}
```

---

### Metrics

#### GET /metrics

Prometheus-compatible metrics endpoint.

**Request:**
```bash
curl http://localhost:8081/metrics
```

**Response:**
```
# HELP lynkr_requests_total Total number of requests
# TYPE lynkr_requests_total counter
lynkr_requests_total{provider="databricks",status="200"} 1234

# HELP lynkr_request_duration_seconds Request duration in seconds
# TYPE lynkr_request_duration_seconds histogram
lynkr_request_duration_seconds_bucket{provider="databricks",le="0.5"} 980
lynkr_request_duration_seconds_bucket{provider="databricks",le="1"} 1200
lynkr_request_duration_seconds_bucket{provider="databricks",le="2"} 1230
lynkr_request_duration_seconds_bucket{provider="databricks",le="+Inf"} 1234
lynkr_request_duration_seconds_sum{provider="databricks"} 1234.5
lynkr_request_duration_seconds_count{provider="databricks"} 1234

# HELP lynkr_errors_total Total number of errors
# TYPE lynkr_errors_total counter
lynkr_errors_total{provider="databricks",type="timeout"} 12

# HELP lynkr_tokens_input_total Total input tokens
# TYPE lynkr_tokens_input_total counter
lynkr_tokens_input_total{provider="databricks"} 5000000

# HELP lynkr_tokens_output_total Total output tokens
# TYPE lynkr_tokens_output_total counter
lynkr_tokens_output_total{provider="databricks"} 500000

# HELP lynkr_tokens_cached_total Total cached tokens
# TYPE lynkr_tokens_cached_total counter
lynkr_tokens_cached_total 2000000

# HELP lynkr_cache_hits_total Total cache hits
# TYPE lynkr_cache_hits_total counter
lynkr_cache_hits_total 850

# HELP lynkr_cache_misses_total Total cache misses
# TYPE lynkr_cache_misses_total counter
lynkr_cache_misses_total 150

# HELP lynkr_circuit_breaker_state Circuit breaker state (1=open, 0=closed)
# TYPE lynkr_circuit_breaker_state gauge
lynkr_circuit_breaker_state{provider="databricks",state="closed"} 1

# HELP lynkr_active_requests Current active requests
# TYPE lynkr_active_requests gauge
lynkr_active_requests 42

# HELP process_resident_memory_bytes Resident memory size in bytes
# TYPE process_resident_memory_bytes gauge
process_resident_memory_bytes 104857600

# HELP nodejs_heap_size_used_bytes Heap size used in bytes
# TYPE nodejs_heap_size_used_bytes gauge
nodejs_heap_size_used_bytes 52428800
```

---

## Error Handling

### Error Response Format

**Anthropic Format:**
```json
{
  "type": "error",
  "error": {
    "type": "invalid_request_error",
    "message": "Missing required field: messages"
  }
}
```

**OpenAI Format:**
```json
{
  "error": {
    "message": "Missing required field: messages",
    "type": "invalid_request_error",
    "code": "invalid_request"
  }
}
```

### Error Types

| HTTP Status | Error Type | Description |
|-------------|------------|-------------|
| 400 | `invalid_request_error` | Invalid request parameters |
| 401 | `authentication_error` | Invalid or missing API key |
| 403 | `permission_error` | Insufficient permissions |
| 404 | `not_found_error` | Resource not found |
| 429 | `rate_limit_error` | Rate limit exceeded |
| 500 | `api_error` | Internal server error |
| 503 | `overloaded_error` | Server overloaded (load shedding) |

### Common Errors

**Missing API Key:**
```json
{
  "type": "error",
  "error": {
    "type": "authentication_error",
    "message": "Missing provider API key. Set DATABRICKS_API_KEY environment variable."
  }
}
```

**Rate Limit:**
```json
{
  "type": "error",
  "error": {
    "type": "rate_limit_error",
    "message": "Rate limit exceeded. Retry after 60 seconds."
  }
}
```

**Load Shedding:**
```json
{
  "type": "error",
  "error": {
    "type": "overloaded_error",
    "message": "Server overloaded. Please retry."
  }
}
```

HTTP Response:
```
HTTP/1.1 503 Service Unavailable
Retry-After: 5
Content-Type: application/json

{"type":"error","error":{"type":"overloaded_error","message":"Server overloaded. Please retry."}}
```

---

## Rate Limiting

Lynkr does not implement rate limiting itself. Rate limits are enforced by the underlying provider:

| Provider | Rate Limit | Burst |
|----------|------------|-------|
| **Databricks** | Provider-specific | Provider-specific |
| **AWS Bedrock** | Provider-specific | Provider-specific |
| **OpenRouter** | Provider-specific | Provider-specific |
| **Ollama** | No limit | No limit |
| **llama.cpp** | No limit | No limit |

**Handle rate limits:**
```javascript
async function makeRequest(payload) {
  try {
    const response = await fetch("http://localhost:8081/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    if (response.status === 429) {
      const retryAfter = response.headers.get("Retry-After");
      console.log(`Rate limited. Retry after ${retryAfter}s`);
      await sleep(parseInt(retryAfter) * 1000);
      return makeRequest(payload);  // Retry
    }

    return await response.json();
  } catch (error) {
    console.error("Request failed:", error);
    throw error;
  }
}
```

---

## SDK Examples

### Node.js (Anthropic SDK)

```javascript
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({
  apiKey: "dummy",  // Any value works
  baseURL: "http://localhost:8081"
});

// Non-streaming
const message = await client.messages.create({
  model: "claude-3-5-sonnet-20241022",
  max_tokens: 1024,
  messages: [
    { role: "user", content: "What is the capital of France?" }
  ]
});

console.log(message.content[0].text);

// Streaming
const stream = await client.messages.create({
  model: "claude-3-5-sonnet-20241022",
  max_tokens: 1024,
  messages: [
    { role: "user", content: "Tell me a story" }
  ],
  stream: true
});

for await (const event of stream) {
  if (event.type === "content_block_delta") {
    process.stdout.write(event.delta.text);
  }
}
```

### Python (OpenAI SDK)

```python
from openai import OpenAI

client = OpenAI(
    api_key="sk-lynkr",
    base_url="http://localhost:8081/v1"
)

# Non-streaming
response = client.chat.completions.create(
    model="claude-3.5-sonnet",
    messages=[
        {"role": "user", "content": "What is the capital of France?"}
    ],
    max_tokens=1024
)

print(response.choices[0].message.content)

# Streaming
stream = client.chat.completions.create(
    model="claude-3.5-sonnet",
    messages=[
        {"role": "user", "content": "Tell me a story"}
    ],
    max_tokens=1024,
    stream=True
)

for chunk in stream:
    if chunk.choices[0].delta.content:
        print(chunk.choices[0].delta.content, end="")
```

### cURL

```bash
# Non-streaming (Anthropic format)
curl -X POST http://localhost:8081/v1/messages \
  -H "Content-Type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -d '{
    "model": "claude-3-5-sonnet-20241022",
    "messages": [{"role": "user", "content": "Hello"}],
    "max_tokens": 1024
  }'

# Streaming (Anthropic format)
curl -X POST http://localhost:8081/v1/messages \
  -H "Content-Type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -d '{
    "model": "claude-3-5-sonnet-20241022",
    "messages": [{"role": "user", "content": "Hello"}],
    "max_tokens": 1024,
    "stream": true
  }' \
  --no-buffer

# Non-streaming (OpenAI format)
curl -X POST http://localhost:8081/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-lynkr" \
  -d '{
    "model": "claude-3.5-sonnet",
    "messages": [{"role": "user", "content": "Hello"}],
    "max_tokens": 1024
  }'

# Streaming (OpenAI format)
curl -X POST http://localhost:8081/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-lynkr" \
  -d '{
    "model": "claude-3.5-sonnet",
    "messages": [{"role": "user", "content": "Hello"}],
    "max_tokens": 1024,
    "stream": true
  }' \
  --no-buffer
```

---

## Next Steps

- **[Claude Code CLI Guide](claude-code-cli.md)** - Configure Claude Code CLI
- **[Cursor Integration](cursor-integration.md)** - Configure Cursor IDE
- **[Providers Guide](providers.md)** - Configure providers
- **[Troubleshooting](troubleshooting.md)** - Common issues

---

## Getting Help

- **[GitHub Discussions](https://github.com/Fast-Editor/Lynkr/discussions)** - Ask questions
- **[GitHub Issues](https://github.com/Fast-Editor/Lynkr/issues)** - Report issues
