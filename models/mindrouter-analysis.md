# MindRouter Analysis — Lessons for Lynkr

**Repository**: https://github.com/ui-insight/MindRouter
**Author**: Luke Sheneman, Research Computing and Data Services (RCDS), University of Idaho
**License**: Apache 2.0 | **Funded by**: NSF Award #2427549
**Stack**: Python 3.11+, FastAPI, SQLAlchemy (async), MariaDB, Redis, Docker

---

## What It Is

MindRouter is a **production-grade LLM inference load balancer** from University of Idaho (NSF-funded). It sits in front of a cluster of Ollama/vLLM GPU backends and provides a unified API surface (OpenAI, Ollama, Anthropic compatible). Think of it as an advanced version of what Lynkr does, but focused on **multi-GPU cluster scheduling** rather than cloud API routing.

### Architecture

```
Clients (OpenAI SDK, Ollama CLI, Anthropic SDK, curl)
    |
    v
[API Gateway] -- FastAPI endpoints for /v1/*, /api/*, /anthropic/v1/*
    |
    v
[Translation Layer] -- Inbound translators convert to Canonical Schema
    |
    v
[Fair-Share Scheduler] -- WDRR priority computation, job queuing
    |
    v
[Backend Scorer] -- Hard constraint filtering + soft score ranking
    |
    v
[Backend Router] -- Selects best backend, manages queue depths
    |
    v
[Inference Service] -- Proxies HTTP to backends with retry/failover
    |
    v
[Outbound Translators] -- Canonical -> Ollama or vLLM format
    |
    v
[Ollama / vLLM Backends] -- GPU inference servers
    |
[GPU Sidecar Agents] -- One per physical node, exposes /gpu-info via pynvml
```

**Key concept: Node vs Backend separation.** A Node is a physical GPU server running a sidecar. A Backend is an inference endpoint (Ollama or vLLM) on a node. One node can host multiple backends, each assigned specific GPUs via `gpu_indices`.

---

## Key Algorithms

### 1. Weighted Deficit Round Robin (WDRR) Scheduler

MindRouter's fair-share scheduling is significantly more sophisticated than Lynkr's complexity-based routing:

| Concept | MindRouter | Lynkr Today |
|---------|-----------|-------------|
| Priority formula | `(deficit + burst_credits) / weight * deprioritization + wait_bonus` | Complexity score -> tier mapping |
| Per-user fairness | Tracks tokens per user in rolling 5-min window | None |
| Burst credits | Accumulate when cluster idle, decay under contention | None |
| Starvation prevention | `wait_bonus = queue_seconds * 0.1` | None |

**Per-user state** (`UserState`):
- `weight` -- Role-based (default: student=1, staff=2, faculty=3, admin=10)
- `deficit` -- Tracks service debt (positive = owed more service, negative = recently served)
- `burst_credits` -- Accumulated when cluster is idle
- `recent_tokens` -- Usage in the rolling fairness window
- `active_requests` -- Currently in-flight count

**Priority formula:**
```
priority = (deficit + burst_credits) / weight * deprioritization_factor + wait_bonus
```

- `wait_bonus = queue_time_seconds * 0.1` -- Prevents starvation
- `deprioritization_factor` -- 0.1 to 1.0, penalizes users exceeding 50% of recent cluster usage

**Burst credits:**
- When cluster is idle: `burst_credits += idle_seconds * 100 * weight`
- Capped at `max_burst_credits = 1000`
- When contention detected: `burst_credits *= 0.5` (decay, not zero)

**Takeaway**: Lynkr could add per-user/per-session deficit tracking. Users making many REASONING-tier calls accumulate negative deficit and get deprioritized — preventing one heavy session from monopolizing expensive models.

---

### 2. Multi-Factor Backend Scoring

Their scorer uses **hard constraints** (filter) + **soft scoring** (rank):

**Hard constraints** (all must pass):
1. Backend is HEALTHY status
2. Model is available on backend
3. Modality supported (multimodal, embedding)
4. Structured output supported
5. Capacity available: `current_concurrent + queue_depth < max_concurrent`
6. Memory fit: `vram_required_gb <= gpu_memory_gb`

**Soft scoring** (summed, higher = better):

| Factor | Max Points | Lynkr Equivalent |
|--------|--------|-------------------|
| Model loaded in GPU memory | +100 | N/A (cloud APIs) |
| Low GPU utilization | +50 | Could map to rate-limit headroom |
| Low latency (EMA) | +40 | We have `LatencyTracker` -- **adopt this** |
| Short queue depth | +30 | Could track in-flight requests per provider |
| High throughput | +20 | Could derive from telemetry |
| Admin priority boost | +N*10 | Could be config-based provider preference |

**Selection:** `argmax(backends, key=total_score)`, with ineligible backends returned with `total_score = -1` and `failed_constraints` list for debugging.

**Takeaway**: Lynkr already has latency tracking. Add **in-flight request counting** and **rate-limit headroom detection** to create a composite backend score instead of just tier-based routing.

---

### 3. Canonical Schema Pattern

All requests (OpenAI, Ollama, Anthropic) are normalized to a **canonical internal format** before routing, then translated back for the target backend. Lynkr already does format conversion, but MindRouter's approach is more structured — a single `CanonicalChatRequest` dataclass that all translators target.

