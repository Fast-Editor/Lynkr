# Headroom Sidecar - Context Compression Service
# Provides 47-92% token reduction for LLM requests

FROM python:3.11-slim

# Install system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Python dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application code
COPY server.py .
COPY config.py .

# Create data directory
RUN mkdir -p /app/data

# Environment variables with defaults
ENV HEADROOM_HOST="0.0.0.0" \
    HEADROOM_PORT="8787" \
    HEADROOM_LOG_LEVEL="info" \
    HEADROOM_MODE="optimize" \
    HEADROOM_PROVIDER="anthropic" \
    HEADROOM_SMART_CRUSHER="true" \
    HEADROOM_SMART_CRUSHER_MIN_TOKENS="200" \
    HEADROOM_SMART_CRUSHER_MAX_ITEMS="15" \
    HEADROOM_TOOL_CRUSHER="true" \
    HEADROOM_CACHE_ALIGNER="true" \
    HEADROOM_ROLLING_WINDOW="true" \
    HEADROOM_KEEP_TURNS="3" \
    HEADROOM_CCR="true" \
    HEADROOM_CCR_TTL="300" \
    HEADROOM_LLMLINGUA="false" \
    HEADROOM_LLMLINGUA_DEVICE="auto"

EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
    CMD curl -f http://localhost:8787/health || exit 1

CMD ["python", "server.py"]
