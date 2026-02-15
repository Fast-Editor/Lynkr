/**
 * Provider Discovery Endpoints
 *
 * Implements cc-relay-style /v1/models and /v1/providers endpoints.
 * Dynamically discovers configured providers from .env configuration.
 *
 * @module api/providers-handler
 */

const express = require("express");
const config = require("../config");
const logger = require("../logger");
const { getHealthTracker } = require("../observability/health-tracker");
const { getCircuitBreakerRegistry } = require("../clients/circuit-breaker");

const router = express.Router();

/**
 * Get all configured providers with their models
 * Reads from config (which comes from .env) to discover what's available
 */
function getConfiguredProviders() {
  const providers = [];
  const timestamp = Math.floor(Date.now() / 1000);

  // Check Databricks
  if (config.databricks?.url && config.databricks?.apiKey) {
    providers.push({
      name: "databricks",
      type: "databricks",
      baseUrl: config.databricks.baseUrl,
      enabled: true,
      models: [
        { id: "claude-sonnet-4.5", name: "Claude Sonnet 4.5" },
        { id: "claude-opus-4.5", name: "Claude Opus 4.5" },
        { id: config.modelProvider?.defaultModel || "databricks-claude-sonnet-4-5", name: "Default Model" }
      ]
    });
  }

  // Check AWS Bedrock
  if (config.bedrock?.apiKey) {
    const bedrockModels = [
      { id: config.bedrock.modelId, name: "Configured Model" }
    ];

    // Add common Bedrock models if using Claude
    if (config.bedrock.modelId?.includes("claude")) {
      bedrockModels.push(
        { id: "anthropic.claude-3-5-sonnet-20241022-v2:0", name: "Claude 3.5 Sonnet v2" },
        { id: "anthropic.claude-3-opus-20240229-v1:0", name: "Claude 3 Opus" },
        { id: "anthropic.claude-3-haiku-20240307-v1:0", name: "Claude 3 Haiku" }
      );
    }

    providers.push({
      name: "bedrock",
      type: "aws-bedrock",
      baseUrl: `https://bedrock-runtime.${config.bedrock.region}.amazonaws.com`,
      enabled: true,
      models: bedrockModels
    });
  }

  // Check Azure Anthropic
  if (config.azureAnthropic?.endpoint && config.azureAnthropic?.apiKey) {
    providers.push({
      name: "azure-anthropic",
      type: "azure-anthropic",
      baseUrl: config.azureAnthropic.endpoint,
      enabled: true,
      models: [
        { id: "claude-3-5-sonnet", name: "Claude 3.5 Sonnet" },
        { id: "claude-opus-4.5", name: "Claude Opus 4.5" }
      ]
    });
  }

  // Check Azure OpenAI
  if (config.azureOpenAI?.endpoint && config.azureOpenAI?.apiKey) {
    providers.push({
      name: "azure-openai",
      type: "azure-openai",
      baseUrl: config.azureOpenAI.endpoint,
      enabled: true,
      models: [
        { id: config.azureOpenAI.deployment || "gpt-4o", name: "Configured Deployment" },
        { id: "gpt-4o", name: "GPT-4o" },
        { id: "gpt-4-turbo", name: "GPT-4 Turbo" }
      ]
    });
  }

  // Check OpenAI
  if (config.openai?.apiKey) {
    providers.push({
      name: "openai",
      type: "openai",
      baseUrl: config.openai.endpoint || "https://api.openai.com/v1",
      enabled: true,
      models: [
        { id: config.openai.model || "gpt-4o", name: "Configured Model" },
        { id: "gpt-4o", name: "GPT-4o" },
        { id: "gpt-4o-mini", name: "GPT-4o Mini" },
        { id: "gpt-4-turbo", name: "GPT-4 Turbo" }
      ]
    });
  }

  // Check OpenRouter
  if (config.openrouter?.apiKey) {
    providers.push({
      name: "openrouter",
      type: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
      enabled: true,
      models: [
        { id: config.openrouter.model || "openai/gpt-4o-mini", name: "Configured Model" },
        { id: "anthropic/claude-3.5-sonnet", name: "Claude 3.5 Sonnet" },
        { id: "openai/gpt-4o", name: "GPT-4o" },
        { id: "openai/gpt-4o-mini", name: "GPT-4o Mini" },
        { id: "nvidia/nemotron-3-nano-30b-a3b:free", name: "Nemotron 3 Nano (Free)" }
      ]
    });
  }

  // Check Ollama
  if (config.ollama?.endpoint) {
    providers.push({
      name: "ollama",
      type: "ollama",
      baseUrl: config.ollama.endpoint,
      enabled: true,
      models: [
        { id: config.ollama.model || "qwen2.5-coder:7b", name: "Configured Model" }
      ]
    });
  }

  // Check llama.cpp
  if (config.llamacpp?.endpoint) {
    providers.push({
      name: "llamacpp",
      type: "llama.cpp",
      baseUrl: config.llamacpp.endpoint,
      enabled: true,
      models: [
        { id: config.llamacpp.model || "default", name: "Loaded Model" }
      ]
    });
  }

  // Check LM Studio
  if (config.lmstudio?.endpoint) {
    providers.push({
      name: "lmstudio",
      type: "lm-studio",
      baseUrl: config.lmstudio.endpoint,
      enabled: true,
      models: [
        { id: config.lmstudio.model || "default", name: "Loaded Model" }
      ]
    });
  }

  // Check Z.AI (Zhipu)
  if (config.zai?.apiKey) {
    providers.push({
      name: "zai",
      type: "zhipu-ai",
      baseUrl: config.zai.endpoint || "https://api.z.ai/api/anthropic",
      enabled: true,
      models: [
        { id: config.zai.model || "GLM-4.7", name: "Configured Model" },
        { id: "GLM-4.7", name: "GLM-4.7 (Claude equivalent)" },
        { id: "GLM-4.5-Air", name: "GLM-4.5-Air (Haiku equivalent)" },
        { id: "GLM-4-Plus", name: "GLM-4-Plus" }
      ]
    });
  }

  // Check Moonshot (Kimi)
  if (config.moonshot?.apiKey) {
    providers.push({
      name: "moonshot",
      type: "moonshot-ai",
      baseUrl: config.moonshot.endpoint || "https://api.moonshot.ai/api/anthropic",
      enabled: true,
      models: [
        { id: config.moonshot.model || "kimi-k2.5", name: "Configured Model" },
        { id: "kimi-k2.5", name: "Kimi K2.5" },
      ]
    });
  }

  // Check Vertex AI (Google Cloud)
  if (config.vertex?.projectId) {
    const region = config.vertex.region || "us-east5";
    providers.push({
      name: "vertex",
      type: "google-vertex-ai",
      baseUrl: `https://${region}-aiplatform.googleapis.com`,
      enabled: true,
      models: [
        { id: config.vertex.model || "claude-sonnet-4-5@20250514", name: "Configured Model" },
        { id: "claude-sonnet-4-5@20250514", name: "Claude Sonnet 4.5" },
        { id: "claude-opus-4-5@20250514", name: "Claude Opus 4.5" },
        { id: "claude-haiku-4-5@20251001", name: "Claude Haiku 4.5" },
        { id: "claude-3-5-sonnet@20241022", name: "Claude 3.5 Sonnet" }
      ]
    });
  }

  return providers;
}

