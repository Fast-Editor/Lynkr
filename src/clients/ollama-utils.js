const config = require("../config");
const logger = require("../logger");

// Cache for model capabilities
const modelCapabilitiesCache = new Map();

/**
 * Known models with tool calling support
 */
const TOOL_CAPABLE_MODELS = new Set([
  "llama3.1",
  "llama3.2",
  "llama3.3",
  "qwen2.5",
  "qwen3",
  "mistral",
  "mistral-nemo",
  "firefunction-v2",
  "kimi-k2.5",
  "nemotron",
  "glm-4",
  "glm-4.5",
  "glm-4.7",
  "glm-5",
  "gpt-oss",
  "minimax",
  "deepseek-r1",
]);

/**
 * Check if a model name indicates tool support
 */
function modelNameSupportsTools(modelName) {
  if (!modelName) return false;

  const normalized = modelName.toLowerCase();

  // Check if model name starts with any known tool-capable model
  return Array.from(TOOL_CAPABLE_MODELS).some(prefix =>
    normalized.startsWith(prefix)
  );
}

/**
 * Check if Ollama model supports tool calling
 * Uses heuristics and caching to avoid repeated API calls
 */
async function checkOllamaToolSupport(modelName = config.ollama?.model) {
  if (!modelName) return false;

  // Check cache
  if (modelCapabilitiesCache.has(modelName)) {
    return modelCapabilitiesCache.get(modelName);
  }

  // Quick heuristic check based on model name
  const supportsTools = modelNameSupportsTools(modelName);

  logger.debug({ modelName, supportsTools }, "Ollama tool support check");

  // Cache the result
  modelCapabilitiesCache.set(modelName, supportsTools);

  return supportsTools;
}

// --- Endpoint detection: Anthropic (/v1/messages) vs legacy (/api/chat) ---

// null = not probed yet, true = Anthropic available, false = use legacy
let anthropicEndpointAvailable = null;

/**
 * Probe whether Ollama exposes the Anthropic-compatible /v1/messages endpoint (v0.14.0+).
 * Result is cached for the process lifetime.
 */
async function hasAnthropicEndpoint(baseUrl) {
  if (anthropicEndpointAvailable !== null) return anthropicEndpointAvailable;

  try {
    // Send a minimal request — we only care about whether the route exists
    const res = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "probe",
        max_tokens: 1,
        messages: [{ role: "user", content: "hi" }],
      }),
    });

    // 404 → endpoint doesn't exist (old Ollama)
    // Any other status (200, 400, 500) → endpoint exists
    anthropicEndpointAvailable = res.status !== 404;
    logger.info(
      { available: anthropicEndpointAvailable, status: res.status },
      anthropicEndpointAvailable
        ? "Ollama Anthropic API detected (/v1/messages) — using native passthrough"
        : "Ollama Anthropic API not available — falling back to legacy /api/chat (upgrade to Ollama v0.14.0+ for best results)"
    );
  } catch (err) {
    // Network error — assume legacy
    anthropicEndpointAvailable = false;
    logger.warn({ error: err.message }, "Failed to probe Ollama Anthropic endpoint, using legacy /api/chat");
  }

  return anthropicEndpointAvailable;
}

// Exposed for tests
function resetEndpointCache() {
  anthropicEndpointAvailable = null;
}

// --- Legacy format conversion (for Ollama < v0.14.0 using /api/chat) ---

/**
 * Convert Anthropic tool format to Ollama/OpenAI function-calling format
 */
function convertAnthropicToolsToOllama(anthropicTools) {
  if (!Array.isArray(anthropicTools) || anthropicTools.length === 0) {
    return [];
  }

  return anthropicTools.map(tool => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description || "",
      parameters: tool.input_schema || {
        type: "object",
        properties: {},
      },
    },
  }));
}

module.exports = {
  checkOllamaToolSupport,
  modelNameSupportsTools,
  hasAnthropicEndpoint,
  resetEndpointCache,
  convertAnthropicToolsToOllama,
};
