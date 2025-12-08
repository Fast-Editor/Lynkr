const config = require("../config");
const logger = require("../logger");
const { modelNameSupportsTools } = require("./ollama-utils");

/**
 * Determine provider based on request complexity
 *
 * Routing Rules:
 * 1. If PREFER_OLLAMA is false, route based on MODEL_PROVIDER
 * 2. If no tools OR tool count < threshold, route to Ollama
 * 3. If tools present AND model doesn't support tools, route to cloud
 * 4. If tool count >= threshold, route to cloud for better performance
 *
 * @param {Object} payload - Request payload with tools array
 * @returns {string} Provider to use ('ollama' or fallback provider)
 */
function determineProvider(payload) {
  const preferOllama = config.modelProvider?.preferOllama ?? false;

  // If not in preference mode, use static configuration
  if (!preferOllama) {
    return config.modelProvider?.type ?? "databricks";
  }

  // Count tools in request
  const toolCount = Array.isArray(payload?.tools) ? payload.tools.length : 0;
  const maxToolsForOllama = config.modelProvider?.ollamaMaxToolsForRouting ?? 3;

  // Check if Ollama model supports tools when tools are present
  if (toolCount > 0) {
    const ollamaModel = config.ollama?.model;
    const supportsTools = modelNameSupportsTools(ollamaModel);

    // Only route to fallback if it's enabled AND model doesn't support tools
    if (!supportsTools && isFallbackEnabled()) {
      const fallback = config.modelProvider?.ollamaFallbackProvider ?? "databricks";
      logger.debug(
        { toolCount, ollamaModel, supportsTools: false, decision: fallback },
        "Routing to cloud (model doesn't support tools)"
      );
      return fallback;
    }
  }

  // No tools or simple requests → Ollama
  if (toolCount === 0 || toolCount < maxToolsForOllama) {
    logger.debug(
      { toolCount, maxToolsForOllama, decision: "ollama" },
      "Routing to Ollama (simple request)"
    );
    return "ollama";
  }

  // Complex requests → cloud (only if fallback is enabled)
  if (isFallbackEnabled()) {
    const fallback = config.modelProvider?.ollamaFallbackProvider ?? "databricks";
    logger.debug(
      { toolCount, maxToolsForOllama, decision: fallback },
      "Routing to cloud (complex request)"
    );
    return fallback;
  }

  // Fallback disabled, route to Ollama regardless of complexity
  logger.debug(
    { toolCount, maxToolsForOllama, fallbackEnabled: false, decision: "ollama" },
    "Routing to Ollama (fallback disabled)"
  );
  return "ollama";
}

/**
 * Check if fallback is enabled for the current configuration
 *
 * @returns {boolean} True if fallback is enabled
 */
function isFallbackEnabled() {
  return config.modelProvider?.ollamaFallbackEnabled !== false;
}

/**
 * Get the fallback provider
 *
 * @returns {string} Fallback provider name (e.g., "databricks", "azure-anthropic")
 */
function getFallbackProvider() {
  return config.modelProvider?.ollamaFallbackProvider ?? "databricks";
}

module.exports = {
  determineProvider,
  isFallbackEnabled,
  getFallbackProvider,
};
