# Docker Deployment Guide

Complete guide to deploying Lynkr with Docker and docker-compose, including GPU support and Kubernetes deployment.

---

## Quick Start

### docker-compose (Recommended)

**1. Clone repository:**
```bash
git clone https://github.com/vishalveerareddy123/Lynkr.git
cd Lynkr
```

**2. Configure environment:**
```bash
cp .env.example .env
# Edit .env with your provider credentials
```

**3. Start services:**
```bash
docker-compose up -d
```

**4. Verify:**
```bash
curl http://localhost:8081/health/live
# Expected: {"status":"ok"}
```

---

## Docker Compose Configuration

### Standard Setup (docker-compose.yml)

```yaml
version: '3.8'

services:
  lynkr:
    build: .
    container_name: lynkr
    ports:
      - "8081:8081"  # Lynkr proxy
    env_file:
      - .env
    volumes:
      - ./data:/app/data              # Persistent data (memories, sessions)
      - ./workspace:/app/workspace    # Workspace for file operations
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:8081/health/live"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 40s
```

### With Ollama (Local LLM)

```yaml
version: '3.8'

services:
  # Lynkr proxy
  lynkr:
    build: .
    container_name: lynkr
    ports:
      - "8081:8081"
    environment:
      # Tier-based routing: local for simple, cloud for complex
      - MODEL_PROVIDER=ollama
      - OLLAMA_API_BASE=http://ollama:11434
      # Set all 4 TIER_* vars to enable tier-based routing
      - TIER_SIMPLE=ollama:llama3.2
      - TIER_MEDIUM=ollama:llama3.2
      - TIER_COMPLEX=databricks:databricks-claude-sonnet-4-5
      - TIER_REASONING=databricks:databricks-claude-sonnet-4-5
      - FALLBACK_ENABLED=true
      - FALLBACK_PROVIDER=databricks
      - DATABRICKS_API_BASE=${DATABRICKS_API_BASE}
      - DATABRICKS_API_KEY=${DATABRICKS_API_KEY}
    volumes:
      - ./data:/app/data
      - ./workspace:/app/workspace
    depends_on:
      - ollama
    restart: unless-stopped

  # Ollama local LLM server
  ollama:
    image: ollama/ollama:latest
    container_name: ollama
    ports:
      - "11434:11434"
    volumes:
      - ollama_data:/root/.ollama
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:11434/api/tags"]
      interval: 30s
      timeout: 10s
      retries: 3

volumes:
  ollama_data:
```

**Pull models:**
```bash
# Enter Ollama container
docker exec -it ollama ollama pull qwen2.5-coder:7b

# Or from host (if Ollama CLI installed)
ollama pull qwen2.5-coder:7b
```

### With GPU Support (NVIDIA)

```yaml
version: '3.8'

services:
  lynkr:
    build: .
    container_name: lynkr
    ports:
      - "8081:8081"
    environment:
      - MODEL_PROVIDER=ollama
      - OLLAMA_API_BASE=http://ollama:11434
    volumes:
      - ./data:/app/data
      - ./workspace:/app/workspace
    depends_on:
      - ollama
    restart: unless-stopped

  ollama:
    image: ollama/ollama:latest
    container_name: ollama
    ports:
      - "11434:11434"
    volumes:
      - ollama_data:/root/.ollama
    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              count: all
              capabilities: [gpu]
    restart: unless-stopped

volumes:
  ollama_data:
```

**Prerequisites:**
1. Install NVIDIA drivers
2. Install NVIDIA Container Toolkit:
```bash
# Ubuntu/Debian
distribution=$(. /etc/os-release;echo $ID$VERSION_ID)
curl -s -L https://nvidia.github.io/nvidia-docker/gpgkey | sudo apt-key add -
curl -s -L https://nvidia.github.io/nvidia-docker/$distribution/nvidia-docker.list | \
  sudo tee /etc/apt/sources.list.d/nvidia-docker.list

sudo apt-get update
sudo apt-get install -y nvidia-container-toolkit
sudo systemctl restart docker
```

**Verify GPU access:**
```bash
docker exec -it ollama nvidia-smi
```

### With Embeddings (for Cursor @Codebase)

