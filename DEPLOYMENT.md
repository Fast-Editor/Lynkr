# Lynkr Deployment Guide

This guide covers production deployment options for Lynkr, including Docker, Kubernetes, systemd, and cloud platforms.

## Table of Contents

- [Quick Start](#quick-start)
- [Docker Deployment](#docker-deployment)
- [Kubernetes Deployment](#kubernetes-deployment)
- [Systemd Service](#systemd-service)
- [Production Considerations](#production-considerations)
- [Monitoring & Observability](#monitoring--observability)
- [Security Hardening](#security-hardening)
- [Scaling Strategies](#scaling-strategies)

---

## Quick Start

The fastest way to deploy Lynkr in production:

```bash
# 1. Clone and configure
git clone https://github.com/Fast-Editor/Lynkr.git
cd Lynkr
cp .env.example .env
# Edit .env with your credentials

# 2. Deploy with Docker Compose (recommended for most users)
docker compose up -d

# 3. Verify health
curl http://localhost:8080/health
```

---

## Docker Deployment

### Docker Compose (Recommended)

The included `docker-compose.yml` provides a complete setup with Ollama integration.

#### 1. Basic Setup

```bash
# Copy and configure environment
cp .env.example .env
nano .env  # Configure your providers

# Start services
docker compose up -d

# View logs
docker compose logs -f lynkr

# Stop services
docker compose down
```

#### 2. Environment Configuration

Key variables to configure in `.env`:

```bash
# Primary provider
MODEL_PROVIDER=ollama                # Options: ollama, databricks, azure-anthropic, openrouter

# Ollama configuration
OLLAMA_MODEL=qwen2.5-coder:latest
OLLAMA_MAX_TOOLS_FOR_ROUTING=3

# OpenRouter (optional)
OPENROUTER_API_KEY=your-key-here
OPENROUTER_MODEL=amazon/nova-2-lite-v1:free

# Databricks (fallback)
DATABRICKS_API_BASE=https://your-workspace.cloud.databricks.com
DATABRICKS_API_KEY=your-pat-token

# Fallback settings
FALLBACK_ENABLED=true
FALLBACK_PROVIDER=databricks
```

#### 3. Production Docker Compose

For production, update `docker-compose.yml`:

```yaml
services:
  lynkr:
    image: ghcr.io/fast-editor/lynkr:latest
    container_name: lynkr-prod
    restart: always
    ports:
      - "8080:8080"
    environment:
      LOG_LEVEL: info              # Use info for production
      NODE_ENV: production
    volumes:
      - lynkr-data:/app/data       # Named volume for persistence
      - /path/to/workspace:/workspace
    deploy:
      resources:
        limits:
          cpus: '2'
          memory: 4G
        reservations:
          cpus: '1'
          memory: 2G
    healthcheck:
      test: ["CMD", "wget", "--quiet", "--tries=1", "--spider", "http://localhost:8080/health"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 40s

volumes:
  lynkr-data:
    driver: local
```

### Standalone Docker

#### Build Image

```bash
docker build -t lynkr:latest .
```

#### Run Container

```bash
docker run -d \
  --name lynkr \
  --restart unless-stopped \
  -p 8080:8080 \
  -v $(pwd)/data:/app/data \
  -v $(pwd):/workspace \
  --env-file .env \
  lynkr:latest
```

#### With Specific Provider

```bash
docker run -d \
  --name lynkr-databricks \
  -p 8080:8080 \
  -v $(pwd)/data:/app/data \
  -e MODEL_PROVIDER=databricks \
  -e DATABRICKS_API_BASE=https://your-workspace.cloud.databricks.com \
  -e DATABRICKS_API_KEY=your-pat-token \
  -e WORKSPACE_ROOT=/workspace \
  -e PORT=8080 \
  -e LOG_LEVEL=info \
  lynkr:latest
```

---

## Kubernetes Deployment

### Prerequisites

- Kubernetes cluster (1.19+)
- `kubectl` configured
- Secrets management (external-secrets, sealed-secrets, or Vault)

### 1. Create Namespace

```yaml
# namespace.yaml
apiVersion: v1
kind: Namespace
metadata:
  name: lynkr
  labels:
    name: lynkr
```

```bash
kubectl apply -f namespace.yaml
```

### 2. Create Secrets

```bash
# Create secret from .env file
kubectl create secret generic lynkr-secrets \
  --from-env-file=.env \
  --namespace=lynkr

# Or create manually
kubectl create secret generic lynkr-secrets \
  --from-literal=DATABRICKS_API_KEY=your-key \
  --from-literal=DATABRICKS_API_BASE=https://your-workspace.cloud.databricks.com \
  --from-literal=OPENROUTER_API_KEY=your-key \
  --namespace=lynkr
```

### 3. ConfigMap for Non-Sensitive Configuration

```yaml
# configmap.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: lynkr-config
  namespace: lynkr
data:
  MODEL_PROVIDER: "openrouter"
  LOG_LEVEL: "info"
  PORT: "8080"
  OLLAMA_MODEL: "qwen2.5-coder:latest"
  OLLAMA_MAX_TOOLS_FOR_ROUTING: "3"
  OPENROUTER_MAX_TOOLS_FOR_ROUTING: "15"
  FALLBACK_ENABLED: "true"
  FALLBACK_PROVIDER: "databricks"
```

### 4. Deployment Manifest

```yaml
# deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: lynkr
  namespace: lynkr
  labels:
    app: lynkr
spec:
  replicas: 3
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxSurge: 1
      maxUnavailable: 0
  selector:
    matchLabels:
      app: lynkr
  template:
    metadata:
      labels:
        app: lynkr
      annotations:
        prometheus.io/scrape: "true"
        prometheus.io/port: "8080"
        prometheus.io/path: "/metrics/prometheus"
    spec:
      containers:
      - name: lynkr
        image: ghcr.io/fast-editor/lynkr:latest
        imagePullPolicy: Always
        ports:
        - containerPort: 8080
          name: http
          protocol: TCP
        env:
        # Load from ConfigMap
        - name: MODEL_PROVIDER
          valueFrom:
            configMapKeyRef:
              name: lynkr-config
              key: MODEL_PROVIDER
        - name: LOG_LEVEL
          valueFrom:
            configMapKeyRef:
              name: lynkr-config
              key: LOG_LEVEL
        - name: FALLBACK_ENABLED
          valueFrom:
            configMapKeyRef:
              name: lynkr-config
              key: FALLBACK_ENABLED
        # Load from Secrets
        - name: DATABRICKS_API_KEY
          valueFrom:
            secretKeyRef:
              name: lynkr-secrets
              key: DATABRICKS_API_KEY
        - name: DATABRICKS_API_BASE
          valueFrom:
            secretKeyRef:
              name: lynkr-secrets
              key: DATABRICKS_API_BASE
        - name: OPENROUTER_API_KEY
          valueFrom:
            secretKeyRef:
              name: lynkr-secrets
              key: OPENROUTER_API_KEY
              optional: true
        resources:
          requests:
            cpu: 500m
            memory: 1Gi
          limits:
            cpu: 2000m
            memory: 4Gi
        livenessProbe:
          httpGet:
            path: /health/live
            port: 8080
          initialDelaySeconds: 30
          periodSeconds: 10
          timeoutSeconds: 5
          failureThreshold: 3
        readinessProbe:
          httpGet:
            path: /health/ready
            port: 8080
          initialDelaySeconds: 10
          periodSeconds: 5
          timeoutSeconds: 3
          failureThreshold: 3
        volumeMounts:
        - name: data
          mountPath: /app/data
      volumes:
      - name: data
        persistentVolumeClaim:
          claimName: lynkr-pvc
```

### 5. Persistent Volume Claim

```yaml
# pvc.yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: lynkr-pvc
  namespace: lynkr
spec:
  accessModes:
    - ReadWriteOnce
  resources:
    requests:
      storage: 10Gi
  storageClassName: standard  # Adjust based on your cluster
```

### 6. Service

```yaml
# service.yaml
apiVersion: v1
kind: Service
metadata:
  name: lynkr
  namespace: lynkr
  labels:
    app: lynkr
spec:
  type: ClusterIP
  ports:
  - port: 8080
    targetPort: 8080
    protocol: TCP
    name: http
  selector:
    app: lynkr
```

### 7. Ingress (Optional)

```yaml
# ingress.yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: lynkr
  namespace: lynkr
  annotations:
    cert-manager.io/cluster-issuer: letsencrypt-prod
    nginx.ingress.kubernetes.io/ssl-redirect: "true"
spec:
  ingressClassName: nginx
  tls:
  - hosts:
    - lynkr.yourdomain.com
    secretName: lynkr-tls
  rules:
  - host: lynkr.yourdomain.com
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: lynkr
            port:
              number: 8080
```

### 8. Deploy to Kubernetes

```bash
# Apply all manifests
kubectl apply -f namespace.yaml
kubectl apply -f configmap.yaml
kubectl apply -f pvc.yaml
kubectl apply -f deployment.yaml
kubectl apply -f service.yaml
kubectl apply -f ingress.yaml  # Optional

# Verify deployment
kubectl get pods -n lynkr
kubectl logs -f deployment/lynkr -n lynkr

# Check service
kubectl get svc -n lynkr

# Test health endpoint
kubectl port-forward svc/lynkr 8080:8080 -n lynkr
curl http://localhost:8080/health
```

### 9. Horizontal Pod Autoscaling

```yaml
# hpa.yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: lynkr-hpa
  namespace: lynkr
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: lynkr
  minReplicas: 2
  maxReplicas: 10
  metrics:
  - type: Resource
    resource:
      name: cpu
      target:
        type: Utilization
        averageUtilization: 70
  - type: Resource
    resource:
      name: memory
      target:
        type: Utilization
        averageUtilization: 80
  behavior:
    scaleDown:
      stabilizationWindowSeconds: 300
      policies:
      - type: Percent
        value: 50
        periodSeconds: 60
    scaleUp:
      stabilizationWindowSeconds: 0
      policies:
      - type: Percent
        value: 100
        periodSeconds: 30
```

---

## Systemd Service

For deployment on Linux VMs without container orchestration.

### 1. Installation

```bash
# Clone repository
cd /opt
sudo git clone https://github.com/Fast-Editor/Lynkr.git
cd Lynkr

# Install dependencies
npm ci --omit=dev

# Configure
sudo cp .env.example .env
sudo nano .env
```

### 2. Create Systemd Service

```bash
sudo nano /etc/systemd/system/lynkr.service
```

```ini
[Unit]
Description=Lynkr - Claude Code Proxy
After=network.target
Wants=network-online.target

[Service]
Type=simple
User=lynkr
Group=lynkr
WorkingDirectory=/opt/Lynkr
EnvironmentFile=/opt/Lynkr/.env
ExecStart=/usr/bin/node /opt/Lynkr/index.js
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal
SyslogIdentifier=lynkr

# Security hardening
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/opt/Lynkr/data
CapabilityBoundingSet=CAP_NET_BIND_SERVICE

# Resource limits
LimitNOFILE=65536
MemoryLimit=4G
CPUQuota=200%

[Install]
WantedBy=multi-user.target
```

### 3. Create User and Set Permissions

```bash
# Create dedicated user
sudo useradd -r -s /bin/false lynkr

# Set ownership
sudo chown -R lynkr:lynkr /opt/Lynkr

# Create data directory
sudo mkdir -p /opt/Lynkr/data
sudo chown lynkr:lynkr /opt/Lynkr/data
```

### 4. Enable and Start Service

```bash
# Reload systemd
sudo systemctl daemon-reload

# Enable on boot
sudo systemctl enable lynkr

# Start service
sudo systemctl start lynkr

# Check status
sudo systemctl status lynkr

# View logs
sudo journalctl -u lynkr -f
```

### 5. Log Rotation

```bash
sudo nano /etc/logrotate.d/lynkr
```

```
/var/log/lynkr/*.log {
    daily
    missingok
    rotate 14
    compress
    delaycompress
    notifempty
    create 0640 lynkr lynkr
    sharedscripts
    postrotate
        systemctl reload lynkr > /dev/null 2>&1 || true
    endscript
}
```

---


## Production Considerations

### 1. High Availability

- **Multiple replicas**: Run at least 3 instances for redundancy
- **Load balancing**: Use cloud load balancers or nginx
- **Health checks**: Configure liveness and readiness probes
- **Circuit breakers**: Built-in protection against cascading failures

### 2. Data Persistence

```yaml
# For Kubernetes - use StatefulSet for sticky sessions
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: lynkr
spec:
  serviceName: "lynkr"
  replicas: 3
  volumeClaimTemplates:
  - metadata:
      name: data
    spec:
      accessModes: ["ReadWriteOnce"]
      resources:
        requests:
          storage: 10Gi
```

### 3. Database Backup

```bash
# Backup SQLite databases
*/30 * * * * /usr/local/bin/backup-lynkr.sh

# backup-lynkr.sh
#!/bin/bash
BACKUP_DIR=/backups/lynkr/$(date +%Y%m%d)
mkdir -p $BACKUP_DIR
cp /app/data/*.db $BACKUP_DIR/
aws s3 sync $BACKUP_DIR s3://lynkr-backups/$(date +%Y%m%d)/
```

### 4. TLS/SSL

```yaml
# Ingress with cert-manager
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: lynkr
  annotations:
    cert-manager.io/cluster-issuer: letsencrypt-prod
    nginx.ingress.kubernetes.io/force-ssl-redirect: "true"
spec:
  tls:
  - hosts:
    - lynkr.example.com
    secretName: lynkr-tls
```

### 5. Rate Limiting

Lynkr includes built-in rate limiting. Configure via environment:

```bash
RATE_LIMIT_ENABLED=true
RATE_LIMIT_MAX=100          # requests per window
RATE_LIMIT_WINDOW_MS=60000  # 1 minute
```

---

## Monitoring & Observability

### Prometheus Integration

```yaml
# ServiceMonitor for Prometheus Operator
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: lynkr
  namespace: lynkr
spec:
  selector:
    matchLabels:
      app: lynkr
  endpoints:
  - port: http
    path: /metrics/prometheus
    interval: 30s
```

### Grafana Dashboard

Import the included Grafana dashboard:

```bash
# dashboards/grafana-lynkr.json
kubectl create configmap lynkr-dashboard \
  --from-file=dashboards/grafana-lynkr.json \
  -n monitoring
```

### CloudWatch (AWS)

```bash
# Install CloudWatch agent
aws logs create-log-group --log-group-name /lynkr/application

# Configure in task definition
"logConfiguration": {
  "logDriver": "awslogs",
  "options": {
    "awslogs-group": "/lynkr/application",
    "awslogs-region": "us-east-1",
    "awslogs-stream-prefix": "lynkr"
  }
}
```

### Key Metrics to Monitor

- **Request rate**: `/metrics/prometheus` - `http_requests_total`
- **Latency**: `http_request_duration_seconds` (p50, p95, p99)
- **Error rate**: `http_requests_failed_total`
- **Circuit breaker state**: `/metrics/circuit-breakers`
- **Load shedding**: `load_shedding_requests_rejected_total`
- **Token usage**: `tokens_used_total{type="input|output"}`
- **Provider routing**: `provider_requests_total{provider="ollama|databricks|openrouter"}`

---

## Security Hardening

### 1. Secrets Management

**Never commit secrets to git**

Use environment variables or secrets management:

```bash
# Kubernetes Secrets (with external-secrets)
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: lynkr-secrets
spec:
  secretStoreRef:
    name: aws-secretsmanager
    kind: SecretStore
  target:
    name: lynkr-secrets
  data:
  - secretKey: DATABRICKS_API_KEY
    remoteRef:
      key: lynkr/databricks
      property: api_key
```

### 2. Network Policies

```yaml
# network-policy.yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: lynkr-network-policy
  namespace: lynkr
spec:
  podSelector:
    matchLabels:
      app: lynkr
  policyTypes:
  - Ingress
  - Egress
  ingress:
  - from:
    - namespaceSelector:
        matchLabels:
          name: ingress-nginx
    ports:
    - protocol: TCP
      port: 8080
  egress:
  - to:
    - namespaceSelector: {}
    ports:
    - protocol: TCP
      port: 443  # HTTPS to external APIs
```

### 3. Pod Security Standards

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: lynkr
spec:
  securityContext:
    runAsNonRoot: true
    runAsUser: 1000
    fsGroup: 1000
    seccompProfile:
      type: RuntimeDefault
  containers:
  - name: lynkr
    securityContext:
      allowPrivilegeEscalation: false
      readOnlyRootFilesystem: true
      capabilities:
        drop:
        - ALL
```

### 4. API Authentication

Add authentication middleware:

```javascript
// Add to src/server.js
const authenticateRequest = (req, res, next) => {
  const apiKey = req.headers['x-api-key'];
  if (apiKey !== process.env.API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
};

app.use('/v1/messages', authenticateRequest);
```

---

## Scaling Strategies

### Horizontal Scaling

**Kubernetes HPA** (see above) - auto-scale based on:
- CPU utilization
- Memory utilization
- Custom metrics (request rate, queue depth)

### Vertical Scaling

Adjust resource limits based on load:

```yaml
resources:
  requests:
    cpu: 1000m      # Start with 1 CPU
    memory: 2Gi
  limits:
    cpu: 4000m      # Allow burst to 4 CPUs
    memory: 8Gi
```

### Load Shedding

Built-in load shedding activates automatically:

```bash
# Configure thresholds
LOAD_SHEDDING_ENABLED=true
LOAD_SHEDDING_HEAP_THRESHOLD=0.90  # Reject when >90% heap used
LOAD_SHEDDING_CPU_THRESHOLD=0.85   # Reject when >85% CPU
```

### Caching Strategy

```bash
# Prompt caching configuration
PROMPT_CACHE_ENABLED=true
PROMPT_CACHE_MAX_SIZE=1000    # Max entries
PROMPT_CACHE_TTL_MS=3600000   # 1 hour
```

### Multi-Region Deployment

Deploy to multiple regions with DNS-based load balancing:

```yaml
# Route53 configuration (AWS)
Type: A
Name: lynkr.example.com
Value:
  - us-east-1-alb.example.com
  - eu-west-1-alb.example.com
Routing Policy: Latency-based
Health Check: Enabled
```

---

## Troubleshooting

### Common Issues

#### 1. Container Won't Start

```bash
# Check logs
docker logs lynkr
kubectl logs -f deployment/lynkr -n lynkr

# Common causes:
# - Missing required environment variables
# - Invalid credentials
# - Port already in use
```

#### 2. Health Checks Failing

```bash
# Test health endpoints
curl http://localhost:8080/health/live
curl http://localhost:8080/health/ready

# Check readiness conditions
kubectl describe pod -n lynkr
```

#### 3. High Memory Usage

```bash
# Monitor memory
kubectl top pod -n lynkr

# Adjust heap size
NODE_OPTIONS="--max-old-space-size=4096"  # 4GB heap
```

#### 4. Circuit Breaker Open

```bash
# Check circuit breaker state
curl http://localhost:8080/metrics/circuit-breakers

# Reset manually (if needed)
# Circuit breakers auto-recover after cooldown period
```

### Debug Mode

```bash
# Enable debug logging
LOG_LEVEL=debug

# View detailed logs
kubectl logs -f deployment/lynkr -n lynkr --tail=100
```

---

## Maintenance

### Rolling Updates

```bash
# Kubernetes
kubectl set image deployment/lynkr lynkr=ghcr.io/fast-editor/lynkr:v2.0.0 -n lynkr
kubectl rollout status deployment/lynkr -n lynkr

# Rollback if needed
kubectl rollout undo deployment/lynkr -n lynkr
```

### Backup & Restore

```bash
# Backup
kubectl exec -n lynkr deployment/lynkr -- tar -czf /tmp/backup.tar.gz /app/data
kubectl cp lynkr/lynkr-pod:/tmp/backup.tar.gz ./backup.tar.gz

# Restore
kubectl cp ./backup.tar.gz lynkr/lynkr-pod:/tmp/backup.tar.gz
kubectl exec -n lynkr deployment/lynkr -- tar -xzf /tmp/backup.tar.gz -C /
```

### Database Optimization

```bash
# SQLite vacuum (compress and optimize)
sqlite3 /app/data/sessions.db 'VACUUM;'
sqlite3 /app/data/sessions.db 'ANALYZE;'
```

---

## Support

For deployment issues:

1. Check the [GitHub Issues](https://github.com/Fast-Editor/Lynkr/issues)
2. Review [README.md](README.md) for configuration details
3. Join the community discussions
4. Contact support for enterprise deployments

---

## License

MIT License - see [LICENSE](LICENSE) for details.
