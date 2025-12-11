# Use a small Node.js base image
FROM node:20-alpine

# Create app directory
WORKDIR /app

# Install build prerequisites for native modules (better-sqlite3)
RUN apk add --no-cache python3 py3-pip make g++ git

# Install searxng (local search provider)
RUN pip install --no-cache-dir searxng

# Copy dependency manifests first for better layer caching
COPY package.json package-lock.json ./

# Install only production dependencies
RUN npm ci --omit=dev

# Copy source files
COPY index.js ./
COPY src ./src
RUN mkdir -p data
COPY docker/start.sh ./start.sh
RUN chmod +x ./start.sh
VOLUME ["/app/data"]

# Expose the proxy port and searxng port
EXPOSE 8080
EXPOSE 8888

# Provide helpful defaults for required environment variables (override at runtime)
# Core Configuration
ENV MODEL_PROVIDER="databricks" \
    TOOL_EXECUTION_MODE="server" \
    PORT="8080" \
    LOG_LEVEL="info" \
    WORKSPACE_ROOT="/workspace" \
    WEB_SEARCH_ENDPOINT="http://localhost:8888/search"

# Databricks Configuration (default provider)
ENV DATABRICKS_API_BASE="https://example.cloud.databricks.com" \
    DATABRICKS_API_KEY="replace-with-databricks-pat"

# Ollama Configuration (for hybrid routing)
ENV PREFER_OLLAMA="false" \
    OLLAMA_ENDPOINT="http://localhost:11434" \
    OLLAMA_MODEL="qwen2.5-coder:latest" \
    OLLAMA_MAX_TOOLS_FOR_ROUTING="3"

# OpenRouter Configuration (optional)
ENV OPENROUTER_API_KEY="" \
    OPENROUTER_MODEL="amazon/nova-2-lite-v1:free" \
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
    AZURE_ANTHROPIC_API_KEY=""

# Run the proxy
CMD ["./start.sh"]
