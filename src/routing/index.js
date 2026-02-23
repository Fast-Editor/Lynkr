/**
 * Smart Routing Module
 *
 * Intelligent request routing based on complexity analysis.
 * Routes simple requests to local models (Ollama, llama.cpp)
 * and complex requests to cloud providers.
 *
 * @module routing
 */

const config = require('../config');
const logger = require('../logger');
const { modelNameSupportsTools } = require('../clients/ollama-utils');
const {
  analyzeComplexity,
  shouldForceLocal,
  shouldForceCloud,
  routingMetrics,
  analyzeWithEmbeddings,
} = require('./complexity-analyzer');

// Local providers
const LOCAL_PROVIDERS = ['ollama', 'llamacpp', 'lmstudio'];

/**
 * Check if a provider is local
 */
function isLocalProvider(provider) {
  return LOCAL_PROVIDERS.includes(provider);
}

/**
 * Check if fallback is enabled
 */
function isFallbackEnabled() {
  return config.modelProvider?.fallbackEnabled !== false;
}

/**
 * Get the configured fallback provider
 */
function getFallbackProvider() {
  return config.modelProvider?.fallbackProvider ?? 'databricks';
}

/**
 * Get the best available cloud provider
 * @param {Object} options - Options for provider selection
 * @param {number} options.toolCount - Number of tools in the request (for hybrid routing)
 * @param {boolean} options.useHybridRouting - Whether to use hybrid routing logic (default: false)
 */
function getBestCloudProvider(options = {}) {
  const { toolCount = 0, useHybridRouting = false } = options;

  // If hybrid routing is explicitly enabled and we have tools, use tool-based routing
  const preferOllama = config.modelProvider?.preferOllama ?? false;

  if (preferOllama && useHybridRouting && toolCount > 0) {
    const openRouterMaxTools = config.modelProvider?.openRouterMaxToolsForRouting ?? 15;

    // For moderate tool counts, prefer OpenRouter over Azure OpenAI
    if (toolCount <= openRouterMaxTools && config.openrouter?.apiKey) {
      return 'openrouter';
    }

    // For higher tool counts, use Azure OpenAI if available
    if (config.azureOpenAI?.endpoint && config.azureOpenAI?.apiKey) {
      return 'azure-openai';
    }
  }

  // Standard priority order for cloud providers
  if (config.databricks?.url && config.databricks?.apiKey) return 'databricks';
  if (config.azureAnthropic?.endpoint && config.azureAnthropic?.apiKey) return 'azure-anthropic';
  if (config.bedrock?.apiKey) return 'bedrock';
  if (config.openrouter?.apiKey) return 'openrouter';
  if (config.openai?.apiKey) return 'openai';
  if (config.azureOpenAI?.endpoint && config.azureOpenAI?.apiKey) return 'azure-openai';

  return getFallbackProvider();
}

/**
 * Get the best available local provider
 */
function getBestLocalProvider() {
  if (config.ollama?.endpoint || config.ollama?.cloudEndpoint) return 'ollama';
  if (config.llamacpp?.endpoint) return 'llamacpp';
  if (config.lmstudio?.endpoint) return 'lmstudio';

  return 'ollama';  // Default
}

/**
 * Determine the optimal provider based on request complexity
 *
 * This is the main routing function that implements all 4 phases:
 * - Phase 1: Basic scoring (tokens, tools, task type)
 * - Phase 2: Advanced classification (code complexity, reasoning)
 * - Phase 3: Metrics tracking
 * - Phase 4: Optional embeddings-based adjustment
 *
 * @param {Object} payload - Request payload
 * @param {Object} options - Routing options
 * @returns {Object} Routing decision with provider and metadata
 */
