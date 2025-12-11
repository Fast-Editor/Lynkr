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
  const maxToolsForOpenRouter = config.modelProvider?.openRouterMaxToolsForRouting ?? 15;

  // Check if Ollama model supports tools when tools are present
  if (toolCount > 0) {
    const ollamaModel = config.ollama?.model;
    const supportsTools = modelNameSupportsTools(ollamaModel);

    // Only route to fallback if it's enabled AND model doesn't support tools
    if (!supportsTools && isFallbackEnabled()) {
      const fallback = config.modelProvider?.fallbackProvider ?? "databricks";
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

  // Moderate tool count → OpenRouter or Azure OpenAI (if configured and fallback enabled)
  if (toolCount < maxToolsForOpenRouter && isFallbackEnabled()) {
    if (config.openrouter?.apiKey) {
      logger.debug(
        { toolCount, maxToolsForOllama, maxToolsForOpenRouter, decision: "openrouter" },
        "Routing to OpenRouter (moderate tools)"
      );
      return "openrouter";
    } else if (config.azureOpenAI?.apiKey) {
      logger.debug(
        { toolCount, maxToolsForOllama, maxToolsForOpenRouter, decision: "azure-openai" },
        "Routing to Azure OpenAI (moderate tools)"
      );
      return "azure-openai";
    }
  }

  // Heavy tool count → cloud (only if fallback is enabled)
  if (isFallbackEnabled()) {
    const fallback = config.modelProvider?.fallbackProvider ?? "databricks";
    logger.debug(
      { toolCount, maxToolsForOpenRouter, decision: fallback },
      "Routing to cloud (heavy tools)"
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
  return config.modelProvider?.fallbackEnabled !== false;
}

/**
 * Get the fallback provider
 *
 * @returns {string} Fallback provider name (e.g., "databricks", "azure-anthropic")
 */
function getFallbackProvider() {
  return config.modelProvider?.fallbackProvider ?? "databricks";
}

module.exports = {
  determineProvider,
  isFallbackEnabled,
  getFallbackProvider,
};