/**
 * Get the primary (active) provider based on MODEL_PROVIDER
 */
function getPrimaryProvider() {
  return config.modelProvider?.type || "databricks";
}

/**
 * GET /v1/models
 *
 * Anthropic-compatible model listing endpoint (cc-relay style).
 * Lists all available models from all configured providers.
 */
router.get("/models", (req, res) => {
  try {
    const providers = getConfiguredProviders();
    const primaryProvider = getPrimaryProvider();
    const timestamp = Math.floor(Date.now() / 1000);

    // Collect all models from all providers
    const allModels = [];
    const seenModelIds = new Set();

    for (const provider of providers) {
      for (const model of provider.models) {
        // Avoid duplicates
        const uniqueKey = `${provider.name}:${model.id}`;
        if (seenModelIds.has(uniqueKey)) continue;
        seenModelIds.add(uniqueKey);

        allModels.push({
          id: model.id,
          object: "model",
          created: timestamp,
          owned_by: provider.type,
          provider: provider.name,
          // Mark primary provider's models
          is_primary: provider.name === primaryProvider
        });
      }
    }

    logger.debug({
      providerCount: providers.length,
      modelCount: allModels.length,
      primaryProvider
    }, "Listed models (Anthropic format)");

    res.json({
      object: "list",
      data: allModels
    });

  } catch (error) {
    logger.error({ error: error.message }, "Error listing models");
    res.status(500).json({
      error: {
        type: "server_error",
        message: error.message || "Failed to list models"
      }
    });
  }
});

/**
 * GET /v1/providers
 *
 * Provider listing endpoint (cc-relay style).
 * Lists all configured providers with their metadata and models.
 */
