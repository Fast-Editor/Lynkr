# Use a small Node.js base image
FROM node:20-alpine

# Add OCI labels for better container management
LABEL org.opencontainers.image.title="Lynkr" \
      org.opencontainers.image.description="Self-hosted Claude Code proxy with multi-provider support and production hardening" \
      org.opencontainers.image.version="3.1.0" \
      org.opencontainers.image.vendor="Vishal Veera Reddy" \
      org.opencontainers.image.source="https://github.com/vishalveerareddy123/Lynkr" \
      org.opencontainers.image.licenses="Apache-2.0"

# Create app directory
WORKDIR /app

# Install build prerequisites for native modules (better-sqlite3)
RUN apk add --no-cache python3 py3-pip make g++ git

# Install searxng (local search provider)
#RUN pip install --no-cache-dir searxng

# Copy dependency manifests first for better layer caching
COPY package.json package-lock.json ./

# Install only production dependencies
RUN npm ci --omit=dev

# Copy source files
COPY index.js ./
COPY src ./src

# Create data directories for SQLite databases and skillbooks
RUN mkdir -p data/skillbooks data/agent-transcripts

COPY docker/start.sh ./start.sh
RUN chmod +x ./start.sh
VOLUME ["/app/data"]

# Create non-root user for better security
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001 && \
    chown -R nodejs:nodejs /app

# Expose the proxy port and searxng port
EXPOSE 8081
EXPOSE 8888

# Health check for container orchestration
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:8081/health/live || exit 1

# Provide helpful defaults for required environment variables (override at runtime)
# Core Configuration
ENV MODEL_PROVIDER="databricks" \
    TOOL_EXECUTION_MODE="server" \
    PORT="8081" \
    LOG_LEVEL="info" \
    WORKSPACE_ROOT="/workspace" \
    WEB_SEARCH_ENDPOINT="http://searxng:8888/search" \
    NODE_ENV="production"

# Databricks Configuration (default provider)
ENV DATABRICKS_API_BASE="https://example.cloud.databricks.com" \
    DATABRICKS_API_KEY="replace-with-databricks-pat"

# Ollama Configuration (for hybrid routing)
# Recommended models: llama3.1:8b, llama3.2, qwen2.5:14b, mistral:7b-instruct
ENV PREFER_OLLAMA="false" \
    OLLAMA_ENDPOINT="http://localhost:11434" \
    OLLAMA_MODEL="llama3.1:8b" \
    OLLAMA_MAX_TOOLS_FOR_ROUTING="3" \
    OLLAMA_EMBEDDINGS_MODEL="nomic-embed-text" \
    OLLAMA_EMBEDDINGS_ENDPOINT="http://localhost:11434/api/embeddings"

# OpenRouter Configuration (optional)
# Access 100+ models through a single API
ENV OPENROUTER_API_KEY="" \
    OPENROUTER_MODEL="amazon/nova-2-lite-v1:free" \
    OPENROUTER_EMBEDDINGS_MODEL="openai/text-embedding-ada-002" \
    OPENROUTER_ENDPOINT="https://openrouter.ai/api/v1/chat/completions" \
    OPENROUTER_MAX_TOOLS_FOR_ROUTING="15"

# Azure OpenAI Configuration (optional)
# IMPORTANT: Set full endpoint URL including deployment path
# Example: https://your-resource.openai.azure.com/openai/deployments/YOUR-DEPLOYMENT/chat/completions?api-version=2025-01-01-preview
# Deployment options: gpt-4o, gpt-4o-mini, gpt-5-chat, o1-preview, o3-mini
ENV AZURE_OPENAI_ENDPOINT="" \
    AZURE_OPENAI_API_KEY="" \
    AZURE_OPENAI_DEPLOYMENT="gpt-4o"

# Hybrid Routing & Fallback Configuration
# Options: databricks, azure-openai, azure-anthropic, openrouter, bedrock, openai
# Note: Local providers (ollama, llamacpp, lmstudio) cannot be used as fallback
ENV FALLBACK_ENABLED="true" \
    FALLBACK_PROVIDER="databricks"

# Azure Anthropic Configuration (optional)
ENV AZURE_ANTHROPIC_ENDPOINT="" \
    AZURE_ANTHROPIC_API_KEY=""

# AWS Bedrock Configuration (optional)
# Supports Claude, Titan, Llama, Jurassic, Cohere, Mistral models
ENV AWS_BEDROCK_API_KEY="" \
    AWS_BEDROCK_REGION="us-east-1" \
    AWS_BEDROCK_MODEL_ID="anthropic.claude-3-5-sonnet-20241022-v2:0"

# llama.cpp Configuration (optional - for local GGUF models)
ENV LLAMACPP_ENDPOINT="http://localhost:8080" \
    LLAMACPP_MODEL="default" \
    LLAMACPP_EMBEDDINGS_ENDPOINT="http://localhost:8080/embeddings" \
    LLAMACPP_TIMEOUT_MS="120000"

# OpenAI Configuration (optional)
ENV OPENAI_API_KEY="" \
    OPENAI_MODEL="gpt-4o" \
    OPENAI_ENDPOINT="https://api.openai.com/v1/chat/completions"

# Embeddings Provider Override (optional)
# Options: ollama, llamacpp, openrouter, openai
# By default, uses same provider as MODEL_PROVIDER
ENV EMBEDDINGS_PROVIDER=""

# Production Hardening Defaults
ENV CIRCUIT_BREAKER_FAILURE_THRESHOLD="5" \
    CIRCUIT_BREAKER_SUCCESS_THRESHOLD="2" \
    CIRCUIT_BREAKER_TIMEOUT="60000" \
    LOAD_SHEDDING_MEMORY_THRESHOLD="0.85" \
    LOAD_SHEDDING_HEAP_THRESHOLD="0.90"

# Long-Term Memory Configuration (Titans-inspired)
ENV MEMORY_ENABLED="true" \
    MEMORY_RETRIEVAL_LIMIT="5" \
    MEMORY_SURPRISE_THRESHOLD="0.3" \
    MEMORY_MAX_AGE_DAYS="90" \
    MEMORY_MAX_COUNT="10000" \
    MEMORY_INCLUDE_GLOBAL="true" \
    MEMORY_INJECTION_FORMAT="system" \
    MEMORY_EXTRACTION_ENABLED="true" \
    MEMORY_DECAY_ENABLED="true" \
    MEMORY_DECAY_HALF_LIFE="30" \
    MEMORY_FORMAT="compact" \
    MEMORY_DEDUP_ENABLED="true" \
    MEMORY_DEDUP_LOOKBACK="5"

# Switch to non-root user
USER nodejs

# Run the proxy
#CMD ["./start.sh"]
CMD ["node","index.js"]