async function determineProviderSmart(payload, options = {}) {
  const preferOllama = config.modelProvider?.preferOllama ?? false;
  const primaryProvider = config.modelProvider?.type ?? 'databricks';

  // If smart routing is disabled, use static configuration
  if (!preferOllama) {
    return {
      provider: primaryProvider,
      method: 'static',
      reason: 'smart_routing_disabled',
    };
  }

  // Quick check for force patterns
  if (shouldForceLocal(payload)) {
    const provider = getBestLocalProvider();
    const decision = {
      provider,
      method: 'force',
      reason: 'force_local_pattern',
      score: 0,
    };
    routingMetrics.record(decision);
    return decision;
  }

  if (shouldForceCloud(payload) && isFallbackEnabled()) {
    const toolCount = payload?.tools?.length ?? 0;
    const provider = getBestCloudProvider({ toolCount });
    const decision = {
      provider,
      method: 'force',
      reason: 'force_cloud_pattern',
      score: 100,
    };
    routingMetrics.record(decision);
    return decision;
  }

  // Check tool count thresholds for hybrid routing
  const toolCount = payload?.tools?.length ?? 0;
  const ollamaMaxTools = config.modelProvider?.ollamaMaxToolsForRouting ?? 3;

  // If tool count is within Ollama's threshold, route to Ollama
  if (toolCount > 0 && toolCount <= ollamaMaxTools) {
    const ollamaModel = config.ollama?.model;
    const supportsTools = modelNameSupportsTools(ollamaModel);

    if (supportsTools) {
      const provider = getBestLocalProvider();
      const decision = {
        provider,
        method: 'tool_threshold',
        reason: 'within_ollama_tool_threshold',
        score: 0,
        toolCount,
        threshold: ollamaMaxTools,
      };
      routingMetrics.record(decision);
      return decision;
    }
    // If Ollama doesn't support tools, fall through to cloud routing
    if (isFallbackEnabled()) {
      const provider = getBestCloudProvider({ toolCount });
      const decision = {
        provider,
        method: 'tool_support',
        reason: 'local_model_no_tool_support',
        score: 0,
        toolCount,
      };
      routingMetrics.record(decision);
      return decision;
    }
  }

  // If tool count exceeds Ollama threshold but fallback is enabled, route to cloud
  if (toolCount > ollamaMaxTools && isFallbackEnabled()) {
    const provider = getBestCloudProvider({ toolCount, useHybridRouting: true });
    const decision = {
      provider,
      method: 'tool_threshold',
      reason: 'exceeds_ollama_tool_threshold',
      score: 50,
      toolCount,
      threshold: ollamaMaxTools,
    };
    routingMetrics.record(decision);
    return decision;
  }

  // Full complexity analysis for non-tool requests
  const analysis = analyzeComplexity(payload);

  // Phase 4: Optional embeddings adjustment
  let embeddingsResult = null;
  if (options.useEmbeddings !== false && config.ollama?.embeddingsModel) {
    try {
      embeddingsResult = await analyzeWithEmbeddings(payload);
      if (embeddingsResult?.adjustment) {
        analysis.score = Math.max(0, Math.min(100,
          analysis.score + embeddingsResult.adjustment
        ));
        analysis.embeddingsAdjustment = embeddingsResult.adjustment;
      }
    } catch (err) {
      logger.debug({ err: err.message }, 'Embeddings analysis failed, using heuristics only');
    }
  }

  // Apply routing decision based on complexity
  let provider;
  let method = 'complexity';

  if (analysis.recommendation === 'local') {
    provider = getBestLocalProvider();
  } else {
    // Cloud recommendation
    if (isFallbackEnabled()) {
      provider = getBestCloudProvider({ toolCount });
    } else {
      // Fallback disabled, use local anyway
      provider = getBestLocalProvider();
      method = 'fallback_disabled';
    }
  }

  const decision = {
    provider,
    method,
    reason: analysis.recommendation,
    score: analysis.score,
    threshold: analysis.threshold,
    mode: analysis.mode,
    analysis,
    embeddingsResult,
  };

  // Phase 3: Record metrics
  routingMetrics.record(decision);

  logger.debug(
    {
      provider,
      score: analysis.score,
      threshold: analysis.threshold,
      recommendation: analysis.recommendation,
      taskType: analysis.breakdown.taskType.reason,
      toolCount,
    },
    'Smart routing decision'
  );

  return decision;
}

/**
 * Synchronous version of determineProvider for backward compatibility
 * Does not include Phase 4 embeddings analysis
 */
function determineProvider(payload) {
  const preferOllama = config.modelProvider?.preferOllama ?? false;
  const primaryProvider = config.modelProvider?.type ?? 'databricks';

  // If smart routing is disabled, use static configuration
  if (!preferOllama) {
    return primaryProvider;
  }

  // Quick check for force patterns
  if (shouldForceLocal(payload)) {
    return getBestLocalProvider();
  }

  if (shouldForceCloud(payload) && isFallbackEnabled()) {
    const toolCount = payload?.tools?.length ?? 0;
    return getBestCloudProvider({ toolCount });
  }

  // Check tool count thresholds for hybrid routing
  const toolCount = payload?.tools?.length ?? 0;
  const ollamaMaxTools = config.modelProvider?.ollamaMaxToolsForRouting ?? 3;

  // If tool count is within Ollama's threshold, route to Ollama
  if (toolCount > 0 && toolCount <= ollamaMaxTools) {
    const ollamaModel = config.ollama?.model;
    const supportsTools = modelNameSupportsTools(ollamaModel);

    if (supportsTools) {
      return getBestLocalProvider();
    }
    // If Ollama doesn't support tools, fall through to cloud routing
    if (isFallbackEnabled()) {
      return getBestCloudProvider({ toolCount });
    }
  }

  // If tool count exceeds Ollama threshold but fallback is enabled, route to cloud
  if (toolCount > ollamaMaxTools && isFallbackEnabled()) {
    return getBestCloudProvider({ toolCount, useHybridRouting: true });
  }

  // Full complexity analysis (without embeddings) for non-tool requests
  const analysis = analyzeComplexity(payload);

  // Apply routing decision based on complexity
  if (analysis.recommendation === 'local') {
    return getBestLocalProvider();
  }

  if (isFallbackEnabled()) {
    return getBestCloudProvider({ toolCount });
  }

  return getBestLocalProvider();
}

/**
 * Get routing headers to include in response
 * Phase 3: Expose routing decision to clients
 */
function getRoutingHeaders(decision) {
  const headers = {
    'X-Lynkr-Routing-Method': decision.method || 'unknown',
    'X-Lynkr-Provider': decision.provider || 'unknown',
  };

  if (typeof decision.score === 'number') {
    headers['X-Lynkr-Complexity-Score'] = String(decision.score);
  }

  if (decision.threshold) {
    headers['X-Lynkr-Complexity-Threshold'] = String(decision.threshold);
  }

  if (decision.reason) {
    headers['X-Lynkr-Routing-Reason'] = decision.reason;
  }

  return headers;
}

/**
 * Get routing statistics
 * Phase 3: Metrics access
 */
function getRoutingStats() {
  return routingMetrics.getStats();
}

module.exports = {
  // Main routing functions
  determineProvider,
  determineProviderSmart,

  // Helpers
  isFallbackEnabled,
  getFallbackProvider,
  getBestCloudProvider,
  getBestLocalProvider,
  isLocalProvider,

  // Phase 3: Headers and metrics
  getRoutingHeaders,
  getRoutingStats,

  // Re-export analyzer for direct access
  analyzeComplexity: require('./complexity-analyzer').analyzeComplexity,
};