router.get("/providers", (req, res) => {
  try {
    const providers = getConfiguredProviders();
    const primaryProvider = getPrimaryProvider();
    const fallbackProvider = config.modelProvider?.fallbackProvider;

    // Transform to cc-relay response format
    const providerInfo = providers.map(provider => ({
      name: provider.name,
      type: provider.type,
      base_url: provider.baseUrl,
      models: provider.models.map(m => m.id),
      active: provider.enabled,
      is_primary: provider.name === primaryProvider,
      is_fallback: provider.name === fallbackProvider
    }));

    logger.debug({
      providerCount: providerInfo.length,
      primaryProvider,
      fallbackProvider
    }, "Listed providers");

    res.json({
      object: "list",
      data: providerInfo,
      primary: primaryProvider,
      fallback: fallbackProvider || null,
      fallback_enabled: config.modelProvider?.fallbackEnabled || false
    });

  } catch (error) {
    logger.error({ error: error.message }, "Error listing providers");
    res.status(500).json({
      error: {
        type: "server_error",
        message: error.message || "Failed to list providers"
      }
    });
  }
});

/**
 * GET /v1/providers/:name
 *
 * Get details for a specific provider.
 */
router.get("/providers/:name", (req, res) => {
  try {
    const providerName = req.params.name.toLowerCase();
    const providers = getConfiguredProviders();
    const provider = providers.find(p => p.name === providerName);

    if (!provider) {
      return res.status(404).json({
        error: {
          type: "not_found",
          message: `Provider '${providerName}' not found or not configured`
        }
      });
    }

    const primaryProvider = getPrimaryProvider();
    const fallbackProvider = config.modelProvider?.fallbackProvider;

    res.json({
      name: provider.name,
      type: provider.type,
      base_url: provider.baseUrl,
      models: provider.models,
      active: provider.enabled,
      is_primary: provider.name === primaryProvider,
      is_fallback: provider.name === fallbackProvider
    });

  } catch (error) {
    logger.error({ error: error.message }, "Error getting provider details");
    res.status(500).json({
      error: {
        type: "server_error",
        message: error.message || "Failed to get provider details"
      }
    });
  }
});

/**
 * GET /v1/config
 *
 * Get current configuration summary (without sensitive data).
 */
router.get("/config", (req, res) => {
  try {
    const providers = getConfiguredProviders();

    res.json({
      model_provider: config.modelProvider?.type || "databricks",
      fallback_provider: config.modelProvider?.fallbackProvider || null,
      fallback_enabled: config.modelProvider?.fallbackEnabled || false,
      prefer_ollama: config.modelProvider?.preferOllama || false,
      tool_execution_mode: config.toolExecutionMode || "server",
      configured_providers: providers.map(p => p.name),
      memory_enabled: config.memory?.enabled || false,
      smart_tool_selection: config.smartToolSelection?.enabled || false
    });

  } catch (error) {
    logger.error({ error: error.message }, "Error getting config");
    res.status(500).json({
      error: {
        type: "server_error",
        message: error.message || "Failed to get configuration"
      }
    });
  }
});

/**
 * GET /v1/health/providers
 *
 * Provider health summary endpoint.
 * Returns real-time health metrics for all configured providers.
 */
router.get("/health/providers", (req, res) => {
  try {
    const healthTracker = getHealthTracker();
    const registry = getCircuitBreakerRegistry();

    // Get circuit breaker states
    const circuitBreakerStates = {};
    const allBreakers = registry.getAll();
    for (const [name, breaker] of Object.entries(allBreakers)) {
      circuitBreakerStates[name] = breaker.state;
    }

    // Get all provider health
    const providerHealth = healthTracker.getAllHealth(circuitBreakerStates);

    res.json({
      object: "health_summary",
      providers: providerHealth,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    logger.error({ error: error.message }, "Error getting provider health");
    res.status(500).json({
      error: {
        type: "server_error",
        message: error.message || "Failed to get provider health"
      }
    });
  }
});

/**
 * GET /v1/health/providers/:name
 *
 * Detailed health metrics for a specific provider.
 */
router.get("/health/providers/:name", (req, res) => {
  try {
    const providerName = req.params.name.toLowerCase();
    const healthTracker = getHealthTracker();
    const registry = getCircuitBreakerRegistry();

    // Get circuit breaker state for this provider
    const allBreakers = registry.getAll();
    const circuitState = allBreakers[providerName]?.state || "CLOSED";

    // Get detailed metrics
    const metrics = healthTracker.getProviderMetrics(providerName);
    const status = healthTracker.getStatus(providerName, circuitState);

    res.json({
      name: providerName,
      status,
      circuit_state: circuitState,
      ...metrics,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    logger.error({ error: error.message }, "Error getting provider health details");
    res.status(500).json({
      error: {
        type: "server_error",
        message: error.message || "Failed to get provider health details"
      }
    });
  }
});

module.exports = router;
