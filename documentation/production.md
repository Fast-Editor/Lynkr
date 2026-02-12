# Production Hardening Guide

Complete guide to deploying Lynkr in production with 14 hardening features for reliability, observability, and security.

---

## Overview

Lynkr includes 14 production-ready features:
- **Reliability:** Circuit breakers, retries, load shedding, graceful shutdown
- **Observability:** Prometheus metrics, structured logging, health checks
- **Security:** Input validation, policy enforcement, sandboxing
- **Performance:** Minimal overhead (~7μs), 140K req/sec throughput

---

## Reliability Features

### 1. Circuit Breaker Pattern

Protects against cascading failures to external services.

**States:**
- `CLOSED` - Normal operation
- `OPEN` - Failing fast (provider down)
- `HALF_OPEN` - Testing recovery

**Configuration:**
```bash
# Failures before opening circuit
CIRCUIT_BREAKER_FAILURE_THRESHOLD=5  # default: 5

# Successes needed to close from half-open
CIRCUIT_BREAKER_SUCCESS_THRESHOLD=2  # default: 2

# Time before attempting recovery (ms)
CIRCUIT_BREAKER_TIMEOUT=60000  # default: 60000 (1 min)
```

**How it works:**
1. 5 failures → Circuit OPEN
2. Wait 60 seconds
3. Try 1 request → Circuit HALF_OPEN
4. 2 successes → Circuit CLOSED

### 2. Exponential Backoff with Jitter

Automatic retries for transient failures.

**Configuration:**
```bash
# Max retry attempts
API_RETRY_MAX_RETRIES=3  # default: 3

# Initial retry delay (ms)
API_RETRY_INITIAL_DELAY=1000  # default: 1000

# Maximum retry delay (ms)
API_RETRY_MAX_DELAY=30000  # default: 30000
```

**Retry schedule:**
- Attempt 1: Immediate
- Attempt 2: 1s + jitter (±500ms)
- Attempt 3: 2s + jitter (±1s)
- Attempt 4: 4s + jitter (±2s)

**Retryable errors:**
- 5xx status codes
- Network timeouts
- Connection errors

**Non-retryable errors:**
- 4xx status codes
- Authentication errors
- Validation errors

### 3. Load Shedding

Proactive request rejection when system is overloaded.

**Configuration:**
```bash
# Memory usage threshold (0-1)
LOAD_SHEDDING_MEMORY_THRESHOLD=0.85  # default: 0.85 (85%)

# Heap usage threshold (0-1)
LOAD_SHEDDING_HEAP_THRESHOLD=0.90  # default: 0.90 (90%)

# Max concurrent requests
LOAD_SHEDDING_ACTIVE_REQUESTS_THRESHOLD=1000  # default: 1000
```

**Behavior:**
- Returns HTTP 503 during overload
- Includes `Retry-After` header
- Cached state (1s) for performance

**Monitoring:**
```bash
curl http://localhost:8081/metrics | grep lynkr_load_shedding
```

### 4. Graceful Shutdown

Zero-downtime deployments.

**Configuration:**
```bash
# Shutdown timeout (ms)
GRACEFUL_SHUTDOWN_TIMEOUT=30000  # default: 30000 (30s)
```

**Sequence:**
1. Receive SIGTERM/SIGINT
2. Stop accepting new requests
3. Complete in-flight requests (max 30s)
4. Close database connections
5. Exit

**Kubernetes:**
```yaml
spec:
  containers:
  - name: lynkr
    lifecycle:
      preStop:
        exec:
          command: ["/bin/sh", "-c", "sleep 5"]
    terminationGracePeriodSeconds: 35
```

---

## Observability

### 5. Prometheus Metrics

Comprehensive metrics collection.

**Endpoint:**
```bash
curl http://localhost:8081/metrics
```

**Request Metrics:**
```
# Request rate
lynkr_requests_total{provider="databricks",status="200"} 1234

# Latency histogram
lynkr_request_duration_seconds_bucket{provider="databricks",le="0.5"} 980
lynkr_request_duration_seconds_bucket{provider="databricks",le="1"} 1200
lynkr_request_duration_seconds_sum 1234.5
lynkr_request_duration_seconds_count 1234

# Error rate
lynkr_errors_total{provider="databricks",type="timeout"} 12
```

**Token Metrics:**
```
# Token usage
lynkr_tokens_input_total{provider="databricks"} 5000000
lynkr_tokens_output_total{provider="databricks"} 500000
lynkr_tokens_cached_total 2000000

# Cache hits
lynkr_cache_hits_total 850
lynkr_cache_misses_total 150
```

**System Metrics:**
```
# Memory usage
process_resident_memory_bytes 104857600
nodejs_heap_size_used_bytes 52428800

# Circuit breaker state
lynkr_circuit_breaker_state{provider="databricks",state="closed"} 1

# Active requests
lynkr_active_requests 42
```

