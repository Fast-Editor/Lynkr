############################
# Build stage
############################
FROM node:24-alpine AS build

WORKDIR /app

# Native addon compilation (tree-sitter, better-sqlite3)
ENV CXXFLAGS="-std=gnu++20"
RUN apk add --no-cache python3 make g++ git bash

# Layer cache: install prod deps before copying source so this layer
# is reused on source-only changes
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force && rm -rf /root/.npm /tmp/*

COPY . .

############################
# Runtime stage
############################
FROM node:24-alpine AS runtime

ARG VCS_REF
ARG BUILD_DATE
ARG VERSION=9.7.2

LABEL org.opencontainers.image.title="Lynkr" \
      org.opencontainers.image.description="Universal LLM proxy for Claude Code, Cursor, and AI coding tools" \
      org.opencontainers.image.version=$VERSION \
      org.opencontainers.image.revision=$VCS_REF \
      org.opencontainers.image.created=$BUILD_DATE \
      org.opencontainers.image.source="https://github.com/Fast-Editor/Lynkr" \
      org.opencontainers.image.url="https://vishalveerareddy123.github.io/Lynkr/" \
      org.opencontainers.image.vendor="Lynkr" \
      org.opencontainers.image.licenses="Apache-2.0"

WORKDIR /app

# Copy runtime files only
COPY --from=build --chown=node:node /app/index.js /app/package.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/src ./src
COPY --from=build --chown=node:node /app/config ./config
COPY --from=build --chown=node:node /app/bin ./bin
COPY --from=build --chown=node:node /app/scripts/setup.js ./scripts/setup.js
# WS5.6 — calibration CLI runnable inside the container (e.g.
# `docker exec lynkr node scripts/calibrate-thresholds.js --dry-run`).
COPY --from=build --chown=node:node /app/scripts/calibrate-thresholds.js ./scripts/calibrate-thresholds.js

# Create data directories.
#   /app/data     — bandit-state.json, reward-state.json, knn/,
#                   calibrated-thresholds.json  (WS4/WS5 state)
#   /app/.lynkr   — telemetry.db + session-pin SQLite store  (WS0/WS1)
#   /app/logs     — server logs
#   /workspace    — user-mounted repo the proxy operates on
RUN mkdir -p /app/data /app/data/knn /app/.lynkr /app/logs /workspace \
    && chown -R node:node /app/data /app/.lynkr /app/logs /workspace

VOLUME ["/app/data", "/app/.lynkr", "/app/logs", "/workspace"]
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
    OLLAMA_MODEL="qwen2.5-coder:latest" \
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
    RATE_LIMIT_MAX="100" \
    # Cluster mode (multi-core, recommended for teams)
    CLUSTER_ENABLED="true" \
    CLUSTER_WORKERS="auto" \
    # Routing intelligence
    LYNKR_VISIBLE_ROUTING="false" \
    LYNKR_INTENT_WINDOW_N="5" \
    LYNKR_INTENT_DECAY="0.7" \
    # WS1 — cache-aware sticky sessions
    LYNKR_STICKY_SESSIONS="true" \
    LYNKR_STICKY_TTL_MS="21600000" \
    LYNKR_SWITCH_MAX_PROMPT_TOKENS="20000" \
    # WS5 — learning loop (kNN + auto-calibration)
    LYNKR_KNN_MIN_INDEX_SIZE="100" \
    LYNKR_KNN_CONFIDENCE_HIGH="0.7" \
    LYNKR_KNN_CONFIDENCE_LOW="0.4"
    # Note: auto-calibration (WS5) and telemetry DB path (WS0) are
    # hardcoded in the source — no env knob. Telemetry writes to
    # /app/.lynkr/telemetry.db (persisted via VOLUME above).

USER node

CMD ["node", "index.js"]
