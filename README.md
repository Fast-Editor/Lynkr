# Lynkr 

[![npm version](https://img.shields.io/npm/v/lynkr.svg)](https://www.npmjs.com/package/lynkr)
[![Homebrew Tap](https://img.shields.io/badge/homebrew-lynkr-brightgreen.svg)](https://github.com/vishalveerareddy123/homebrew-lynkr)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/vishalveerareddy123/Lynkr)
[![Databricks Supported](https://img.shields.io/badge/Databricks-Supported-orange)](https://www.databricks.com/)
[![Ollama Compatible](https://img.shields.io/badge/Ollama-Compatible-brightgreen)](https://ollama.ai/)
[![IndexNow Enabled](https://img.shields.io/badge/IndexNow-Enabled-success?style=flat-square)](https://www.indexnow.org/)
[![DevHunt](https://img.shields.io/badge/DevHunt-Lynkr-orange)](https://devhunt.org/tool/lynkr)


> It is a Cli tool which acts like a HTTP proxy that lets Claude Code CLI talk to non-Anthropic backends, manage local tools, and compose Model Context Protocol (MCP) servers with prompt caching, repo intelligence, and Git-aware automation.

## Table of Contents

1. [Overview](#overview)
2. [Core Capabilities](#core-capabilities)
   - [Repo Intelligence & Navigation](#repo-intelligence--navigation)
   - [Git Workflow Enhancements](#git-workflow-enhancements)
   - [Diff & Change Management](#diff--change-management)
   - [Execution & Tooling](#execution--tooling)
   - [Workflow & Collaboration](#workflow--collaboration)
   - [UX, Monitoring, and Logs](#ux-monitoring-and-logs)
3. [Production Hardening Features](#production-hardening-features)
   - [Reliability & Resilience](#reliability--resilience)
   - [Observability & Monitoring](#observability--monitoring)
   - [Security & Governance](#security--governance)
   - [Performance Characteristics](#performance-characteristics)
4. [Architecture](#architecture)
5. [Getting Started](#getting-started)
6. [Configuration Reference](#configuration-reference)
7. [Runtime Operations](#runtime-operations)
   - [Launching the Proxy](#launching-the-proxy)
   - [Connecting Claude Code CLI](#connecting-claude-code-cli)
   - [Using Ollama Models](#using-ollama-models)
   - [Hybrid Routing with Automatic Fallback](#hybrid-routing-with-automatic-fallback)
   - [Using Built-in Workspace Tools](#using-built-in-workspace-tools)
   - [Working with Prompt Caching](#working-with-prompt-caching)
   - [Integrating MCP Servers](#integrating-mcp-servers)
   - [Health Checks & Monitoring](#health-checks--monitoring)
   - [Metrics & Observability](#metrics--observability)
8. [Manual Test Matrix](#manual-test-matrix)
9. [Troubleshooting](#troubleshooting)
10. [Roadmap & Known Gaps](#roadmap--known-gaps)
11. [FAQ](#faq)
12. [License](#license)

---

## Overview

This repository contains a Node.js service that emulates the Anthropic Claude Code backend so that the Claude Code CLI (or any compatible client) can operate against alternative model providers and custom tooling.

Key highlights:

- **Production-ready architecture** – 14 production hardening features including circuit breakers, load shedding, graceful shutdown, comprehensive metrics (Prometheus format), and Kubernetes-ready health checks. Minimal overhead (~7μs per request) with 140K req/sec throughput.
- **Multi-provider support** – Works with Databricks (default), Azure-hosted Anthropic endpoints, and local Ollama models; requests are normalized to each provider while returning Claude-flavored responses.
- **Enterprise observability** – Real-time metrics collection, structured logging with request ID correlation, latency percentiles (p50, p95, p99), token usage tracking, and cost attribution. Multiple export formats (JSON, Prometheus).
- **Resilience & reliability** – Exponential backoff with jitter for retries, circuit breaker protection against cascading failures, automatic load shedding during overload, and zero-downtime deployments via graceful shutdown.
- **Workspace awareness** – Local repo indexing, `CLAUDE.md` summaries, language-aware navigation, and Git helpers mirror core Claude Code workflows.
- **Model Context Protocol (MCP) orchestration** – Automatically discovers MCP manifests, launches JSON-RPC 2.0 servers, and re-exposes their tools inside the proxy.
- **Prompt caching** – Re-uses repeated prompts to reduce latency and token consumption, matching Claude's own cache semantics.
- **Policy enforcement** – Environment-driven guardrails control Git operations, test requirements, web fetch fallbacks, and sandboxing rules. Input validation and consistent error handling ensure API reliability.

The result is a production-ready, self-hosted alternative that stays close to Anthropic's ergonomics while providing enterprise-grade reliability, observability, and performance.

> **Compatibility note:** Claude models hosted on Databricks work out of the box. Set `MODEL_PROVIDER=azure-anthropic` (and related credentials) to target the Azure-hosted Anthropic `/anthropic/v1/messages` endpoint. Set `MODEL_PROVIDER=ollama` to use locally-running Ollama models (qwen2.5-coder, llama3, mistral, etc.).

Further documentation and usage notes are available on [DeepWiki](https://deepwiki.com/vishalveerareddy123/Lynkr).

---

## Core Capabilities

### Repo Intelligence & Navigation

- Fast indexer builds a lightweight SQLite catalog of files, symbols, references, and framework hints.
- `CLAUDE.md` summary highlights language mix, frameworks, lint configs, and dependency signals.
- Symbol search and reference lookups return definition sites and cross-file usage for supported languages (TypeScript/JavaScript/Python via Tree-sitter parsers) with heuristic fallbacks for others.
- Automatic invalidation ensures removed files disappear from search results after `workspace_index_rebuild`.

### Git Workflow Enhancements

- Git status, diff, stage, commit, push, and pull tooling via `src/tools/git.js`.
- Policy flags such as `POLICY_GIT_ALLOW_PUSH` and `POLICY_GIT_REQUIRE_TESTS` enforce push restrictions or test gating.
- Diff review endpoints summarise changes and highlight risks, feeding the AI review surface.
- Release note generator composes summarized change logs for downstream publishing.

### Diff & Change Management

- Unified diff summaries with optional AI review (`workspace_diff_review`).
- Release note synthesis from Git history.
- Test harness integrates with git policies to ensure guarding before commit/push events.
- (Planned) Per-file threaded reviews and automated risk estimation (see [Roadmap](#roadmap--known-gaps)).

### Execution & Tooling

- Tool execution pipeline sandboxes or runs tools in the host workspace based on policy.
- MCP sandbox orchestration (Docker runtime by default) optionally isolates external tools with mount and permission controls.
- Automated testing harness exposes `workspace_test_run`, `workspace_test_history`, and `workspace_test_summary`.
- Prompt caching reduces repeated token usage for iterative conversations.

### Workflow & Collaboration

- Lightweight task tracker (`workspace_task_*` tools) persists TODO items in SQLite.
- Session database (`data/sessions.db`) stores conversational transcripts for auditing.
- Policy web fallback fetches limited remote data when explicitly permitted.

### UX, Monitoring, and Logs

- Pino-based structured logs with timestamps and severity.
- Request/response logging for Databricks interactions (visible in stdout).
- Session appenders log every user, assistant, and tool turn for reproducibility.
- Metrics directory ready for future Prometheus/StatsD integration.

---

## Production Hardening Features

Lynkr includes comprehensive production-ready features designed for reliability, observability, and security in enterprise environments. These features add minimal performance overhead while providing robust operational capabilities.

### Reliability & Resilience

#### **Exponential Backoff with Jitter**
- Automatic retry logic for transient failures
- Configurable retry attempts (default: 3), initial delay (1s), and max delay (30s)
- Jitter prevents thundering herd problems during outages
- Intelligent retry logic distinguishes retryable errors (5xx, network timeouts) from permanent failures (4xx)

#### **Circuit Breaker Pattern**
- Protects against cascading failures to external services (Databricks, Azure Anthropic)
- Three states: CLOSED (normal), OPEN (failing fast), HALF_OPEN (testing recovery)
- Configurable failure threshold (default: 5) and success threshold (default: 2)
- Per-provider circuit breaker instances with independent state tracking
- Automatic recovery attempts after timeout period (default: 60s)

#### **Load Shedding**
- Proactive request rejection when system is overloaded
- Monitors heap usage (90% threshold), total memory (85% threshold), and active request count (1000 threshold)
- Returns HTTP 503 with Retry-After header during overload
- Cached overload state (1s cache) minimizes performance impact
- Graceful degradation prevents complete system failure

#### **Graceful Shutdown**
- SIGTERM/SIGINT signal handling for zero-downtime deployments
- Health check endpoints immediately return "not ready" during shutdown
- Connections drain with configurable timeout (default: 30s)
- Database connections and resources cleanly closed
- Kubernetes-friendly shutdown sequence

#### **HTTP Connection Pooling**
- Keep-alive connections reduce latency and connection overhead
- Configurable socket pools (50 max sockets, 10 free sockets)
- Separate HTTP and HTTPS agents with optimized settings
- Connection timeouts (60s) and keep-alive intervals (30s)

### Observability & Monitoring

#### **Metrics Collection**
- High-performance in-memory metrics with minimal overhead (0.2ms per operation)
- Request counts, error rates, latency percentiles (p50, p95, p99)
- Token usage tracking (input/output tokens) and cost estimation
- Databricks API metrics (success/failure rates, retry counts)
- Circuit breaker state tracking per provider

#### **Metrics Export Formats**
- **JSON endpoint** (`/metrics/observability`): Human-readable metrics for dashboards
- **Prometheus endpoint** (`/metrics/prometheus`): Industry-standard format for Prometheus scraping
- **Circuit breaker endpoint** (`/metrics/circuit-breakers`): Real-time circuit breaker state

#### **Health Check Endpoints**
- **Liveness probe** (`/health/live`): Basic process health for Kubernetes
- **Readiness probe** (`/health/ready`): Comprehensive dependency checks
  - Database connectivity and responsiveness
  - Memory usage within acceptable limits
  - Shutdown state detection
- Returns detailed health status with per-dependency breakdown

#### **Structured Request Logging**
- Request ID correlation across distributed systems (X-Request-ID header)
- Automatic request ID generation when not provided
- Structured JSON logs with request context (method, path, IP, user agent)
- Request/response timing and outcome logging
- Error context preservation for debugging

### Security & Governance

#### **Input Validation**
- Zero-dependency JSON schema-like validation
- Type checking (string, number, boolean, array, object)
- Range validation (min/max length, min/max value, array size limits)
- Enum validation and pattern matching
- Nested object validation with detailed error reporting
- Request body size limits and sanitization

#### **Error Handling**
- Consistent error response format across all endpoints
- Operational vs non-operational error classification
- 8 predefined error types (validation, authentication, authorization, not found, rate limit, external API, database, internal)
- User-friendly error messages (stack traces only in development)
- Request ID in all error responses for traceability

#### **Path Allowlisting & Sandboxing**
- Configurable filesystem path restrictions
- Command execution sandboxing (Docker runtime support)
- MCP tool isolation with permission controls
- Environment variable filtering and secrets protection

#### **Rate Limiting & Budget Enforcement**
- Token budget tracking per session
- Configurable budget limits and enforcement policies
- Cost tracking and budget exhaustion handling
- Request-level cost attribution

### Performance Characteristics

#### **Benchmark Results**
Based on comprehensive performance testing with 100,000+ operations:

| Component | Throughput | Latency | Overhead |
|-----------|------------|---------|----------|
| Baseline (no-op) | 21.3M ops/sec | 0.00005ms | - |
| Metrics Collection | 4.7M ops/sec | 0.0002ms | 0.15ms |
| Load Shedding Check | 7.6M ops/sec | 0.0001ms | 0.08ms |
| Circuit Breaker | 4.3M ops/sec | 0.0002ms | 0.18ms |
| Input Validation (simple) | 5.8M ops/sec | 0.0002ms | 0.12ms |
| Input Validation (complex) | 890K ops/sec | 0.0011ms | 0.96ms |
| Combined Middleware Stack | 140K ops/sec | 0.0071ms | 7.1μs |

**Overall Performance Rating:** ⭐ **EXCELLENT**
- Total middleware overhead: **7.1 microseconds** per request
- Throughput: **140,000 requests/second**
- Memory overhead: **~4MB** for typical workload

#### **Production Deployment Metrics**
- **Test Coverage:** 80 comprehensive tests with 100% pass rate
- **Feature Completeness:** 14/14 production features implemented
- **Zero-downtime Deployments:** Supported via graceful shutdown
- **Horizontal Scaling:** Stateless design enables unlimited horizontal scaling
- **Vertical Scaling:** Efficient resource usage supports high request volumes

#### **Scalability Profile**
- Single instance handles 140K req/sec under test conditions
- Linear scaling with additional instances (no shared state)
- Memory usage: ~100MB baseline + ~4MB per 10K active requests
- CPU usage: <5% per core at moderate load
- Network: Limited by backend API latency, not proxy overhead

For detailed performance analysis, benchmarks, and deployment guidance, see [PERFORMANCE-REPORT.md](PERFORMANCE-REPORT.md).

---

## Architecture

```
┌────────────────────┐      ┌───────────────────────────────────────────┐
│ Claude Code CLI    │──HTTP│ Claude Code Proxy (Express API Gateway)   │
│ (or Claude client) │      │ ┌─────────────────────────────────────┐   │
└────────────────────┘      │ │ Production Middleware Stack         │   │
                            │ │ • Load Shedding (503 on overload)   │   │
                            │ │ • Request Logging (Request IDs)     │   │
                            │ │ • Metrics Collection (Prometheus)   │   │
                            │ │ • Input Validation (JSON schema)    │   │
                            │ │ • Error Handling (Consistent format)│   │
                            │ └─────────────────────────────────────┘   │
                            └──────────┬────────────────────────────────┘
                                       │
        ┌──────────────────────────────┼──────────────────────────────────┐
        │                              │                                  │
┌───────▼───────┐              ┌───────▼────────┐              ┌─────────▼────────┐
│ Orchestrator  │              │ Prompt Cache   │              │ Session Store    │
│ (agent loop)  │              │ (LRU + TTL)    │              │ (SQLite)         │
└───────┬───────┘              └────────────────┘              └──────────────────┘
        │
        │  ┌─────────────────────────────────────────────────────────────┐
        │  │ Health Checks & Metrics Endpoints                           │
        │  │ • /health/live - Kubernetes liveness probe                  │
        └──│ • /health/ready - Readiness with dependency checks          │
           │ • /metrics/observability - JSON metrics                     │
           │ • /metrics/prometheus - Prometheus format                   │
           │ • /metrics/circuit-breakers - Circuit breaker state         │
           └─────────────────────────────────────────────────────────────┘
                                       │
        ┌──────────────────────────────┼──────────────────────────────────┐
        │                              │                                  │
┌───────▼────────────────────────────┐ │  ┌──────────────────────────────▼──┐
│ Tool Registry & Policy Engine      │ │  │ Indexer / Repo Intelligence     │
│ (workspace, git, diff, MCP tools)  │ │  │ (SQLite catalog + CLAUDE.md)    │
└───────┬────────────────────────────┘ │  └─────────────────────────────────┘
        │                              │
        │                   ┌──────────▼─────────────────────┐
        │                   │ Observability & Resilience     │
        │                   │ • MetricsCollector (in-memory) │
        │                   │ • Circuit Breakers (per-provider)│
        │                   │ • Load Shedder (resource monitor)│
        │                   │ • Shutdown Manager (graceful)  │
        │                   └──────────┬─────────────────────┘
        │                              │
┌───────▼────────┐          ┌─────────▼──────────────────────┐      ┌──────────────┐
│ MCP Registry   │          │ Provider Adapters              │      │ Sandbox      │
│ (manifest ->   │──RPC─────│ • Databricks (circuit-breaker) │──┐   │ Runtime      │
│ JSON-RPC client│          │ • Azure Anthropic (retry logic)│  │   │ (Docker)     │
└────────────────┘          │ • Ollama (local models)        │  │   └──────────────┘
                            │ • HTTP Connection Pooling      │  │
                            │ • Exponential Backoff + Jitter │  │
                            └────────────┬───────────────────┘  │
                                         │                      │
                        ┌────────────────┼────────────┐         │
                        │                │            │         │
              ┌─────────▼────────┐  ┌───▼────────┐  ┌▼─────────────┐
              │ Databricks       │  │ Azure      │  │ Ollama API   │───────┘
              │ Serving Endpoint │  │ Anthropic  │  │ (localhost)  │
              │ (REST)           │  │ /anthropic │  │ qwen2.5-coder│
              └──────────────────┘  │ /v1/messages│  └──────────────┘
                                    └────────────┘
                                         │
                                ┌────────▼──────────┐
                                │ External MCP tools│
                                │ (GitHub, Jira)    │
                                └───────────────────┘
```

- **`src/api/router.js`** – Express routes that accept Claude-compatible `/v1/messages` requests.
- **`src/api/middleware/*`** – Production middleware stack:
  - `load-shedding.js` – Proactive overload protection with resource monitoring
  - `request-logging.js` – Structured logging with request ID correlation
  - `metrics.js` – High-performance metrics collection middleware
  - `validation.js` – Zero-dependency input validation
  - `error-handling.js` – Consistent error response formatting
- **`src/api/health.js`** – Kubernetes-ready liveness and readiness probes
- **`src/orchestrator/index.js`** – Agent loop handling model invocation, tool execution, prompt caching, and policy enforcement.
- **`src/cache/prompt.js`** – LRU cache implementation with SHA-256 keying and TTL eviction.
- **`src/observability/metrics.js`** – In-memory metrics collector with Prometheus export
- **`src/clients/circuit-breaker.js`** – Circuit breaker implementation for external service protection
- **`src/clients/retry.js`** – Exponential backoff with jitter for transient failure handling
- **`src/server/shutdown.js`** – Graceful shutdown manager for zero-downtime deployments
- **`src/mcp/*`** – Manifest discovery, JSON-RPC 2.0 client, and dynamic tool registration for MCP servers.
- **`src/tools/*`** – Built-in workspace, git, diff, testing, task, and MCP bridging tools.
- **`src/indexer/index.js`** – File crawler and metadata extractor that persists into SQLite and regenerates `CLAUDE.md`.

---

## Getting Started

### Prerequisites

- **Node.js 18+** (required for the global `fetch` API).
- **npm** (bundled with Node).
- **Databricks account** with a Claude-compatible serving endpoint (e.g., `databricks-claude-sonnet-4-5`).
- Optional: **Docker** for MCP sandboxing and tool isolation.
- Optional: **Claude Code CLI** (latest release). Configure it to target the proxy URL instead of api.anthropic.com.

### Installation

Lynkr offers multiple installation methods to fit your workflow:

#### Option 1: Simple Databricks Setup (Quickest)

**No Ollama needed** - Just use Databricks APIs directly:

```bash
# Install Lynkr
npm install -g lynkr

# Configure Databricks credentials
export DATABRICKS_API_BASE=https://your-workspace.cloud.databricks.com
export DATABRICKS_API_KEY=dapi1234567890abcdef

# Start Lynkr
lynkr
```

That's it! Lynkr will use Databricks Claude models for all requests.

**Or use a .env file:**
```env
MODEL_PROVIDER=databricks
DATABRICKS_API_BASE=https://your-workspace.cloud.databricks.com
DATABRICKS_API_KEY=dapi1234567890abcdef
PORT=8080
```

#### Option 2: Hybrid Setup with Ollama (Cost Savings)

For 40% faster responses and 65% cost savings on simple requests:

```bash
# Install Lynkr
npm install -g lynkr

# Run setup wizard (installs Ollama + downloads model)
lynkr-setup

# Start Lynkr
lynkr
```

**The `lynkr-setup` wizard will:**
- ✅ Check if Ollama is installed (auto-installs if missing on macOS/Linux)
- ✅ Start Ollama service
- ✅ Download qwen2.5-coder model (~4.7GB)
- ✅ Create `.env` configuration file
- ✅ Guide you through Databricks credential setup

**Note**: On Windows, you'll need to manually install Ollama from https://ollama.ai/download, then run `lynkr-setup`.

#### Option 3: Docker Compose (Bundled)

For a complete bundled experience with Ollama included:

```bash
# Clone repository
git clone https://github.com/vishalveerareddy123/Lynkr.git
cd Lynkr

# Copy environment template
cp .env.example .env

# Edit .env with your Databricks credentials
nano .env

# Start both services (Lynkr + Ollama)
docker-compose up -d

# Pull model (first time only)
docker exec ollama ollama pull qwen2.5-coder:latest

# Verify it's running
curl http://localhost:8080/health
```

See [DEPLOYMENT.md](DEPLOYMENT.md) for advanced deployment options (Kubernetes, systemd, etc.).

#### Option 4: Homebrew (macOS)

```bash
brew tap vishalveerareddy123/lynkr
brew install vishalveerareddy123/lynkr/lynkr

# Configure Databricks (Ollama optional)
export DATABRICKS_API_BASE=https://your-workspace.cloud.databricks.com
export DATABRICKS_API_KEY=dapi1234567890abcdef

# Start Lynkr
lynkr
```

**Optional**: Install Ollama for hybrid routing:
```bash
brew install ollama
ollama serve
ollama pull qwen2.5-coder:latest
```

#### Option 5: From Source

```bash
# Clone repository
git clone https://github.com/vishalveerareddy123/Lynkr.git
cd Lynkr

# Install dependencies
npm install

# Start server
npm start
```

#### Configuration

After installation, configure Lynkr by creating a `.env` file or exporting environment variables:

```env
# For Databricks-only setup (no Ollama)
MODEL_PROVIDER=databricks
DATABRICKS_API_BASE=https://<your-workspace>.cloud.databricks.com
DATABRICKS_API_KEY=<personal-access-token>
PORT=8080
WORKSPACE_ROOT=/path/to/your/repo
PROMPT_CACHE_ENABLED=true
```

For hybrid routing with Ollama + cloud fallback, see [Hybrid Routing](#hybrid-routing-with-automatic-fallback) section below.

You can copy `.env.example` if you maintain one, or rely on shell exports.

#### Selecting a model provider

Set `MODEL_PROVIDER` to select the upstream endpoint:

- `MODEL_PROVIDER=databricks` (default) – expects `DATABRICKS_API_BASE`, `DATABRICKS_API_KEY`, and optionally `DATABRICKS_ENDPOINT_PATH`.
- `MODEL_PROVIDER=azure-anthropic` – routes requests to Azure's `/anthropic/v1/messages` endpoint and uses the headers Azure expects.
- `MODEL_PROVIDER=ollama` – connects to a locally-running Ollama instance for models like qwen2.5-coder, llama3, mistral, etc.

**Azure-hosted Anthropic configuration:**

```env
MODEL_PROVIDER=azure-anthropic
AZURE_ANTHROPIC_ENDPOINT=https://<resource-name>.services.ai.azure.com/anthropic/v1/messages
AZURE_ANTHROPIC_API_KEY=<azure-api-key>
AZURE_ANTHROPIC_VERSION=2023-06-01
PORT=8080
WORKSPACE_ROOT=/path/to/your/repo
```

**Ollama configuration:**

```env
MODEL_PROVIDER=ollama
OLLAMA_ENDPOINT=http://localhost:11434  # default Ollama endpoint
OLLAMA_MODEL=qwen2.5-coder:latest       # model to use
OLLAMA_TIMEOUT_MS=120000                # request timeout
PORT=8080
WORKSPACE_ROOT=/path/to/your/repo
```

Before starting Lynkr with Ollama, ensure Ollama is running:

```bash
# Start Ollama (in a separate terminal)
ollama serve

# Pull your desired model
ollama pull qwen2.5-coder:latest
# Or: ollama pull llama3, mistral, etc.

# Verify model is available
ollama list
```

---

## Configuration Reference

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | HTTP port for the proxy server. | `8080` |
| `WORKSPACE_ROOT` | Filesystem path exposed to workspace tools and indexer. | `process.cwd()` |
| `MODEL_PROVIDER` | Selects the model backend (`databricks`, `azure-anthropic`, `ollama`). | `databricks` |
| `MODEL_DEFAULT` | Overrides the default model/deployment name sent to the provider. | Provider-specific default |
| `DATABRICKS_API_BASE` | Base URL of your Databricks workspace (required when `MODEL_PROVIDER=databricks`). | – |
| `DATABRICKS_API_KEY` | Databricks PAT used for the serving endpoint (required for Databricks). | – |
| `DATABRICKS_ENDPOINT_PATH` | Optional override for the Databricks serving endpoint path. | `/serving-endpoints/databricks-claude-sonnet-4-5/invocations` |
| `AZURE_ANTHROPIC_ENDPOINT` | Full HTTPS endpoint for Azure-hosted Anthropic `/anthropic/v1/messages` (required when `MODEL_PROVIDER=azure-anthropic`). | – |
| `AZURE_ANTHROPIC_API_KEY` | API key supplied via the `x-api-key` header for Azure Anthropic. | – |
| `AZURE_ANTHROPIC_VERSION` | Anthropic API version header for Azure Anthropic calls. | `2023-06-01` |
| `OLLAMA_ENDPOINT` | Ollama API endpoint URL (required when `MODEL_PROVIDER=ollama`). | `http://localhost:11434` |
| `OLLAMA_MODEL` | Ollama model name to use (e.g., `qwen2.5-coder:latest`, `llama3`, `mistral`). | `qwen2.5-coder:7b` |
| `OLLAMA_TIMEOUT_MS` | Request timeout for Ollama API calls in milliseconds. | `120000` (2 minutes) |
| `PROMPT_CACHE_ENABLED` | Toggle the prompt cache system. | `true` |
| `PROMPT_CACHE_TTL_MS` | Milliseconds before cached prompts expire. | `300000` (5 minutes) |
| `PROMPT_CACHE_MAX_ENTRIES` | Maximum number of cached prompts retained. | `64` |
| `POLICY_MAX_STEPS` | Max agent loop iterations before timeout. | `8` |
| `POLICY_GIT_ALLOW_PUSH` | Allow/disallow `workspace_git_push`. | `false` |
| `POLICY_GIT_REQUIRE_TESTS` | Enforce passing tests before `workspace_git_commit`. | `false` |
| `POLICY_GIT_TEST_COMMAND` | Custom test command invoked by policies. | `null` |
| `WEB_SEARCH_ENDPOINT` | URL for policy-driven web fetch fallback. | `http://localhost:8888/search` |
| `WEB_SEARCH_ALLOWED_HOSTS` | Comma-separated allowlist for `web_fetch`. | `null` |
| `MCP_SERVER_MANIFEST` | Single manifest file for MCP server. | `null` |
| `MCP_MANIFEST_DIRS` | Semicolon-separated directories scanned for manifests. | `~/.claude/mcp` |
| `MCP_SANDBOX_ENABLED` | Enable container sandbox for MCP tools (requires `MCP_SANDBOX_IMAGE`). | `true` |
| `MCP_SANDBOX_IMAGE` | Docker/OCI image name used for sandboxing. | `null` |
| `WORKSPACE_TEST_COMMAND` | Default CLI used by `workspace_test_run`. | `null` |
| `WORKSPACE_TEST_TIMEOUT_MS` | Test harness timeout. | `600000` |
| `WORKSPACE_TEST_COVERAGE_FILES` | Comma-separated coverage summary files. | `coverage/coverage-summary.json` |

### Production Hardening Configuration

| Variable | Description | Default |
|----------|-------------|---------|
| `API_RETRY_MAX_RETRIES` | Maximum retry attempts for transient failures. | `3` |
| `API_RETRY_INITIAL_DELAY` | Initial retry delay in milliseconds. | `1000` |
| `API_RETRY_MAX_DELAY` | Maximum retry delay in milliseconds. | `30000` |
| `CIRCUIT_BREAKER_FAILURE_THRESHOLD` | Failures before circuit opens. | `5` |
| `CIRCUIT_BREAKER_SUCCESS_THRESHOLD` | Successes needed to close circuit from half-open. | `2` |
| `CIRCUIT_BREAKER_TIMEOUT` | Time before attempting recovery (ms). | `60000` |
| `LOAD_SHEDDING_MEMORY_THRESHOLD` | Memory usage threshold (0-1) before shedding load. | `0.85` |
| `LOAD_SHEDDING_HEAP_THRESHOLD` | Heap usage threshold (0-1) before shedding load. | `0.90` |
| `LOAD_SHEDDING_ACTIVE_REQUESTS_THRESHOLD` | Max concurrent requests before shedding. | `1000` |
| `GRACEFUL_SHUTDOWN_TIMEOUT` | Shutdown timeout in milliseconds. | `30000` |
| `METRICS_ENABLED` | Enable metrics collection. | `true` |
| `HEALTH_CHECK_ENABLED` | Enable health check endpoints. | `true` |
| `REQUEST_LOGGING_ENABLED` | Enable structured request logging. | `true` |

See `src/config/index.js` for the full configuration matrix, including sandbox mounts, permissions, and MCP networking policies.

---

## Runtime Operations

### Launching the Proxy

```bash
# global install
lynkr start

# local checkout
npm run dev    # development: auto-restarts on file changes
npm start      # production
```

Logs stream to stdout. The server listens on `PORT` and exposes `/v1/messages` in the Anthropic-compatible shape. If you installed via npm globally, `lynkr start` reads the same environment variables described above.

### Connecting Claude Code CLI

1. Install or upgrade Claude Code CLI.
2. Export the proxy endpoint:
   ```bash
   export ANTHROPIC_BASE_URL=http://localhost:8080
   export ANTHROPIC_API_KEY=dummy # not used, but Anthropic CLI requires it
   ```
3. Launch `claude` CLI within `WORKSPACE_ROOT`.
4. Invoke commands as normal; the CLI will route requests through the proxy.

### Using Ollama Models

Lynkr can connect to locally-running Ollama models for fast, offline AI assistance. This is ideal for development environments, air-gapped systems, or cost optimization.

**Quick Start with Ollama:**

```bash
# Terminal 1: Start Ollama
ollama serve

# Terminal 2: Pull and verify model
ollama pull qwen2.5-coder:latest
ollama list

# Terminal 3: Start Lynkr with Ollama
export MODEL_PROVIDER=ollama
export OLLAMA_ENDPOINT=http://localhost:11434
export OLLAMA_MODEL=qwen2.5-coder:latest
npm start

# Terminal 4: Connect Claude CLI
export ANTHROPIC_BASE_URL=http://localhost:8080
export ANTHROPIC_API_KEY=dummy
claude
```

**Supported Ollama Models:**

Lynkr works with any Ollama model. Popular choices:

- **qwen2.5-coder:latest** – Optimized for code generation (7B parameters, 4.7GB)
- **llama3:latest** – General-purpose conversational model (8B parameters, 4.7GB)
- **mistral:latest** – Fast, efficient model (7B parameters, 4.1GB)
- **codellama:latest** – Meta's code-focused model (7B-34B variants)

**Performance Characteristics:**

- **Latency**: ~100-500ms first token (depending on model size and hardware)
- **Throughput**: ~20-50 tokens/sec on M1/M2 Macs, ~10-30 tokens/sec on typical CPUs
- **Memory**: 8GB RAM minimum recommended for 7B models, 16GB for 13B models
- **Disk**: 4-10GB per model (quantized)

**Ollama Health Check:**

```bash
# Basic health check
curl http://localhost:8080/health/ready

# Deep health check (includes Ollama connectivity)
curl "http://localhost:8080/health/ready?deep=true" | jq .checks.ollama
```

**Tool Calling Support:**

Lynkr now supports **native tool calling** for compatible Ollama models:

- ✅ **Supported models**: llama3.1, llama3.2, qwen2.5, qwen2.5-coder, mistral, mistral-nemo, firefunction-v2
- ✅ **Automatic detection**: Lynkr detects tool-capable models and enables tools automatically
- ✅ **Format conversion**: Transparent conversion between Anthropic and Ollama tool formats
- ❌ **Unsupported models**: llama3, older models (tools are filtered out automatically)

See [OLLAMA-TOOL-CALLING.md](OLLAMA-TOOL-CALLING.md) for implementation details.

**Limitations:**

- Tool choice parameter is not supported (Ollama always uses "auto" mode)
- Some advanced Claude features (extended thinking, prompt caching) are not available with Ollama

### Hybrid Routing with Automatic Fallback

Lynkr supports **intelligent hybrid routing** that automatically routes requests between Ollama (local/fast) and cloud providers (Databricks/Azure) based on request complexity, with transparent fallback when Ollama is unavailable.

**Why Hybrid Routing?**

- 🚀 **40-87% faster** for simple requests (local Ollama)
- 💰 **65-100% cost savings** for requests that stay on Ollama
- 🛡️ **Automatic fallback** ensures reliability when Ollama fails
- 🔒 **Privacy-preserving** for simple queries (never leave your machine)

**Quick Start:**

```bash
# Terminal 1: Start Ollama
ollama serve
ollama pull qwen2.5-coder:latest

# Terminal 2: Start Lynkr with hybrid routing
export PREFER_OLLAMA=true
export OLLAMA_ENDPOINT=http://localhost:11434
export OLLAMA_MODEL=qwen2.5-coder:latest
export DATABRICKS_API_KEY=your_key           # Fallback provider
export DATABRICKS_API_BASE=your_base_url     # Fallback provider
npm start

# Terminal 3: Connect Claude CLI (works transparently)
export ANTHROPIC_BASE_URL=http://localhost:8080
export ANTHROPIC_API_KEY=dummy
claude
```

**How It Works:**

Lynkr intelligently routes each request:

1. **Simple requests (0-2 tools)** → Try Ollama first
   - ✅ If Ollama succeeds: Fast, local response (100-500ms)
   - ❌ If Ollama fails: Automatic transparent fallback to cloud

2. **Complex requests (3+ tools)** → Route directly to cloud
   - Ollama isn't attempted (saves time on requests better suited for cloud)

3. **Tool-incompatible models** → Route directly to cloud
   - Requests requiring tools with non-tool-capable Ollama models skip Ollama

**Configuration:**

```bash
# Required
PREFER_OLLAMA=true                    # Enable hybrid routing mode

# Optional (with defaults)
OLLAMA_FALLBACK_ENABLED=true          # Enable automatic fallback (default: true)
OLLAMA_MAX_TOOLS_FOR_ROUTING=3        # Max tools to route to Ollama (default: 3)
OLLAMA_FALLBACK_PROVIDER=databricks   # Cloud provider for fallback (default: databricks)
```

**Example Scenarios:**

```bash
# Scenario 1: Simple code generation (no tools)
User: "Write a hello world function in Python"
→ Routes to Ollama (fast, local, free)
→ Response in ~300ms

# Scenario 2: Complex workflow with multiple tools
User: "Search the codebase, read 5 files, and refactor them"
→ Routes directly to cloud (5+ tools, better suited for Databricks)
→ Response in ~2000ms

# Scenario 3: Ollama unavailable
User: "What is 2+2?"
→ Tries Ollama (connection refused)
→ Automatic fallback to Databricks
→ Response in ~1500ms (user sees no error)
```

**Circuit Breaker Protection:**

After 5 consecutive Ollama failures, the circuit breaker opens:
- Subsequent requests skip Ollama entirely (fail-fast)
- Fallback happens in <100ms instead of waiting for timeout
- Circuit auto-recovers after 60 seconds

**Monitoring:**

Track routing performance via `/metrics/observability`:

```bash
curl http://localhost:8080/metrics/observability | jq '.routing, .fallback, .cost_savings'
```

Example output:
```json
{
  "routing": {
    "by_provider": {"ollama": 100, "databricks": 20},
    "successes_by_provider": {"ollama": 85, "databricks": 20},
    "failures_by_provider": {"ollama": 15}
  },
  "fallback": {
    "attempts_total": 15,
    "successes_total": 13,
    "failures_total": 2,
    "success_rate": "86.67%",
    "reasons": {
      "circuit_breaker": 8,
      "timeout": 4,
      "service_unavailable": 3
    }
  },
  "cost_savings": {
    "ollama_savings_usd": "1.2345",
    "ollama_latency_ms": { "mean": 450, "p95": 1200 }
  }
}
```

**Rollback:**

Disable hybrid routing anytime:

```bash
# Option 1: Disable entirely (use static MODEL_PROVIDER)
export PREFER_OLLAMA=false
npm start

# Option 2: Ollama-only mode (no fallback)
export PREFER_OLLAMA=true
export OLLAMA_FALLBACK_ENABLED=false
npm start
```

**Performance Comparison:**

| Metric | Cloud Only | Hybrid Routing | Improvement |
|--------|-----------|----------------|-------------|
| **Simple requests** | 1500-2500ms | 300-600ms | 70-87% faster ⚡ |
| **Complex requests** | 1500-2500ms | 1500-2500ms | No change (routes to cloud) |
| **Cost per simple request** | $0.002-0.005 | $0.00 | 100% savings 💰 |
| **Fallback latency** | N/A | <100ms | Transparent to user |

See [HYBRID-ROUTING-ANALYSIS.md](HYBRID-ROUTING-ANALYSIS.md) for detailed performance analysis.

### Using Built-in Workspace Tools

You can call tools programmatically via HTTP:

```bash
curl http://localhost:8080/v1/messages \
  -H 'Content-Type: application/json' \
  -H 'x-session-id: manual-test' \
  -d '{
    "model": "claude-proxy",
    "messages": [{ "role": "user", "content": "Rebuild the workspace index." }],
    "tools": [{
      "name": "workspace_index_rebuild",
      "type": "function",
      "description": "Rebuild the repo index and project summary",
      "input_schema": { "type": "object" }
    }],
    "tool_choice": {
      "type": "function",
      "function": { "name": "workspace_index_rebuild" }
    }
  }'
```

Tool responses appear in the assistant content block with structured JSON.

### Working with Prompt Caching

- Set `PROMPT_CACHE_ENABLED=true` (default) to activate the cache.
- The cache retains up to `PROMPT_CACHE_MAX_ENTRIES` entries for `PROMPT_CACHE_TTL_MS` milliseconds.
- A cache hit skips the Databricks call; response metadata populates `cache_read_input_tokens`.
- Cache misses record `cache_creation_input_tokens`, indicating a fresh prompt was cached.
- Cache entries are invalidated automatically when they age out; no manual maintenance required.
- Disable caching temporarily by exporting `PROMPT_CACHE_ENABLED=false` and restarting the server.

### Integrating MCP Servers

1. Place MCP manifest JSON files under `~/.claude/mcp` or configure `MCP_MANIFEST_DIRS`.
2. Each manifest should define the server command, arguments, and capabilities per the MCP spec.
3. Restart the proxy; manifests are loaded at boot. Registered tools appear with names `mcp_<server>_<tool>`.
4. Invoke tools via `workspace_mcp_call` or indirectly when the assistant selects them.
5. Sandbox settings (`MCP_SANDBOX_*`) control Docker runtime, mounts, environment passthrough, and permission prompts.

### Health Checks & Monitoring

Lynkr exposes Kubernetes-ready health check endpoints for orchestrated deployments:

#### Liveness Probe
```bash
curl http://localhost:8080/health/live
```

Returns `200 OK` with basic process health. Use this for Kubernetes liveness probes to detect crashed or frozen processes.

**Kubernetes Configuration:**
```yaml
livenessProbe:
  httpGet:
    path: /health/live
    port: 8080
  initialDelaySeconds: 10
  periodSeconds: 10
  timeoutSeconds: 5
  failureThreshold: 3
```

#### Readiness Probe
```bash
curl http://localhost:8080/health/ready
```

Returns `200 OK` when ready to serve traffic, or `503 Service Unavailable` when:
- System is shutting down
- Database connections are unavailable
- Memory usage exceeds safe thresholds

**Response Format:**
```json
{
  "status": "healthy",
  "timestamp": "2024-01-15T10:30:00.000Z",
  "checks": {
    "database": {
      "healthy": true,
      "latency": 12
    },
    "memory": {
      "healthy": true,
      "heapUsedPercent": 45.2,
      "totalUsedPercent": 52.1
    }
  }
}
```

**Kubernetes Configuration:**
```yaml
readinessProbe:
  httpGet:
    path: /health/ready
    port: 8080
  initialDelaySeconds: 5
  periodSeconds: 5
  timeoutSeconds: 3
  failureThreshold: 2
```

### Metrics & Observability

Lynkr collects comprehensive metrics with minimal performance overhead (7.1μs per request). Three endpoints provide different views:

#### JSON Metrics (Human-Readable)
```bash
curl http://localhost:8080/metrics/observability
```

Returns detailed metrics in JSON format:
```json
{
  "requests": {
    "total": 15234,
    "errors": 127,
    "errorRate": 0.0083
  },
  "latency": {
    "p50": 125.3,
    "p95": 342.1,
    "p99": 521.8,
    "count": 15234
  },
  "tokens": {
    "input": 1523421,
    "output": 823456,
    "total": 2346877
  },
  "cost": {
    "total": 234.56,
    "currency": "USD"
  },
  "databricks": {
    "requests": 15234,
    "successes": 15107,
    "failures": 127,
    "successRate": 0.9917,
    "retries": 89
  }
}
```

#### Prometheus Format (Scraping)
```bash
curl http://localhost:8080/metrics/prometheus
```

Returns metrics in Prometheus text format for scraping:
```
# HELP http_requests_total Total number of HTTP requests
# TYPE http_requests_total counter
http_requests_total 15234

# HELP http_request_errors_total Total number of HTTP request errors
# TYPE http_request_errors_total counter
http_request_errors_total 127

# HELP http_request_duration_seconds HTTP request latency
# TYPE http_request_duration_seconds summary
http_request_duration_seconds{quantile="0.5"} 0.1253
http_request_duration_seconds{quantile="0.95"} 0.3421
http_request_duration_seconds{quantile="0.99"} 0.5218
http_request_duration_seconds_count 15234
```

**Prometheus Configuration:**
```yaml
scrape_configs:
  - job_name: 'lynkr'
    static_configs:
      - targets: ['localhost:8080']
    metrics_path: '/metrics/prometheus'
    scrape_interval: 15s
```

#### Circuit Breaker State
```bash
curl http://localhost:8080/metrics/circuit-breakers
```

Returns real-time circuit breaker states:
```json
{
  "databricks": {
    "state": "CLOSED",
    "failureCount": 2,
    "successCount": 1523,
    "lastFailure": null,
    "nextAttempt": null
  },
  "azure-anthropic": {
    "state": "OPEN",
    "failureCount": 5,
    "successCount": 823,
    "lastFailure": "2024-01-15T10:25:00.000Z",
    "nextAttempt": "2024-01-15T10:26:00.000Z"
  }
}
```

#### Grafana Dashboard

For visualization, import the included Grafana dashboard (`monitoring/grafana-dashboard.json`) or create custom panels:
- Request rate and error rate over time
- Latency percentiles (p50, p95, p99)
- Token usage and cost tracking
- Circuit breaker state transitions
- Memory and CPU usage correlation

### Running with Docker

A `Dockerfile` and `docker-compose.yml` are included for reproducible deployments.

#### Build & run with Docker Compose

```bash
cp .env.example .env        # populate with Databricks/Azure credentials, workspace path, etc.
docker compose up --build
```

The compose file exposes:

- Proxy HTTP API on `8080`
- Optional SearxNG instance on `8888` (started automatically when `WEB_SEARCH_ENDPOINT` is the default)

Workspace files are mounted into the container (`./:/workspace`), and `./data` is persisted for SQLite state. If you launch the proxy outside of this compose setup you must provide your own search backend and point `WEB_SEARCH_ENDPOINT` at it (for example, a self-hosted SearxNG instance). Without a reachable search service the `web_search` and `web_fetch` tools will return placeholder responses or fail.

#### Manual Docker build

```bash
docker build -t claude-code-proxy .
docker run --rm -p 8080:8080 -p 8888:8888 \
  -v "$(pwd)":/workspace \
  -v "$(pwd)/data":/app/data \
  --env-file .env \
  claude-code-proxy
```

Adjust port and volume mappings to suit your environment. Ensure the container has access to the target workspace and required credentials.

#### Direct `docker run` with inline environment variables

```bash
docker run --rm -p 8080:8080 \
  -v "$(pwd)":/workspace \
  -v "$(pwd)/data":/app/data \
  -e MODEL_PROVIDER=databricks \
  -e DATABRICKS_API_BASE=https://<workspace>.cloud.databricks.com \
  -e DATABRICKS_ENDPOINT_PATH=/serving-endpoints/<endpoint-name>/invocations \
  -e DATABRICKS_API_KEY=<personal-access-token> \
  -e WORKSPACE_ROOT=/workspace \
  -e PORT=8080 \
  claude-code-proxy
```

Use additional `-e` flags (or `--env-file`) to pass Azure Anthropic credentials or other configuration values as needed.
Replace `<workspace>` and `<endpoint-name>` with your Databricks workspace host and the Serving Endpoint you want to target (e.g. `/serving-endpoints/databricks-gpt-4o-mini/invocations`) so you can choose any available model.

### Provider-specific behaviour

- **Databricks** – Mirrors Anthropic's hosted behaviour. Automatic policy web fallbacks (`needsWebFallback`) can trigger an extra `web_fetch`, and the upstream service executes dynamic pages on your behalf.
- **Azure Anthropic** – Requests are normalised to Azure's payload shape. The proxy disables automatic `web_fetch` fallbacks to avoid duplicate tool executions; instead, the assistant surfaces a diagnostic message and you can trigger the tool manually if required.
- **Ollama** – Connects to locally-running Ollama models. Tool definitions are filtered out since Ollama doesn't support native tool calling. System prompts are merged into the first user message. Response format is converted from Ollama's format to Anthropic-compatible content blocks. Best used for simple text generation tasks or as a cost-effective development environment.
- In all cases, `web_search` and `web_fetch` run locally. They do not execute JavaScript, so pages that render data client-side (Google Finance, etc.) will return scaffolding only. Prefer JSON/CSV quote APIs (e.g. Yahoo chart API) when you need live financial data.

---

## Manual Test Matrix

| Area | Scenario | Steps | Expected Outcome |
|------|----------|-------|------------------|
| **Indexing & Repo Intelligence** | Rebuild index | 1. `workspace_index_rebuild` 2. Inspect `CLAUDE.md` 3. Run `workspace_symbol_search` | CLAUDE.md and symbol catalog reflect current repo state. |
| | Remove file & reindex | 1. Delete a tracked file 2. Rebuild index 3. Search for removed symbol | Symbol search returns no hits; CLAUDE.md drops the file from language counts. |
| **Language Navigation** | Cross-file definition | 1. Choose TS symbol defined/imported across files 2. Search for symbol 3. Get references | Definition points to source file; references list usages in other files only. |
| | Unsupported language fallback | 1. Use Ruby file with unique method 2. Symbol search and references | Heuristic matches return without crashing. |
| **Project Summary** | After tests | 1. Run `workspace_index_rebuild` 2. Call `project_summary` | Summary includes latest test stats and style hints (e.g., ESLint). |
| | Missing coverage files | 1. Move coverage JSON 2. Call `project_summary` | Response notes missing coverage gracefully. |
| **Task Tracker** | CRUD flow | 1. `workspace_task_create` 2. `workspace_tasks_list` 3. `workspace_task_update` 4. `workspace_task_set_status` 5. `workspace_task_delete` | Tasks persist across calls; deletion removes entry. |
| **Git Guards** | Push policy | 1. `POLICY_GIT_ALLOW_PUSH=false` 2. `workspace_git_push` | Request denied with policy message. |
| | Require tests before commit | 1. `POLICY_GIT_REQUIRE_TESTS=true` 2. Attempt commit without running tests | Commit blocked until tests executed. |
| **Prompt Cache** | Cache hit | 1. Send identical prompt twice 2. Check logs | Second response logs cache hit; response usage shows `cache_read_input_tokens`. |
| **MCP** | Manifest discovery | 1. Add manifest 2. Restart proxy 3. Call `workspace_mcp_call` | MCP tools execute via JSON-RPC bridge. |
| **Health Checks** | Liveness probe | 1. `curl http://localhost:8080/health/live` | Returns 200 with basic health status. |
| | Readiness probe | 1. `curl http://localhost:8080/health/ready` | Returns 200 when ready, 503 during shutdown or unhealthy state. |
| **Metrics** | JSON metrics | 1. Make requests 2. `curl http://localhost:8080/metrics/observability` | Returns JSON with request counts, latency percentiles, token usage. |
| | Prometheus export | 1. Make requests 2. `curl http://localhost:8080/metrics/prometheus` | Returns Prometheus text format with counters and summaries. |
| | Circuit breaker state | 1. `curl http://localhost:8080/metrics/circuit-breakers` | Returns current state (CLOSED/OPEN/HALF_OPEN) for each provider. |
| **Load Shedding** | Overload protection | 1. Set low threshold 2. Make requests 3. Check response | Returns 503 with Retry-After header when overloaded. |
| **Circuit Breaker** | Failure threshold | 1. Simulate 5 consecutive failures 2. Check state | Circuit opens, subsequent requests fail fast with circuit breaker error. |
| | Recovery | 1. Wait for timeout 2. Make successful request | Circuit transitions to HALF_OPEN, then CLOSED after success threshold. |
| **Graceful Shutdown** | Zero-downtime | 1. Send SIGTERM 2. Check health endpoints 3. Wait for connections to drain | Health checks return 503, connections close gracefully within timeout. |
| **Input Validation** | Valid input | 1. Send valid request body 2. Check response | Request processes normally. |
| | Invalid input | 1. Send invalid request (missing required field) 2. Check response | Returns 400 with detailed validation errors. |
| **Error Handling** | Consistent format | 1. Trigger various errors (404, 500, validation) 2. Check responses | All errors follow consistent format with request ID. |
| **Request Logging** | Request ID correlation | 1. Make request with X-Request-ID header 2. Check logs 3. Check response headers | Logs show request ID, response includes same ID in header. |

---

## Troubleshooting

### General Issues

- **`path must be a non-empty string` errors** – Tool calls like `fs_read` require explicit paths. Verify the CLI sent a valid `path` argument.
- **Agent loop exceeding limits** – Increase `POLICY_MAX_STEPS` or fix misbehaving tool that loops.
- **`spawn npm test ENOENT`** – Configure `WORKSPACE_TEST_COMMAND` or ensure `npm test` exists in the workspace.
- **MCP server not discovered** – Confirm manifests live inside `MCP_MANIFEST_DIRS` and contain executable commands. Check logs for discovery errors.
- **Prompt cache not activating** – Ensure `PROMPT_CACHE_ENABLED=true`. Cache only stores tool-free completions; tool use requests bypass caching by design.
- **Claude CLI prompts for missing tools** – Verify `tools` array in the client request lists the functions you expect. The proxy only exposes registered handlers.
- **Dynamic finance pages return stale data** – `web_fetch` fetches static HTML only. Use an API endpoint (e.g. Yahoo Finance chart JSON) or the Databricks-hosted tooling if you need rendered values from heavily scripted pages.

### Production Hardening Issues

- **503 Service Unavailable errors during normal load** – Check load shedding thresholds (`LOAD_SHEDDING_*`). Lower values may trigger too aggressively. Check `/metrics/observability` for memory usage patterns.
- **Circuit breaker stuck in OPEN state** – Check `/metrics/circuit-breakers` to see failure counts. Verify backend service (Databricks/Azure) is accessible. Circuit will automatically attempt recovery after `CIRCUIT_BREAKER_TIMEOUT` (default: 60s).
- **"Circuit breaker is OPEN" errors** – The circuit breaker detected too many failures and is protecting against cascading failures. Wait for timeout or fix the underlying issue. Check logs for root cause of failures.
- **High latency after adding production features** – This is unexpected; middleware adds only ~7μs overhead. Check `/metrics/prometheus` for actual latency distribution. Verify network latency to backend services.
- **Health check endpoint returns 503 but service seems healthy** – Check individual health check components in the response JSON. Database connectivity or memory issues may trigger this. Review logs for specific health check failures.
- **Metrics endpoint shows incorrect data** – Metrics are in-memory and reset on restart. For persistent metrics, configure Prometheus scraping. Check that `METRICS_ENABLED=true`.
- **Request IDs not appearing in logs** – Ensure `REQUEST_LOGGING_ENABLED=true`. Check that structured logging is configured correctly in `src/logger.js`.
- **Validation errors on valid requests** – Check request body against schemas in `src/api/middleware/validation.js`. Validation is strict by design. Review error details in 400 response.
- **Graceful shutdown not working** – Ensure process receives SIGTERM (not SIGKILL). Check `GRACEFUL_SHUTDOWN_TIMEOUT` is sufficient for your workload. Kubernetes needs proper `terminationGracePeriodSeconds`.
- **Prometheus scraping fails** – Verify `/metrics/prometheus` endpoint is accessible. Check Prometheus configuration targets and `metrics_path`. Ensure firewall rules allow scraping.

### Performance Debugging

Run the included benchmarks to verify performance:
```bash
# Run comprehensive test suite
node comprehensive-test-suite.js

# Run performance benchmarks
node performance-benchmark.js
```

Expected results:
- Test pass rate: 100% (80/80 tests)
- Combined middleware overhead: <10μs per request
- Throughput: >100K requests/second

If performance is degraded:
1. Check `/metrics/observability` for latency patterns
2. Review memory usage (should be <200MB for typical workload)
3. Check circuit breaker states (stuck OPEN states add latency)
4. Verify backend API latency (primary bottleneck)
5. Review logs for retry patterns (excessive retries indicate backend issues)

---

## Roadmap & Known Gaps

### ✅ Recently Completed (Production Hardening)

All 14 production hardening features have been implemented and tested with 100% pass rate:
- ✅ Exponential backoff with jitter retry logic
- ✅ Circuit breaker pattern for external services
- ✅ Load shedding with resource monitoring
- ✅ Graceful shutdown for zero-downtime deployments
- ✅ HTTP connection pooling
- ✅ Comprehensive metrics collection (Prometheus format)
- ✅ Health check endpoints (Kubernetes-ready)
- ✅ Structured request logging with correlation IDs
- ✅ Consistent error handling with 8 error types
- ✅ Input validation (zero-dependency, JSON schema-like)
- ✅ Token budget enforcement
- ✅ Path allowlisting and sandboxing
- ✅ Rate limiting capabilities
- ✅ Safe command DSL

Performance verified: 7.1μs overhead, 140K req/sec throughput. See [PERFORMANCE-REPORT.md](PERFORMANCE-REPORT.md) for details.

### 🔮 Future Enhancements

- **Per-file diff comments & conversation threading** – Planned to mirror Claude's review UX.
- **Automated risk assessment tied to diffs** – Future enhancement leveraging test outcomes and static analysis.
- **Expanded language-server fidelity** – Currently Tree-sitter-based; deeper AST integration or LSP bridging is a future goal.
- **Claude Skills parity** – Skills are not reproduced; designing a safe, declarative skill layer is an open area.
- **Coverage dashboards & historical trends** – Test summary tracks latest runs but no long-term history yet.
- **Response caching** – Redis-backed response cache for frequently repeated requests (Option 3, Feature 13).

---

## FAQ

**Q: Is this an exact drop-in replacement for Anthropic’s backend?**  
A: No. It mimics key Claude Code CLI behaviors but is intentionally extensible; certain premium features (Claude Skills, hosted sandboxes) are out of scope.

**Q: How does the proxy compare with Anthropic’s hosted backend?**  
A: Functionally they overlap on core workflows (chat, tool calls, repo ops), but differ in scope:

| Capability | Anthropic Hosted Backend | Claude Code Proxy |
|------------|-------------------------|-------------------|
| Claude models | Anthropic-operated Sonnet/Opus | Adapters for Databricks (default), Azure Anthropic, and Ollama (local models) |
| Prompt cache | Managed, opaque | Local LRU cache with configurable TTL/size |
| Git & workspace tools | Anthropic-managed hooks | Local Node handlers (`src/tools/`) with policy gate |
| Web search/fetch | Hosted browsing agent, JS-capable | Local HTTP fetch (no JS) plus optional policy fallback |
| MCP orchestration | Anthropic-managed sandbox | Local MCP discovery, optional Docker sandbox |
| Secure sandboxes | Anthropic-provided remote sandboxes | Optional Docker runtime; full access if disabled |
| Claude Skills / workflows | Available in hosted product | Not implemented (future roadmap) |
| Support & SLAs | Anthropic-run service | Self-hosted; you own uptime, auth, logging |
| Cost & scaling | Usage-billed API | Whatever infra you deploy (Node + dependencies) |

The proxy is ideal when you need local control, custom tooling, or non-Anthropic model endpoints. If you require fully managed browsing, secure sandboxes, or enterprise SLA, stick with the hosted backend.

**Q: Does prompt caching work like Anthropic’s cache?**  
A: Functionally similar. Identical messages (model, messages, tools, sampling params) reuse cached responses until TTL expires. Tool-invoking turns skip caching.

**Q: Can I connect multiple MCP servers?**  
A: Yes. Place multiple manifests in `MCP_MANIFEST_DIRS`. Each server is launched and its tools are namespaced.

**Q: How do I change the workspace root?**
A: Set `WORKSPACE_ROOT` before starting the proxy. The indexer and filesystem tools operate relative to that path.

**Q: Can I use Ollama models with Lynkr?**
A: Yes! Set `MODEL_PROVIDER=ollama` and ensure Ollama is running locally (`ollama serve`). Lynkr supports any Ollama model (qwen2.5-coder, llama3, mistral, etc.). Note that Ollama models don't support native tool calling, so tool definitions are filtered out. Best for text generation and simple workflows.

**Q: Which Ollama model should I use?**
A: For code generation, use `qwen2.5-coder:latest` (7B, optimized for code). For general conversations, `llama3:latest` (8B) or `mistral:latest` (7B) work well. Larger models (13B+) provide better quality but require more RAM and are slower.

**Q: What are the performance differences between providers?**
A: **Databricks/Azure Anthropic**: ~500ms-2s latency, cloud-hosted, pay-per-token, supports tools. **Ollama**: ~100-500ms first token, runs locally, free, no tool support. Choose Databricks/Azure for production workflows with tools; choose Ollama for fast iteration, offline development, or cost optimization.

**Q: Where are session transcripts stored?**
A: In SQLite at `data/sessions.db` (configurable via `SESSION_DB_PATH`).

**Q: What production hardening features are included?**
A: Lynkr includes 14 production-ready features:
- **Reliability:** Retry logic with exponential backoff, circuit breakers, load shedding, graceful shutdown, connection pooling
- **Observability:** Metrics collection (Prometheus format), health checks (Kubernetes-ready), structured logging with request IDs
- **Security:** Input validation, consistent error handling, path allowlisting, budget enforcement

All features add minimal overhead (~7μs per request) and are battle-tested with 80 comprehensive tests.

**Q: How does circuit breaker protection work?**
A: Circuit breakers protect against cascading failures. After 5 consecutive failures, the circuit "opens" and fails fast for 60 seconds. This prevents overwhelming failing services. The circuit automatically attempts recovery, transitioning to "half-open" to test if the service has recovered.

**Q: What metrics are collected and how can I access them?**
A: Lynkr collects request counts, error rates, latency percentiles (p50, p95, p99), token usage, costs, and circuit breaker states. Access via:
- `/metrics/observability` - JSON format for dashboards
- `/metrics/prometheus` - Prometheus scraping
- `/metrics/circuit-breakers` - Circuit breaker state

**Q: Is Lynkr production-ready?**
A: Yes.  Excellent performance (140K req/sec), and comprehensive observability, Lynkr is designed for production deployments. It supports:
- Zero-downtime deployments (graceful shutdown)
- Kubernetes integration (health checks, metrics)
- Horizontal scaling (stateless design)
- Enterprise monitoring (Prometheus, Grafana)

**Q: What's the performance impact of production features?**
A: Minimal. Comprehensive benchmarking shows:
- Total middleware overhead: 7.1 microseconds per request
- Throughput: 140,000 requests/second
- Memory overhead: ~4MB for typical workload

This is considered "EXCELLENT" performance - the overhead is negligible compared to network and API latency.

**Q: How do I deploy Lynkr to Kubernetes?**
A: Use the included Kubernetes configurations and Docker support. Key steps:
1. Build Docker image: `docker build -t lynkr .`
2. Configure environment variables in Kubernetes secrets
3. Deploy with health checks (see examples in [PERFORMANCE-REPORT.md](PERFORMANCE-REPORT.md))
4. Configure Prometheus scraping for metrics
5. Set up Grafana dashboards for visualization

The graceful shutdown and health check endpoints ensure zero-downtime deployments.

---

## License

MIT License. See [LICENSE](LICENSE) for details.

---

If you find Lynkr useful, please ⭐ the repo — it helps more people discover it.
