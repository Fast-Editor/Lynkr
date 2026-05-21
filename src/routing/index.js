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
const {
  analyzeComplexity,
  shouldForceLocal,
  shouldForceCloud,
  routingMetrics,
  analyzeWithEmbeddings,
} = require('./complexity-analyzer');

// Intelligent routing modules
const { getAgenticDetector, AGENT_TYPES } = require('./agentic-detector');
const { getModelTierSelector, TIER_DEFINITIONS } = require('./model-tiers');
const { getCostOptimizer } = require('./cost-optimizer');
const { analyzeRisk } = require('./risk-analyzer');

// Telemetry modules
const telemetry = require('./telemetry');
const { scoreResponseQuality } = require('./quality-scorer');
const { getLatencyTracker } = require('./latency-tracker');

// Phase 1 modules
const contextValidator = require('./context-validator');
const { countPayloadTokens } = require('./tokenizer');

// Local providers
const LOCAL_PROVIDERS = ['ollama', 'llamacpp', 'lmstudio'];

/**
 * List of providers that currently have credentials configured.
 * Used by the Phase 1.2 cost-optimizer override to scope candidates.
 */
function _enabledProviders() {
  const out = [];
  if (config.databricks?.url && config.databricks?.apiKey) out.push('databricks');
  if (config.azureAnthropic?.endpoint && config.azureAnthropic?.apiKey) out.push('azure-anthropic');
  if (config.bedrock?.apiKey) out.push('bedrock');
  if (config.openrouter?.apiKey) out.push('openrouter');
  if (config.openai?.apiKey) out.push('openai');
  if (config.azureOpenAI?.endpoint && config.azureOpenAI?.apiKey) out.push('azure-openai');
  if (config.ollama?.endpoint) out.push('ollama');
  if (config.llamacpp?.endpoint) out.push('llamacpp');
  if (config.lmstudio?.endpoint) out.push('lmstudio');
  return out;
}

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
function getBestCloudProvider() {
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
  if (config.ollama?.endpoint) return 'ollama';
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
  const primaryProvider = config.modelProvider?.type ?? 'databricks';

  // Risk analysis runs orthogonally to complexity. We compute it once
  // up-front so it can short-circuit force_local and feed the tier
  // selector below. Even when tier routing is disabled we still surface
  // the signal for telemetry.
  let risk = null;
  try {
    risk = analyzeRisk(payload);
  } catch (err) {
    logger.debug({ err: err.message }, '[Routing] Risk analysis failed, ignoring');
    risk = null;
  }

  // If tier routing is disabled, use static configuration
  if (!config.modelTiers?.enabled) {
    return {
      provider: primaryProvider,
      model: null,
      method: 'static',
      reason: 'tier_routing_disabled',
      risk,
    };
  }

  // High-risk requests jump straight to COMPLEX and skip the rest of
  // the analysis. This is independent of complexity score — a one-line
  // edit to auth/middleware.ts should never go to a local model.
  if (risk?.level === 'high' && isFallbackEnabled()) {
    try {
      const selector = getModelTierSelector();
      const modelSelection = selector.selectModel('COMPLEX', null);
      const decision = {
        provider: modelSelection.provider,
        model: modelSelection.model,
        tier: 'COMPLEX',
        method: 'risk',
        reason: 'high_risk_forced_tier',
        score: 100,
        risk,
      };
      routingMetrics.record(decision);
      logger.debug({
        tier: 'COMPLEX',
        provider: decision.provider,
        instructionHits: risk.instructionHits,
        pathHits: risk.pathHits,
      }, '[Routing] High risk → forcing tier');
      return decision;
    } catch (err) {
      logger.debug({ err: err.message }, '[Routing] Risk-forced tier selection failed, falling through');
    }
  }

  // Quick check for force patterns
  if (shouldForceLocal(payload)) {
    // When tier routing is enabled, respect TIER_SIMPLE instead of blindly choosing local
    if (config.modelTiers?.enabled) {
      try {
        const selector = getModelTierSelector();
        const modelSelection = selector.selectModel('SIMPLE', null);
        const decision = {
          provider: modelSelection.provider,
          model: modelSelection.model,
          tier: 'SIMPLE',
          method: 'force',
          reason: 'force_local_pattern',
          score: 0,
          risk,
        };
        routingMetrics.record(decision);
        return decision;
      } catch (err) {
        logger.debug({ err: err.message }, 'Tier selection failed for force_local, falling back to local provider');
      }
    }
    const provider = getBestLocalProvider();
    const decision = {
      provider,
      model: null,
      method: 'force',
      reason: 'force_local_pattern',
      score: 0,
      risk,
    };
    routingMetrics.record(decision);
    return decision;
  }

  if (shouldForceCloud(payload) && isFallbackEnabled()) {
    const provider = getBestCloudProvider();
    const decision = {
      provider,
      model: null,
      method: 'force',
      reason: 'force_cloud_pattern',
      score: 100,
      risk,
    };
    routingMetrics.record(decision);
    return decision;
  }

  // Full complexity analysis (pass workspace for code-graph integration)
  const useWeightedScoring = config.routing?.weightedScoring ?? false;
  const analysis = await analyzeComplexity(payload, { weighted: useWeightedScoring, workspace: options.workspace });

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

  // Agentic workflow detection
  let agenticResult = null;
  if (config.routing?.agenticDetection !== false) {
    try {
      const detector = getAgenticDetector();
      agenticResult = detector.detect(payload);

      // Boost complexity score for agentic workflows
      if (agenticResult.isAgentic) {
        analysis.score = Math.min(100, analysis.score + agenticResult.scoreBoost);
        analysis.agenticBoost = agenticResult.scoreBoost;
        analysis.agentType = agenticResult.agentType;

        logger.debug({
          agentType: agenticResult.agentType,
          boost: agenticResult.scoreBoost,
          newScore: analysis.score,
        }, '[Routing] Agentic workflow detected, boosting score');

        // Force cloud for autonomous workflows
        if (agenticResult.agentType === 'AUTONOMOUS' && isFallbackEnabled()) {
          const provider = getBestCloudProvider();
          const decision = {
            provider,
            method: 'agentic',
            reason: 'autonomous_workflow',
            score: analysis.score,
            agenticResult,
            risk,
          };
          routingMetrics.record(decision);
          return decision;
        }
      }
    } catch (err) {
      logger.debug({ err: err.message }, 'Agentic detection failed');
    }
  }

  // Tier-based model selection
  let selectedModel = null;
  let tier = null;
  if (config.modelTiers?.enabled) {
    try {
      const selector = getModelTierSelector();
      tier = selector.getTier(analysis.score);

      // Check if agentic detection requires a higher tier
      if (agenticResult?.minTier) {
        const agenticTierPriority = TIER_DEFINITIONS[agenticResult.minTier]?.priority || 0;
        const currentTierPriority = TIER_DEFINITIONS[tier]?.priority || 0;
        if (agenticTierPriority > currentTierPriority) {
          tier = agenticResult.minTier;
          logger.debug({ from: selector.getTier(analysis.score), to: tier }, '[Routing] Upgrading tier for agentic workflow');
        }
      }

      // Select model for the tier (will be applied after provider selection)
      analysis.tier = tier;
    } catch (err) {
      logger.debug({ err: err.message }, 'Tier selection failed');
    }
  }

  // Apply routing decision based on tier config (TIER_* env vars take precedence
  // but Phase 1.2 lets the cost-optimizer pick a cheaper qualifying model when safe).
  let provider;
  let method = 'tier_config';
  let costOptimized = false;

  const selector = getModelTierSelector();
  const modelSelection = selector.selectModel(tier, null);

  provider = modelSelection.provider;
  selectedModel = modelSelection.model;
  logger.debug({ tier, provider, model: selectedModel }, '[Routing] Using tier config');

  // Phase 1.2 — cost-optimizer override.
  // Only kick in when:
  //  - feature flag enabled (default true, disable with LYNKR_COST_OPTIMIZE=false)
  //  - risk level is not high (high-risk keeps the explicitly-configured model)
  //  - the optimizer finds a meaningfully cheaper qualifying model
  const costOptimizeEnabled = process.env.LYNKR_COST_OPTIMIZE !== 'false'
    && config.routing?.costOptimize !== false;
  if (costOptimizeEnabled && risk?.level !== 'high') {
    try {
      const optimizer = getCostOptimizer();
      const availableProviders = _enabledProviders();
      const cheapest = optimizer.findCheapestForTier(tier, availableProviders);
      if (cheapest && cheapest.model && cheapest.model !== selectedModel) {
        const current = optimizer.estimateCost(selectedModel, 1000);
        const candidate = optimizer.estimateCost(cheapest.model, 1000);
        if (candidate.totalEstimate > 0 && candidate.totalEstimate < current.totalEstimate * 0.75) {
          logger.debug({
            tier,
            from: `${provider}:${selectedModel}`,
            to: `${cheapest.provider}:${cheapest.model}`,
            savedPerK: (current.totalEstimate - candidate.totalEstimate).toFixed(6),
          }, '[Routing] Cost-optimizer override');
          provider = cheapest.provider;
          selectedModel = cheapest.model;
          method = 'tier_config+cost_optimized';
          costOptimized = true;
        }
      }
    } catch (err) {
      logger.debug({ err: err.message }, '[Routing] Cost-optimize failed, keeping tier_config selection');
    }
  }

  // Phase 1.3 — context window validation. If estimated tokens exceed the
  // selected model's context (with response headroom), escalate to a
  // context-capable model regardless of tier.
  try {
    const estimatedTokens = countPayloadTokens(payload, selectedModel);
    const ctxResult = contextValidator.validate(selectedModel, estimatedTokens);
    if (!ctxResult.ok) {
      const capable = selector.findContextCapable(estimatedTokens, tier);
      if (capable) {
        logger.info({
          from: `${provider}:${selectedModel}`,
          to: `${capable.provider}:${capable.model}`,
          required: estimatedTokens,
          oldContext: ctxResult.context,
          newContext: capable.context,
        }, '[Routing] Context window escalation');
        provider = capable.provider;
        selectedModel = capable.model;
        if (capable.tier) tier = capable.tier;
        method = method + '+context_escalated';
      } else {
        logger.warn({
          model: selectedModel,
          required: estimatedTokens,
          available: ctxResult.context,
        }, '[Routing] No context-capable fallback — request may fail upstream');
      }
    }
  } catch (err) {
    logger.debug({ err: err.message }, '[Routing] Context validation failed, proceeding without check');
  }

  const decision = {
    provider,
    model: selectedModel,
    tier,
    method,
    reason: analysis.recommendation,
    score: analysis.score,
    threshold: analysis.threshold,
    mode: analysis.mode,
    analysis,
    embeddingsResult,
    agenticResult,
    costOptimized,
    risk,
  };

  // Phase 3: Record metrics
  routingMetrics.record(decision);

  logger.debug(
    {
      provider,
      score: analysis.score,
      threshold: analysis.threshold,
      recommendation: analysis.recommendation,
      taskType: analysis.breakdown?.taskType?.reason,
      toolCount: payload?.tools?.length ?? 0,
    },
    'Smart routing decision'
  );

  return decision;
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

  // Tier and model headers
  if (decision.tier) {
    headers['X-Lynkr-Tier'] = decision.tier;
  }

  if (decision.model) {
    headers['X-Lynkr-Model'] = decision.model;
  }

  if (decision.agenticResult?.isAgentic) {
    headers['X-Lynkr-Agentic'] = decision.agenticResult.agentType;
  }

  if (decision.costOptimized) {
    headers['X-Lynkr-Cost-Optimized'] = 'true';
  }

  if (decision.risk?.level) {
    headers['X-Lynkr-Risk'] = decision.risk.level;
    const hits = Array.from(new Set([
      ...(decision.risk.instructionHits || []),
      ...(decision.risk.pathHits || []),
    ]));
    if (hits.length > 0) {
      // Header values are ASCII-only; comma-join the first few hits.
      headers['X-Lynkr-Risk-Hits'] = hits.slice(0, 8).join(',');
    }
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
  // Main routing function
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
  analyzeRisk,

  // Intelligent routing modules
  getAgenticDetector,
  getModelTierSelector,
  getCostOptimizer,
  AGENT_TYPES,
  TIER_DEFINITIONS,

  // Telemetry
  telemetry,
  scoreResponseQuality,
  getLatencyTracker,
};