**Canonical schemas include:**
- `CanonicalChatRequest` -- Unified with `messages`, `tools`, `tool_choice`, `response_format`, `think`, `reasoning_effort`, `backend_options`
- `CanonicalMessage` -- Supports text, multimodal content blocks, tool calls
- `CanonicalStreamChunk` / `CanonicalStreamDelta` -- Streaming with tool call deltas and reasoning content
- `CanonicalEmbeddingRequest`, `CanonicalRerankRequest`, `CanonicalScoreRequest` -- Specialized request types

**Takeaway**: Formalize Lynkr's format conversion into an explicit canonical schema. This makes it easier to add new providers (Codex, Gemini) without N*M translator combinations.

---

### 4. Circuit Breaker with Adaptive Polling

Their circuit breaker is more nuanced than Lynkr's:

- **3 consecutive failures** -> **OPEN** (stop routing)
- **After 30s** -> **HALF-OPEN** (allow one probe request)
- **Probe success** -> **CLOSED** (resume normal traffic)
- **During recovery**: **fast polling** (10s instead of 30s) for 120s

**Takeaway**: Lynkr's circuit breaker could adopt the **half-open probe** pattern instead of binary open/closed. This detects recovery faster.

---

### 5. Latency EMA (Exponential Moving Average)

Instead of Lynkr's circular buffer with percentiles, MindRouter uses EMA with alpha=0.3:

```
new_ema = alpha * latest_latency + (1 - alpha) * old_ema
```

- Simpler, constant memory
- More responsive to recent changes (alpha=0.3 means recent data is 30% of signal)
- Tracks both **total latency** and **TTFT** (time to first token) separately
- Throughput score: `1.0 / (1.0 + latency_ms / 5000.0)`
- Persisted to DB every 30s

**Takeaway**: Consider adding TTFT tracking — for streaming responses, time-to-first-token matters more than total latency.

---

### 6. Streaming Retry Logic

MindRouter only retries before the first chunk is sent. Once streaming starts, failures are terminal. They also track in-flight tokens via Redis (flushed every 10 chunks).

**Takeaway**: Lynkr should adopt the same pattern — retry with failover is only safe before streaming begins.

---

### 7. `max_tokens` Capping

```
max_tokens = min(requested, context_length - input_tokens - 1024_buffer, 65536_hard_cap)
```

They use vLLM's `/tokenize` endpoint for exact counts or tiktoken for estimation.

**Takeaway**: Lynkr could auto-cap `max_tokens` to prevent wasted budget and avoid provider errors.

---

### 8. Additional Notable Features

- **GPU Sidecar Agent**: Lightweight FastAPI service per GPU node using `pynvml` for real-time GPU metrics
- **Drain mode**: Stops new routing to a backend, auto-disables when queue hits 0
- **Per-user token quotas**: Role-based with group weights stored in DB
- **Full audit logging**: Every prompt and response recorded
- **Voice API**: TTS and STT endpoints
- **Web search**: Brave Search API integration injects web results as context
- **Prometheus metrics**: `/metrics` endpoint for observability

---

## Recommended Adoptions for Lynkr

| Priority | Feature | Effort | Impact |
|----------|---------|--------|--------|
| **P0** | TTFT tracking in LatencyTracker | Small | Better streaming-aware routing |
| **P0** | Half-open circuit breaker probe | Small | Faster recovery detection |
| **P1** | In-flight request counting per provider | Medium | Load-aware routing |
| **P1** | Composite backend scoring (latency + load + headroom) | Medium | Replaces simple tier mapping |
| **P2** | Per-user deficit tracking | Medium | Fair resource allocation |
| **P2** | Canonical schema formalization | Large | Cleaner multi-provider support |
| **P3** | `max_tokens` auto-capping | Small | Prevents wasted tokens |
| **P3** | Pre-stream retry / post-stream terminal | Small | Correct streaming error handling |

---

## Configuration Reference

Key MindRouter settings that inform Lynkr defaults:

| Setting | Default | Purpose |
|---------|---------|---------|
| `scheduler_fairness_window` | 300s | Rolling window for usage tracking |
| `scheduler_deprioritize_threshold` | 0.5 | Usage fraction that triggers deprioritization |
| `scheduler_score_model_loaded` | 100 | Weight for "model in GPU memory" |
| `scheduler_score_low_utilization` | 50 | Weight for GPU headroom |
| `scheduler_score_latency` | 40 | Weight for low latency |
| `scheduler_score_short_queue` | 30 | Weight for short queue |
| `scheduler_score_high_throughput` | 20 | Weight for throughput |
| `backend_retry_max_attempts` | 3 | Max retry attempts per request |
| `backend_request_timeout` | 300s | Total request timeout |
| `backend_circuit_breaker_threshold` | 3 | Failures before circuit opens |
| `backend_circuit_breaker_recovery_seconds` | 30s | Time before half-open probe |
| `latency_ema_alpha` | 0.3 | EMA responsiveness |
| `backend_poll_interval` | 30s | Normal health poll interval |
| `backend_adaptive_poll_fast_interval` | 10s | Fast poll during recovery |
