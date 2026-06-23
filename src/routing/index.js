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
const { analyzeRisk } = require('./risk-classifier');

// Phase 3-6 routing modules
const { getKnnRouter } = require('./knn-router');
const { getBandit } = require('./bandit');
const { getShadowPolicy, compareAndLog: shadowCompareAndLog } = require('./shadow-mode');
const { chooseFastest } = require('./deadline');
const { applyTenantOverrides } = require('./tenant-policy');

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
 * Returns true when any message content block is an image.
 * Handles both string content and structured content arrays.
 */
function _payloadHasImages(payload) {
  const messages = payload?.messages;
  if (!Array.isArray(messages)) return false;
  return messages.some(msg => {
    const content = msg?.content;
    if (!Array.isArray(content)) return false;
    return content.some(block => block?.type === 'image' || block?.type === 'image_url');
  });
}

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
const sessionAffinity = require('./session-affinity');

/**
 * Provider routing with session affinity.
 *
 * When a conversation already carries tool history, reuse the provider the
 * session first routed to so tool-call IDs don't break across providers.
 * Fresh turns route normally and refresh the session's pinned provider.
 */
async function determineProviderSmart(payload, options = {}) {
  const sessionId = payload?._sessionId || null;

  // Enforce affinity only for in-flight tool exchanges — the turns that 400
  // if the provider changes. Fresh turns keep full per-turn tier routing.
  if (sessionId && !options.forceProvider && sessionAffinity.payloadHasToolHistory(payload)) {
    const pinned = sessionAffinity.getPinned(sessionId);
    if (pinned) {
      logger.debug({ sessionId, provider: pinned.provider, tier: pinned.tier },
        '[Routing] Session affinity — reusing provider for tool-bearing turn');
      return {
        provider: pinned.provider,
        model: pinned.model,
        tier: pinned.tier,
        method: 'session_affinity',
        reason: 'tool_history_provider_pin',
      };
    }
  }

  const decision = await _determineProviderSmartInner(payload, options);

  // Remember the chosen provider so later tool-bearing turns stay consistent.
  if (sessionId && decision?.provider && !options.forceProvider) {
    sessionAffinity.setPinned(sessionId, decision);
  }

  return decision;
}