**Configuration:**
```bash
METRICS_ENABLED=true  # default: true
```

### 6. Structured Logging

JSON logs with request ID correlation via [Pino](https://github.com/pinojs/pino).

**Log Level Philosophy:**
- **`info`** — Meaningful milestones: request received (minimal), request completed (duration + tokens), errors, retries, fallbacks
- **`debug`** — Operational details: request body previews, tool injection, streaming chunks, intermediate conversions, tool mapping

**Console Configuration:**
```bash
LOG_LEVEL=info                  # options: error, warn, info, debug (default: info)
REQUEST_LOGGING_ENABLED=true    # default: true
```

In development mode (`NODE_ENV=development`), logs are pretty-printed via `pino-pretty`.

**File Logging (optional):**

Persistent log files with automatic daily rotation via [pino-roll](https://github.com/pinojs/pino-roll). Enable by setting `LOG_FILE_ENABLED=true`.

```bash
LOG_FILE_ENABLED=true           # default: false
LOG_FILE_PATH=./logs/lynkr.log  # default: <cwd>/logs/lynkr.log
LOG_FILE_LEVEL=debug            # default: debug (captures all levels)
LOG_FILE_FREQUENCY=daily        # options: daily, hourly, custom (default: daily)
LOG_FILE_MAX_FILES=14           # rotated files to keep (default: 14)
```

Rotated files are named with timestamps (e.g., `lynkr.log.2025-07-12`). The log directory is created automatically.

**Log format (JSON):**
```json
{
  "level": "info",
  "time": 1705123456789,
  "msg": "Request processed",
  "requestId": "req_abc123",
  "provider": "databricks",
  "statusCode": 200,
  "duration": 1250,
  "tokens": {
    "input": 1250,
    "output": 234,
    "cached": 750
  }
}
```

**Querying log files:**
```bash
# Tail live logs
tail -f ./logs/lynkr.log | npx pino-pretty

# Find errors in the last 24 hours
cat ./logs/lynkr.log | jq 'select(.level >= 50)'

# Filter by provider
cat ./logs/lynkr.log | jq 'select(.provider == "databricks")'

# Search for slow requests (>2s)
cat ./logs/lynkr.log | jq 'select(.duration > 2000)'
```

**Log aggregation:**
- **Stdout** — Captured by Docker/K8s log drivers
- **File rotation** — For standalone deployments or local debugging
- **External** — Forward JSON logs to Elasticsearch, Splunk, Grafana Loki, etc.

### 7. Health Checks

Kubernetes-ready health endpoints.

**Liveness Probe:**
```bash
curl http://localhost:8081/health/live

# Returns:
{
  "status": "ok",
  "provider": "databricks",
  "timestamp": "2026-01-12T00:00:00.000Z"
}
```

**Readiness Probe:**
```bash
curl http://localhost:8081/health/ready

# Returns:
{
  "status": "ready",
  "checks": {
    "database": "ok",
    "provider": "ok"
  }
}
```

**Deep Health Check:**
```bash
curl "http://localhost:8081/health/ready?deep=true"

# Returns:
{
  "status": "ready",
  "checks": {
    "database": "ok",
    "provider": "ok",
    "memory": {"used": "50%", "status": "ok"},
    "circuit_breaker": {"state": "closed", "status": "ok"}
  }
}
```

**Kubernetes:**
```yaml
livenessProbe:
  httpGet:
    path: /health/live
    port: 8081
  initialDelaySeconds: 10
  periodSeconds: 10

readinessProbe:
  httpGet:
    path: /health/ready
    port: 8081
  initialDelaySeconds: 5
  periodSeconds: 5
```

**Configuration:**
```bash
HEALTH_CHECK_ENABLED=true  # default: true
```

---

## Security

### 8. Input Validation

Zero-dependency schema validation.

**Validates:**
- Request body structure
- Required fields
- Field types
- Value constraints

**Example:**
```javascript
// Invalid request
{
  "model": 123,  // Should be string
  "max_tokens": -1  // Should be positive
}

// Returns 400 Bad Request
{
  "error": "Invalid request",
  "details": [
    "model must be string",
    "max_tokens must be positive"
  ]
}
```

### 9. Policy Enforcement

Environment-driven guardrails.

**Git Policies:**
```bash
# Allow git push (default: disabled)
POLICY_GIT_ALLOW_PUSH=false

# Require tests before commit (default: disabled)
POLICY_GIT_REQUIRE_TESTS=false

# Custom test command
POLICY_GIT_TEST_COMMAND="npm test"
```

**Web Fetch Policies:**
```bash
# Allowed hosts for web_fetch tool
WEB_SEARCH_ALLOWED_HOSTS=github.com,stackoverflow.com

# Web search endpoint
WEB_SEARCH_ENDPOINT=http://localhost:8888/search
```

**Workspace Policies:**
```bash
# Workspace root directory
WORKSPACE_ROOT=/path/to/projects

# Max agent loop iterations
POLICY_MAX_STEPS=8
```

### 10. Sandboxing

Optional Docker isolation for MCP tools.

**Configuration:**
```bash
# Enable MCP sandbox
MCP_SANDBOX_ENABLED=true  # default: true

# Docker image for sandbox
MCP_SANDBOX_IMAGE=ubuntu:22.04
```

**How it works:**
1. MCP tool invoked
2. Launch Docker container
3. Execute tool in container
4. Return result
5. Destroy container

**Benefits:**
- Isolated execution
- Resource limits
- No host access
- Safe for untrusted tools

---

## Deployment

### Kubernetes

**deployment.yaml:**
```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: lynkr
spec:
  replicas: 3
  selector:
    matchLabels:
      app: lynkr
  template:
    metadata:
      labels:
        app: lynkr
    spec:
      containers:
      - name: lynkr
        image: lynkr:latest
        ports:
        - containerPort: 8081
        env:
        - name: MODEL_PROVIDER
          value: "databricks"
        - name: DATABRICKS_API_KEY
          valueFrom:
            secretKeyRef:
              name: lynkr-secrets
              key: databricks-api-key
        resources:
          requests:
            cpu: "500m"
            memory: "512Mi"
          limits:
            cpu: "2"
            memory: "2Gi"
        livenessProbe:
          httpGet:
            path: /health/live
            port: 8081
          initialDelaySeconds: 10
          periodSeconds: 10
        readinessProbe:
          httpGet:
            path: /health/ready
            port: 8081
          initialDelaySeconds: 5
          periodSeconds: 5
---
apiVersion: v1
kind: Service
metadata:
  name: lynkr
spec:
  selector:
    app: lynkr
  ports:
  - port: 80
    targetPort: 8081
  type: LoadBalancer
```

### Docker Compose

See [Docker Deployment Guide](docker.md) for complete setup.

### Systemd

**lynkr.service:**
```ini
[Unit]
Description=Lynkr Proxy
After=network.target

[Service]
Type=simple
User=lynkr
WorkingDirectory=/opt/lynkr
EnvironmentFile=/etc/lynkr/lynkr.env
ExecStart=/usr/bin/node /opt/lynkr/index.js
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable lynkr
sudo systemctl start lynkr
sudo journalctl -u lynkr -f
```

---

## Monitoring

### Prometheus

**prometheus.yml:**
```yaml
scrape_configs:
  - job_name: 'lynkr'
    static_configs:
      - targets: ['localhost:8081']
    metrics_path: '/metrics'
    scrape_interval: 15s
```

### Grafana Dashboard

**Key metrics to monitor:**
- Request rate (req/sec)
- Latency percentiles (p50, p95, p99)
- Error rate
- Token usage
- Cache hit rate
- Circuit breaker state
- Memory usage

**Sample queries:**
```promql
# Request rate
rate(lynkr_requests_total[5m])

# 95th percentile latency
histogram_quantile(0.95, rate(lynkr_request_duration_seconds_bucket[5m]))

# Error rate
rate(lynkr_errors_total[5m]) / rate(lynkr_requests_total[5m])

# Cache hit rate
lynkr_cache_hits_total / (lynkr_cache_hits_total + lynkr_cache_misses_total)
```

---

## Best Practices

### 1. Use Reverse Proxy

```nginx
server {
    listen 443 ssl;
    server_name lynkr.example.com;

    ssl_certificate /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    location / {
        proxy_pass http://localhost:8081;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

### 2. Set Resource Limits

```yaml
resources:
  requests:
    cpu: "500m"
    memory: "512Mi"
  limits:
    cpu: "2"
    memory: "2Gi"
```

### 3. Enable All Hardening Features

```bash
CIRCUIT_BREAKER_FAILURE_THRESHOLD=5
LOAD_SHEDDING_MEMORY_THRESHOLD=0.85
GRACEFUL_SHUTDOWN_TIMEOUT=30000
METRICS_ENABLED=true
HEALTH_CHECK_ENABLED=true
```

### 4. Monitor Metrics

- Set up Prometheus + Grafana
- Alert on high error rates
- Alert on high latency
- Monitor token usage

### 5. Rotate Secrets

```bash
# Rotate API keys regularly
kubectl create secret generic lynkr-secrets \
  --from-literal=databricks-api-key=new-key \
  --dry-run=client -o yaml | kubectl apply -f -

# Rollout restart
kubectl rollout restart deployment/lynkr
```

---

## Next Steps

- **[Docker Deployment](docker.md)** - Docker setup
- **[API Reference](api.md)** - API endpoints
- **[Troubleshooting](troubleshooting.md)** - Common issues

---

## Getting Help

- **[GitHub Discussions](https://github.com/vishalveerareddy123/Lynkr/discussions)** - Ask questions
- **[GitHub Issues](https://github.com/vishalveerareddy123/Lynkr/issues)** - Report issues
