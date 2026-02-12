############################
# Build stage
############################
FROM node:24-alpine AS build

# Set working directory
WORKDIR /app

# Ensure native addons compile correctly under Alpine (musl)
# Explicitly force a modern C++ standard for tree-sitter and friends
ENV CXXFLAGS="-std=gnu++20"

# Install build dependencies for native Node modules
RUN apk add --no-cache \
    python3 \
    make \
    g++ \
    git \
    bash

# Copy only dependency manifests first for better layer caching
COPY package.json package-lock.json ./

# Install dependencies deterministically and strip npm cache artifacts
RUN npm ci \
 && npm cache clean --force \
 && rm -rf /root/.npm /tmp/*

# Copy application source
COPY . .

# Build application (adjust if your build output differs)
RUN npm ci --omit=dev

############################
# Runtime stage
############################
FROM node:24-alpine AS runtime

# Build metadata supplied externally (reproducible)
ARG VCS_REF
ARG BUILD_DATE

# OCI-compliant, reproducible image labels
LABEL org.opencontainers.image.revision=$VCS_REF \
      org.opencontainers.image.created=$BUILD_DATE \
      org.opencontainers.image.title="Your App Name" \
      org.opencontainers.image.source="https://github.com/your-org/your-repo"

# Set runtime working directory
WORKDIR /app

# Copy only what is required to run
COPY --from=build --chown=node:node /app/index.js /app/package.json ./
# Copy application source and modules (recursive, safe)
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/src ./src

VOLUME ["/app/data", "/app/logs"]

EXPOSE 8081

# Drop root privileges if your app allows it (recommended)
# RUN addgroup -S nodejs && adduser -S nodejs -G nodejs

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
    NODE_ENV="production" \
    REQUEST_JSON_LIMIT="1gb" \
    SESSION_DB_PATH="/app/data/sessions.db"

# File Logging (persistent logs with pino-roll rotation)
ENV LOG_FILE_ENABLED="false" \
    LOG_FILE_PATH="/app/logs/lynkr.log" \
    LOG_FILE_LEVEL="debug" \
    LOG_FILE_FREQUENCY="daily" \
    LOG_FILE_MAX_FILES="14"

# Databricks Configuration (default provider)
ENV DATABRICKS_API_BASE="https://example.cloud.databricks.com" \
    DATABRICKS_API_KEY="replace-with-databricks-pat"

# Ollama Configuration (for hybrid routing)
# Recommended models: llama3.1:8b, llama3.2, qwen2.5:14b, mistral:7b-instruct
ENV PREFER_OLLAMA="false" \
    OLLAMA_ENDPOINT="http://localhost:11434" \
    OLLAMA_MODEL="llama3.1:8b" \
    OLLAMA_TIMEOUT_MS="120000" \
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
ENV AZURE_OPENAI_ENDPOINT="" \
    AZURE_OPENAI_API_KEY="" \
    AZURE_OPENAI_DEPLOYMENT="gpt-4o" \
    AZURE_OPENAI_API_VERSION="2024-08-01-preview"

# Hybrid Routing & Fallback Configuration
ENV FALLBACK_ENABLED="true" \
    FALLBACK_PROVIDER="databricks"

# Azure Anthropic Configuration (optional)
ENV AZURE_ANTHROPIC_ENDPOINT="" \
    AZURE_ANTHROPIC_API_KEY="" \
    AZURE_ANTHROPIC_VERSION="2023-06-01"

# AWS Bedrock Configuration (optional)
ENV AWS_BEDROCK_API_KEY="" \
    AWS_BEDROCK_REGION="us-east-1" \
    AWS_BEDROCK_MODEL_ID="anthropic.claude-3-5-sonnet-20241022-v2:0"

# llama.cpp Configuration (optional)
ENV LLAMACPP_ENDPOINT="http://localhost:8080" \
    LLAMACPP_MODEL="default" \
    LLAMACPP_EMBEDDINGS_ENDPOINT="http://localhost:8080/embeddings" \
    LLAMACPP_TIMEOUT_MS="120000"

# LM Studio Configuration (optional)
ENV LMSTUDIO_ENDPOINT="http://localhost:1234" \
    LMSTUDIO_MODEL="default" \
    LMSTUDIO_TIMEOUT_MS="120000"

# OpenAI Configuration (optional)
ENV OPENAI_API_KEY="" \
    OPENAI_MODEL="gpt-4o" \
    OPENAI_ENDPOINT="https://api.openai.com/v1/chat/completions"

# Z.AI Configuration (optional)
ENV ZAI_API_KEY="" \
    ZAI_ENDPOINT="https://api.z.ai/api/anthropic/v1/messages" \
    ZAI_MODEL="GLM-4.7"

# Google Vertex AI Configuration (optional)
ENV VERTEX_API_KEY="" \
    VERTEX_MODEL="gemini-2.0-flash"

# Embeddings Provider Override (optional)
ENV EMBEDDINGS_PROVIDER=""

# Tool Injection & Suggestion Mode
ENV INJECT_TOOLS_LLAMACPP="true" \
    INJECT_TOOLS_OLLAMA="true" \
    SUGGESTION_MODE_MODEL="default"

# Rate Limiting
ENV RATE_LIMIT_ENABLED="true" \
    RATE_LIMIT_WINDOW_MS="60000" \
    RATE_LIMIT_MAX="100" \
    RATE_LIMIT_KEY_BY="session"

# Web Search Configuration
ENV WEB_SEARCH_ALLOW_ALL="true" \
    WEB_SEARCH_TIMEOUT_MS="10000" \
    WEB_FETCH_BODY_PREVIEW_MAX="10000" \
    WEB_SEARCH_RETRY_ENABLED="true" \
    WEB_SEARCH_MAX_RETRIES="2"

# Policy Configuration
ENV POLICY_MAX_STEPS="20" \
    POLICY_MAX_TOOL_CALLS="12" \
    POLICY_TOOL_LOOP_THRESHOLD="10" \
    POLICY_GIT_ALLOW_PUSH="false" \
    POLICY_GIT_ALLOW_PULL="true" \
    POLICY_GIT_ALLOW_COMMIT="true" \
    POLICY_GIT_REQUIRE_TESTS="false" \
    POLICY_GIT_AUTOSTASH="false" \
    POLICY_FILE_BLOCKED_PATHS="/.env,.env,/etc/passwd,/etc/shadow" \
    POLICY_SAFE_COMMANDS_ENABLED="true"

# Agents Configuration
ENV AGENTS_ENABLED="true" \
    AGENTS_MAX_CONCURRENT="10" \
    AGENTS_DEFAULT_MODEL="haiku" \
    AGENTS_MAX_STEPS="15" \
    AGENTS_TIMEOUT="300000"

# Prompt Cache Configuration
ENV PROMPT_CACHE_ENABLED="true" \
    PROMPT_CACHE_MAX_ENTRIES="1000" \
    PROMPT_CACHE_TTL_MS="300000"

# Semantic Response Cache
ENV SEMANTIC_CACHE_ENABLED="false" \
    SEMANTIC_CACHE_THRESHOLD="0.95"

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

# Token Optimization
ENV TOKEN_TRACKING_ENABLED="true" \
    TOOL_TRUNCATION_ENABLED="true" \
    SYSTEM_PROMPT_MODE="dynamic" \
    TOOL_DESCRIPTIONS="minimal" \
    HISTORY_COMPRESSION_ENABLED="true" \
    HISTORY_KEEP_RECENT_TURNS="10" \
    HISTORY_SUMMARIZE_OLDER="true" \
    TOKEN_BUDGET_WARNING="100000" \
    TOKEN_BUDGET_MAX="180000" \
    TOKEN_BUDGET_ENFORCEMENT="true"

# Smart Tool Selection
ENV SMART_TOOL_SELECTION_MODE="heuristic" \
    SMART_TOOL_SELECTION_TOKEN_BUDGET="2500"

# Hot Reload
ENV HOT_RELOAD_ENABLED="true" \
    HOT_RELOAD_DEBOUNCE_MS="1000"

# Tiered Model Routing (optional)
# Format: TIER_<LEVEL>=provider:model
# All 4 tiers must be set to enable tiered routing
# ENV TIER_SIMPLE="ollama:llama3.2" \
#     TIER_MEDIUM="openrouter:openai/gpt-4o-mini" \
#     TIER_COMPLEX="azure-openai:gpt-4o" \
#     TIER_REASONING="azure-openai:gpt-4o"

# Switch to non-root user
USER node

# Run the application
CMD ["node", "index.js"]