```yaml
version: '3.8'

services:
  lynkr:
    build: .
    container_name: lynkr
    ports:
      - "8081:8081"
    environment:
      - MODEL_PROVIDER=databricks
      - DATABRICKS_API_BASE=${DATABRICKS_API_BASE}
      - DATABRICKS_API_KEY=${DATABRICKS_API_KEY}

      # Embeddings via Ollama
      - EMBEDDINGS_PROVIDER=ollama
      - OLLAMA_API_BASE=http://ollama:11434
      - OLLAMA_EMBEDDINGS_MODEL=nomic-embed-text

      # Index workspace for @Codebase
      - WORKSPACE_ROOT=/app/workspace
      - WORKSPACE_INDEX_ENABLED=true
    volumes:
      - ./data:/app/data
      - ./workspace:/app/workspace
    depends_on:
      - ollama
    restart: unless-stopped

  ollama:
    image: ollama/ollama:latest
    container_name: ollama
    ports:
      - "11434:11434"
    volumes:
      - ollama_data:/root/.ollama
    restart: unless-stopped

volumes:
  ollama_data:
```

**Pull embedding model:**
```bash
docker exec -it ollama ollama pull nomic-embed-text
```

---

## Standalone Docker

### Build Image

```bash
# Build from Dockerfile
docker build -t lynkr:latest .

# Or pull from registry (when available)
docker pull ghcr.io/vishalveerareddy123/lynkr:latest
```

### Run Container

**With Databricks:**
```bash
docker run -d \
  --name lynkr \
  -p 8081:8081 \
  -e MODEL_PROVIDER=databricks \
  -e DATABRICKS_API_BASE=https://your-workspace.databricks.com \
  -e DATABRICKS_API_KEY=your-key \
  -v $(pwd)/data:/app/data \
  -v $(pwd)/workspace:/app/workspace \
  --restart unless-stopped \
  lynkr:latest
```

**With Ollama:**
```bash
# Start Ollama first
docker run -d \
  --name ollama \
  -p 11434:11434 \
  -v ollama_data:/root/.ollama \
  ollama/ollama:latest

# Start Lynkr
docker run -d \
  --name lynkr \
  -p 8081:8081 \
  -e MODEL_PROVIDER=ollama \
  -e OLLAMA_API_BASE=http://ollama:11434 \
  -v $(pwd)/data:/app/data \
  -v $(pwd)/workspace:/app/workspace \
  --link ollama \
  --restart unless-stopped \
  lynkr:latest
```

**With AWS Bedrock:**
```bash
docker run -d \
  --name lynkr \
  -p 8081:8081 \
  -e MODEL_PROVIDER=bedrock \
  -e AWS_ACCESS_KEY_ID=AKIA... \
  -e AWS_SECRET_ACCESS_KEY=... \
  -e AWS_BEDROCK_REGION=us-east-1 \
  -v $(pwd)/data:/app/data \
  -v $(pwd)/workspace:/app/workspace \
  --restart unless-stopped \
  lynkr:latest
```

---

## Dockerfile

### Standard Dockerfile

```dockerfile
# Use Node.js 18 Alpine for smaller image
FROM node:18-alpine

# Set working directory
WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm ci --production

# Copy application code
COPY . .

# Create data directories
RUN mkdir -p /app/data /app/workspace

# Expose port
EXPOSE 8081

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD node -e "require('http').get('http://localhost:8081/health/live', (r) => { process.exit(r.statusCode === 200 ? 0 : 1); })"

# Run as non-root user
USER node

# Start application
CMD ["node", "index.js"]
```

### Multi-stage Dockerfile (Smaller Image)

```dockerfile
# Build stage
FROM node:18-alpine AS builder

WORKDIR /app
COPY package*.json ./
RUN npm ci --production

# Runtime stage
FROM node:18-alpine

WORKDIR /app

# Copy dependencies
COPY --from=builder /app/node_modules ./node_modules

# Copy application
COPY . .

# Create directories
RUN mkdir -p /app/data /app/workspace && \
    chown -R node:node /app

# Expose port
EXPOSE 8081

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD node -e "require('http').get('http://localhost:8081/health/live', (r) => { process.exit(r.statusCode === 200 ? 0 : 1); })"

# Run as non-root user
USER node

CMD ["node", "index.js"]
```

---

## Volume Management

### Persistent Data

**Required volumes:**
```yaml
volumes:
  - ./data:/app/data              # SQLite databases (memories, sessions)
  - ./workspace:/app/workspace    # File operations workspace
```

**Data directory structure:**
```
data/
  ├── memories.db           # Long-term memory database
  ├── sessions.db           # Conversation history
  └── workspace-index.db    # Workspace metadata
```

