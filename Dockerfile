############################
# Build stage
############################
FROM node:24-alpine AS build

WORKDIR /app

# Native addon compilation (tree-sitter, better-sqlite3)
ENV CXXFLAGS="-std=gnu++20"
RUN apk add --no-cache python3 make g++ git bash

# Layer cache: dependencies first, source second
COPY package.json package-lock.json ./
RUN npm ci && npm cache clean --force && rm -rf /root/.npm /tmp/*

COPY . .
RUN npm ci --omit=dev

############################
# Runtime stage
############################
FROM node:24-alpine AS runtime

ARG VCS_REF
ARG BUILD_DATE
ARG VERSION=8.0.1

LABEL org.opencontainers.image.title="Lynkr" \
      org.opencontainers.image.description="Universal LLM proxy for Claude Code, Cursor, and AI coding tools" \
      org.opencontainers.image.version=$VERSION \
      org.opencontainers.image.revision=$VCS_REF \
      org.opencontainers.image.created=$BUILD_DATE \
      org.opencontainers.image.source="https://github.com/Fast-Editor/Lynkr" \
      org.opencontainers.image.url="https://vishalveerareddy123.github.io/Lynkr/" \
      org.opencontainers.image.vendor="Lynkr" \
      org.opencontainers.image.licenses="MIT"

WORKDIR /app

# Copy runtime files only
COPY --from=build --chown=node:node /app/index.js /app/package.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/src ./src
COPY --from=build --chown=node:node /app/config ./config
COPY --from=build --chown=node:node /app/bin ./bin
COPY --from=build --chown=node:node /app/scripts/setup.js ./scripts/setup.js

# Create data directories
RUN mkdir -p /app/data /app/logs /workspace && chown -R node:node /app/data /app/logs /workspace

VOLUME ["/app/data", "/app/logs", "/workspace"]
EXPOSE 8081

HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:8081/health/live || exit 1

# ── Sensible defaults (override with -e or .env) ────────────────────
# Most users only need to set MODEL_PROVIDER + their API key.
# Everything else works out of the box.

ENV NODE_ENV="production" \
    PORT="8081" \
    MODEL_PROVIDER="ollama" \
    TOOL_EXECUTION_MODE="server" \
    LOG_LEVEL="info" \
    WORKSPACE_ROOT="/workspace" \
    REQUEST_JSON_LIMIT="1gb" \
    SESSION_DB_PATH="/app/data/sessions.db" \
    # Ollama (default provider — free, local)
    OLLAMA_ENDPOINT="http://host.docker.internal:11434" \
    OLLAMA_MODEL="llama3.2" \
    # Fallback
    FALLBACK_ENABLED="false" \
    # Memory
    MEMORY_ENABLED="true" \
    # Token optimization (all on by default)
    HISTORY_COMPRESSION_ENABLED="true" \
    PROMPT_CACHE_ENABLED="true" \
    SMART_TOOL_SELECTION_MODE="heuristic" \
    # Hot reload
    HOT_RELOAD_ENABLED="true" \
    # Rate limiting
    RATE_LIMIT_ENABLED="true" \
    RATE_LIMIT_MAX="100"

USER node

CMD ["node", "index.js"]
