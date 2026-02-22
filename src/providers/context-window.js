/**
 * Context Window Detection
 *
 * Queries the active provider for its context window size (in tokens).
 * Returns -1 if unknown. Caches the result for the lifetime of the process.
 */

const config = require("../config");
const logger = require("../logger");

// Known context sizes for proprietary models (tokens)
const KNOWN_CONTEXT_SIZES = {
  // Anthropic
  "claude-3-opus": 200000,
  "claude-3-sonnet": 200000,
  "claude-3-haiku": 200000,
  "claude-3.5-sonnet": 200000,
  "claude-4": 200000,
  // OpenAI
  "gpt-4o": 128000,
  "gpt-4o-mini": 128000,
  "gpt-4-turbo": 128000,
  "gpt-4": 8192,
  "gpt-3.5-turbo": 16385,
};

// null = not yet detected, -1 = detected but unknown, >0 = known
let cachedContextWindow = null;

async function detectContextWindow() {
  const provider = config.modelProvider.type;

  try {
    if (provider === "ollama") {
      return await detectOllamaContextWindow();
    }
    if (provider === "openrouter") {
      return await detectOpenRouterContextWindow();
    }
    if (provider === "openai") {
      return detectFromKnownSizes(config.openai.model);
    }
    // azure-anthropic, bedrock — use known Anthropic sizes
    if (["azure-anthropic", "bedrock"].includes(provider)) {
      return 200000;
    }
    if (provider === "azure-openai") {
      return detectFromKnownSizes(config.azureOpenAI.deployment);
    }
    if (provider === "llamacpp" || provider === "lmstudio") {
      return -1; // No standard API to query
    }
    if (provider === "zai") {
      return 128000; // GLM-4 family
    }
    if (provider === "vertex") {
      return 1000000; // Gemini models
    }
  } catch (err) {
    logger.warn({ err, provider }, "Failed to detect context window");
  }

  return -1;
}

async function detectOllamaContextWindow() {
  const { getOllamaHeaders, getOllamaEndpointForModel } = require("../clients/ollama-utils");
  const model = config.ollama.model;
  const baseEndpoint = getOllamaEndpointForModel(model);
  const endpoint = `${baseEndpoint}/api/show`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: getOllamaHeaders(model),
    body: JSON.stringify({ name: model }),
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) return -1;
  const data = await response.json();

  // Ollama prefixes context_length with the architecture name
  // (e.g. "llama.context_length", "qwen2.context_length", "gemma.context_length")
  // Search for any key ending in ".context_length" or exactly "context_length"
  if (data.model_info && typeof data.model_info === "object") {
    for (const [key, value] of Object.entries(data.model_info)) {
      if (key === "context_length" || key.endsWith(".context_length")) {
        if (typeof value === "number" && value > 0) return value;
      }
    }
  }

  // Fallback: parse from parameters string (e.g. "num_ctx 32768")
  const match = data.parameters?.match(/num_ctx\s+(\d+)/);
  if (match) return parseInt(match[1], 10);
  return -1;
}

async function detectOpenRouterContextWindow() {
  const baseEndpoint = config.openrouter.endpoint || "https://openrouter.ai/api/v1/chat/completions";
  // Derive the models endpoint from the chat endpoint
  const modelsEndpoint = baseEndpoint.replace(/\/v1\/chat\/completions$/, "/v1/models");
  const response = await fetch(modelsEndpoint, {
    headers: { Authorization: `Bearer ${config.openrouter.apiKey}` },
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) return -1;
  const data = await response.json();
  const model = data.data?.find((m) => m.id === config.openrouter.model);
  return model?.context_length ?? -1;
}

function detectFromKnownSizes(modelName) {
  if (!modelName) return -1;
  const lower = modelName.toLowerCase();
  for (const [key, size] of Object.entries(KNOWN_CONTEXT_SIZES)) {
    if (lower.includes(key)) return size;
  }
  return -1;
}

async function getContextWindow() {
  if (cachedContextWindow !== null) return cachedContextWindow;
  cachedContextWindow = await detectContextWindow();
  if (cachedContextWindow === -1) {
    logger.warn(
      { provider: config.modelProvider.type },
      "Could not detect context window size — falling back to 8K tokens. " +
      "Compression may be more aggressive than necessary.",
    );
  } else {
    logger.info(
      { contextWindow: cachedContextWindow, provider: config.modelProvider.type },
      "Context window detected",
    );
  }
  return cachedContextWindow;
}

function resetCache() {
  cachedContextWindow = null;
}

module.exports = {
  getContextWindow,
  detectContextWindow,
  resetCache,
  KNOWN_CONTEXT_SIZES,
};