### Backup Data

**Backup script:**
```bash
#!/bin/bash
# backup-lynkr.sh

BACKUP_DIR="./backups/$(date +%Y%m%d_%H%M%S)"
mkdir -p $BACKUP_DIR

# Stop container
docker-compose stop lynkr

# Backup data
cp -r ./data $BACKUP_DIR/
cp -r ./workspace $BACKUP_DIR/

# Restart container
docker-compose start lynkr

echo "Backup saved to: $BACKUP_DIR"
```

### Restore Data

```bash
#!/bin/bash
# restore-lynkr.sh

BACKUP_DIR=$1

if [ -z "$BACKUP_DIR" ]; then
  echo "Usage: ./restore-lynkr.sh <backup_directory>"
  exit 1
fi

# Stop container
docker-compose stop lynkr

# Restore data
rm -rf ./data ./workspace
cp -r $BACKUP_DIR/data ./
cp -r $BACKUP_DIR/workspace ./

# Restart container
docker-compose start lynkr

echo "Restored from: $BACKUP_DIR"
```

---

## Environment Variables

### Core Configuration

```yaml
environment:
  # Provider
  - MODEL_PROVIDER=databricks
  - DATABRICKS_API_BASE=https://your-workspace.databricks.com
  - DATABRICKS_API_KEY=${DATABRICKS_API_KEY}

  # Tier-based routing (set all 4 to enable)
  - TIER_SIMPLE=ollama:llama3.2
  - TIER_MEDIUM=openrouter:openai/gpt-4o-mini
  - TIER_COMPLEX=databricks:databricks-claude-sonnet-4-5
  - TIER_REASONING=databricks:databricks-claude-sonnet-4-5
  - FALLBACK_ENABLED=true
  - FALLBACK_PROVIDER=databricks

  # Port
  - PORT=8081

  # Logging
  - LOG_LEVEL=info

  # Memory
  - MEMORY_ENABLED=true
  - MEMORY_RETRIEVAL_LIMIT=5

  # Caching
  - PROMPT_CACHE_ENABLED=true
  - PROMPT_CACHE_TTL_MS=300000
```

### Security Configuration

```yaml
environment:
  # Git policies
  - POLICY_GIT_ALLOW_PUSH=false
  - POLICY_GIT_REQUIRE_TESTS=true
  - POLICY_GIT_TEST_COMMAND=npm test

  # Web fetch policies
  - WEB_SEARCH_ALLOWED_HOSTS=github.com,stackoverflow.com

  # Workspace policies
  - WORKSPACE_ROOT=/app/workspace
  - POLICY_MAX_STEPS=8

  # MCP sandbox
  - MCP_SANDBOX_ENABLED=true
  - MCP_SANDBOX_IMAGE=ubuntu:22.04
```

---

## Docker Commands

### Container Management

```bash
# Start services
docker-compose up -d

# Stop services
docker-compose stop

# Restart services
docker-compose restart

# View logs
docker-compose logs -f lynkr

# View logs (last 100 lines)
docker-compose logs --tail=100 lynkr

# Execute command in container
docker-compose exec lynkr sh

# Remove containers
docker-compose down

# Remove containers and volumes
docker-compose down -v
```

### Debugging

```bash
# Check container status
docker-compose ps

# Inspect container
docker inspect lynkr

# Check resource usage
docker stats lynkr

# View container logs
docker logs -f lynkr

# Enter container shell
docker exec -it lynkr sh

# Check environment variables
docker exec lynkr env

# Test health endpoint
docker exec lynkr curl http://localhost:8081/health/live
```

---

## Kubernetes Deployment

### Basic Deployment

**deployment.yaml:**
```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: lynkr
  labels:
    app: lynkr
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
        image: ghcr.io/vishalveerareddy123/lynkr:latest
        ports:
        - containerPort: 8081
          name: http
        env:
        - name: MODEL_PROVIDER
          value: "databricks"
        - name: DATABRICKS_API_BASE
          valueFrom:
            secretKeyRef:
              name: lynkr-secrets
              key: databricks-api-base
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
        volumeMounts:
        - name: data
          mountPath: /app/data
        - name: workspace
          mountPath: /app/workspace
        livenessProbe:
          httpGet:
            path: /health/live
            port: 8081
          initialDelaySeconds: 10
          periodSeconds: 10
          timeoutSeconds: 5
          failureThreshold: 3
        readinessProbe:
          httpGet:
            path: /health/ready
            port: 8081
          initialDelaySeconds: 5
          periodSeconds: 5
          timeoutSeconds: 3
          failureThreshold: 3
      volumes:
      - name: data
        persistentVolumeClaim:
          claimName: lynkr-data-pvc
      - name: workspace
        persistentVolumeClaim:
          claimName: lynkr-workspace-pvc
---
apiVersion: v1
kind: Service
metadata:
  name: lynkr
  labels:
    app: lynkr
spec:
  selector:
    app: lynkr
  ports:
  - port: 80
    targetPort: 8081
    protocol: TCP
    name: http
  type: LoadBalancer
```