async function _determineProviderSmartInner(payload, options = {}) {
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

  // Phase 1.4 — vision capability guard.
  // If the payload contains image content blocks but the selected model lacks
  // vision support, silently swap to the cheapest vision-capable model at or
  // above the current tier. Prevents silent upstream failures.
  if (_payloadHasImages(payload)) {
    try {
      const { getModelRegistrySync } = require('./model-registry');
      const registry = getModelRegistrySync();
      const modelInfo = registry.getCost(selectedModel);
      if (!modelInfo?.vision) {
        const visionModel = selector.findVisionCapable(tier);
        if (visionModel) {
          logger.info({
            from: `${provider}:${selectedModel}`,
            to: `${visionModel.provider}:${visionModel.model}`,
            tier: visionModel.tier,
          }, '[Routing] Vision guard — upgrading to vision-capable model');
          provider = visionModel.provider;
          selectedModel = visionModel.model;
          if (visionModel.tier !== tier) tier = visionModel.tier;
          method = method + '+vision_guard';
        } else {
          logger.warn({ model: selectedModel }, '[Routing] Vision guard — no vision-capable model found, request may fail');
        }
      }
    } catch (err) {
      logger.debug({ err: err.message }, '[Routing] Vision guard check failed, proceeding');
    }
  }

  // Phase 3.1 — kNN routing hint.
  // If the index has enough entries, query it with the last user message.
  // A high-confidence kNN suggestion overrides the heuristic selection.
  let knnResult = null;
  if (config.routing?.knnEnabled !== false) {
    try {
      const msgs = payload?.messages;
      const lastMsg = Array.isArray(msgs) ? msgs[msgs.length - 1]?.content : null;
      const queryText = typeof lastMsg === 'string' ? lastMsg
        : Array.isArray(lastMsg) ? lastMsg.filter(b => b?.type === 'text').map(b => b.text || '').join(' ')
        : null;
      if (queryText) {
        knnResult = await getKnnRouter().query(queryText);
        if (knnResult && knnResult.confidence > 0.7 && knnResult.model && knnResult.model !== selectedModel) {
          // High confidence — trust kNN's model recommendation directly.
          logger.debug({
            from: `${provider}:${selectedModel}`,
            to: `${knnResult.provider}:${knnResult.model}`,
            confidence: knnResult.confidence.toFixed(3),
          }, '[Routing] kNN override');
          provider = knnResult.provider;
          selectedModel = knnResult.model;
          method = method + '+knn';
        } else if (knnResult && knnResult.confidence > 0.4 && knnResult.confidence <= 0.7) {
          // Ambiguous signal — neighbors are split, we can't trust any single model
          // recommendation. Err on quality: bump the current tier one step up so the
          // request gets a more capable model rather than risking a bad answer from
          // a model that was borderline for similar past requests.
          const TIER_ORDER = ['SIMPLE', 'MEDIUM', 'COMPLEX', 'REASONING'];
          const currentIdx = TIER_ORDER.indexOf(tier);
          if (currentIdx >= 0 && currentIdx < TIER_ORDER.length - 1) {
            const upgradedTier = TIER_ORDER[currentIdx + 1];
            try {
              const upgraded = selector.selectModel(upgradedTier, null);
              logger.debug({
                from: `${tier}:${provider}:${selectedModel}`,
                to: `${upgradedTier}:${upgraded.provider}:${upgraded.model}`,
                confidence: knnResult.confidence.toFixed(3),
              }, '[Routing] kNN ambiguous — escalating tier for safety');
              provider = upgraded.provider;
              selectedModel = upgraded.model;
              tier = upgradedTier;
              method = method + '+knn_ambiguous_escalate';
            } catch (err) {
              logger.debug({ err: err.message }, '[Routing] kNN ambiguous escalation failed, keeping current tier');
            }
          }
        }
      }
    } catch (err) {
      logger.debug({ err: err.message }, '[Routing] kNN query failed, ignoring');
    }
  }

  // Phase 4.1 — LinUCB bandit intra-tier selection.
  // When there are two candidates (heuristic vs kNN), the bandit picks the
  // one with the highest estimated UCB score for the current context.
  if (config.routing?.banditEnabled !== false && knnResult && knnResult.model) {
    try {
      // Build candidates: current selection and kNN alternative if different
      const allCandidates = [{ provider, model: selectedModel }];
      if (knnResult.model !== selectedModel) {
        allCandidates.push({ provider: knnResult.provider, model: knnResult.model });
      }

      if (allCandidates.length > 1) {
        const bandit = getBandit();
        const TASK_TYPES = ['code_gen', 'summarization', 'reasoning', 'factoid', 'chat', 'other'];
        const inferredTask = (analysis.breakdown?.taskType?.reason || 'other').toLowerCase();
        const taskIdx = Math.max(0, TASK_TYPES.findIndex(t => inferredTask.includes(t)));
        const ctx = [
          (analysis.score || 0) / 100,
          Math.log(Math.max(1, analysis.breakdown?.tokenCount || 0) + 1) / 15,
          ((payload?.tools?.length ?? 0) > 0) ? 1 : 0,
          options.streaming ? 1 : 0,
          risk?.level === 'high' ? 1 : risk?.level === 'medium' ? 0.5 : 0,
          agenticResult?.isAgentic ? 1 : 0,
          ...TASK_TYPES.map((_, i) => i === taskIdx ? 1 : 0),
        ];
        const picked = bandit.pick(tier, allCandidates, ctx);
        if (picked && picked.model !== selectedModel) {
          logger.debug({
            from: `${provider}:${selectedModel}`,
            to: `${picked.provider}:${picked.model}`,
            ucb: picked.ucb?.toFixed(4),
            explored: picked.explored,
          }, '[Routing] Bandit override');
          provider = picked.provider;
          selectedModel = picked.model;
          method = method + (picked.explored ? '+bandit_explore' : '+bandit');
        }
      }
    } catch (err) {
      logger.debug({ err: err.message }, '[Routing] Bandit pick failed, ignoring');
    }
  }

  // Phase 6.3 — deadline-aware fastest-model selection.
  // Payload carries _deadlineMs injected by the orchestrator from the
  // LYNKR-Deadline-Ms request header.
  const deadlineMs = payload?._deadlineMs ?? null;
  if (deadlineMs) {
    try {
      const fastest = chooseFastest([{ provider, model: selectedModel }], deadlineMs);
      if (fastest && fastest.model !== selectedModel) {
        logger.debug({
          from: `${provider}:${selectedModel}`,
          to: `${fastest.provider}:${fastest.model}`,
          deadlineMs,
        }, '[Routing] Deadline override');
        provider = fastest.provider;
        selectedModel = fastest.model;
        method = method + '+deadline';
      }
    } catch (err) {
      logger.debug({ err: err.message }, '[Routing] Deadline check failed, ignoring');
    }
  }

  // Phase 6.1 — per-tenant policy overrides.
  // tenantPolicy comes from options (threaded from Express res.locals via
  // orchestrator → databricks → here).
  if (options.tenantPolicy) {
    try {
      const overridden = applyTenantOverrides(
        { provider, model: selectedModel, tier, method },
        options.tenantPolicy,
      );
      if (overridden && overridden.model !== selectedModel) {
        logger.debug({
          from: `${provider}:${selectedModel}`,
          to: `${overridden.provider}:${overridden.model}`,
        }, '[Routing] Tenant override');
        provider = overridden.provider;
        selectedModel = overridden.model;
        method = overridden.method;
      }
    } catch (err) {
      logger.debug({ err: err.message }, '[Routing] Tenant override failed, ignoring');
    }
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
    knnResult,
  };

  // Phase 4.4 — shadow-mode policy comparison (fire-and-forget).
  const shadowFn = getShadowPolicy();
  if (shadowFn) {
    setImmediate(() =>
      shadowCompareAndLog({ payload, activeDecision: decision, shadowFn }).catch(() => {})
    );
  }

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

  // Tier-aware fallback surfacing (never silent).
  if (decision.fallback) {
    headers['X-Lynkr-Fallback'] = 'true';
    if (decision.fromTier) headers['X-Lynkr-Fallback-From-Tier'] = decision.fromTier;
    if (decision.servedTier) headers['X-Lynkr-Served-Tier'] = decision.servedTier;
    if (decision.fallbackDirection) headers['X-Lynkr-Fallback-Direction'] = decision.fallbackDirection;
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

  // Phase 3-6 modules
  getKnnRouter,
  getBandit,
  getShadowPolicy,
  shadowCompareAndLog,
  chooseFastest,
  applyTenantOverrides,

  // Telemetry
  telemetry,
  scoreResponseQuality,
  getLatencyTracker,
};