**secrets.yaml:**
```yaml
apiVersion: v1
kind: Secret
metadata:
  name: lynkr-secrets
type: Opaque
stringData:
  databricks-api-base: "https://your-workspace.databricks.com"
  databricks-api-key: "your-api-key"
```

**persistent-volumes.yaml:**
```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: lynkr-data-pvc
spec:
  accessModes:
    - ReadWriteOnce
  resources:
    requests:
      storage: 10Gi
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: lynkr-workspace-pvc
spec:
  accessModes:
    - ReadWriteOnce
  resources:
    requests:
      storage: 50Gi
```

**Deploy:**
```bash
# Create secrets
kubectl apply -f secrets.yaml

# Create PVCs
kubectl apply -f persistent-volumes.yaml

# Deploy application
kubectl apply -f deployment.yaml

# Check status
kubectl get pods -l app=lynkr
kubectl get svc lynkr

# View logs
kubectl logs -f deployment/lynkr

# Scale replicas
kubectl scale deployment/lynkr --replicas=5
```

---

## Production Best Practices

### Security

1. **Run as non-root user:**
```dockerfile
USER node
```

2. **Read-only root filesystem:**
```yaml
security_opt:
  - no-new-privileges:true
read_only: true
tmpfs:
  - /tmp
```

3. **Resource limits:**
```yaml
deploy:
  resources:
    limits:
      cpus: '2'
      memory: 2G
    reservations:
      cpus: '0.5'
      memory: 512M
```

### Monitoring

1. **Prometheus metrics:**
```yaml
# Expose metrics port
ports:
  - "8081:8081"  # Main port (includes /metrics)
```

2. **Health checks:**
```yaml
healthcheck:
  test: ["CMD", "curl", "-f", "http://localhost:8081/health/live"]
  interval: 30s
  timeout: 10s
  retries: 3
  start_period: 40s
```

3. **Logging:**
```yaml
logging:
  driver: "json-file"
  options:
    max-size: "10m"
    max-file: "3"
```

### High Availability

1. **Multiple replicas:**
```yaml
spec:
  replicas: 3
```

2. **Load balancer:**
```yaml
services:
  nginx:
    image: nginx:alpine
    ports:
      - "80:80"
    volumes:
      - ./nginx.conf:/etc/nginx/nginx.conf:ro
    depends_on:
      - lynkr
```

3. **Shared database:**
```yaml
volumes:
  - lynkr_data:/app/data  # Shared volume

volumes:
  lynkr_data:
    driver: local
```

---

## Troubleshooting

### Container Won't Start

```bash
# Check logs
docker-compose logs lynkr

# Common issues:
# 1. Missing environment variables
# 2. Invalid API credentials
# 3. Port already in use
```

### Connection Refused

```bash
# Check container is running
docker-compose ps

# Check port binding
docker port lynkr

# Test from inside container
docker exec lynkr curl http://localhost:8081/health/live
```

### Out of Memory

```bash
# Increase memory limit
docker-compose.yml:
  deploy:
    resources:
      limits:
        memory: 4G  # Increase from 2G
```

### Slow Performance

```bash
# Check resource usage
docker stats lynkr

# Increase CPU limit
docker-compose.yml:
  deploy:
    resources:
      limits:
        cpus: '4'  # Increase from 2
```

---

## Next Steps

- **[Production Guide](production.md)** - Production deployment best practices
- **[Monitoring Guide](production.md#monitoring)** - Prometheus + Grafana setup
- **[API Reference](api.md)** - API endpoints
- **[Troubleshooting](troubleshooting.md)** - Common issues

---

## Getting Help

- **[GitHub Discussions](https://github.com/vishalveerareddy123/Lynkr/discussions)** - Ask questions
- **[GitHub Issues](https://github.com/vishalveerareddy123/Lynkr/issues)** - Report issues
