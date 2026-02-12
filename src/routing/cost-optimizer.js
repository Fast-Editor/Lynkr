/**
 * Cost Optimizer Module
 * Tracks and optimizes LLM costs across providers
 * Uses ModelRegistry for dynamic pricing data
 */

const logger = require('../logger');
const config = require('../config');
const { getModelRegistry, getModelRegistrySync } = require('./model-registry');
const { getModelTierSelector, TIER_DEFINITIONS } = require('./model-tiers');

// Session cost tracking (in-memory)
const sessionCosts = new Map(); // sessionId -> { total, requests, byModel, byProvider }

// Global stats
const globalStats = {
  totalCost: 0,
  totalSavings: 0,
  requestCount: 0,
  byProvider: {},
  byTier: {},
};

class CostOptimizer {
  constructor() {
    this.registry = null;
    this.tierSelector = null;
  }

  /**
   * Initialize with registry (async)
   */
  async initialize() {
    this.registry = await getModelRegistry();
    this.tierSelector = getModelTierSelector();
  }

  /**
   * Get registry (sync fallback)
   */
  _getRegistry() {
    if (!this.registry) {
      this.registry = getModelRegistrySync();
    }
    return this.registry;
  }

  /**
   * Get tier selector
   */
  _getTierSelector() {
    if (!this.tierSelector) {
      this.tierSelector = getModelTierSelector();
    }
    return this.tierSelector;
  }

  /**
   * Estimate cost for a request before sending
   * @param {string} model - Model name
   * @param {number} inputTokens - Estimated input tokens
   * @param {number} outputTokens - Estimated output tokens (optional)
   * @returns {Object} Cost estimate
   */
  estimateCost(model, inputTokens, outputTokens = null) {
    const registry = this._getRegistry();
    const costs = registry.getCost(model);

    const inputCost = (inputTokens / 1_000_000) * costs.input;
    const estimatedOutputTokens = outputTokens || Math.min(inputTokens * 0.5, 4096);
    const outputCost = (estimatedOutputTokens / 1_000_000) * costs.output;

    return {
      inputCost: Math.round(inputCost * 1_000_000) / 1_000_000,
      outputCost: Math.round(outputCost * 1_000_000) / 1_000_000,
      totalEstimate: Math.round((inputCost + outputCost) * 1_000_000) / 1_000_000,
      model,
      inputTokens,
      outputTokens: estimatedOutputTokens,
      pricePerMillion: {
        input: costs.input,
        output: costs.output,
      },
      source: costs.source,
    };
  }

  /**
   * Find cheapest model capable of handling a complexity tier
   * @param {string} requiredTier - Minimum tier required
   * @param {string[]} availableProviders - Providers to consider
   * @returns {Object|null} Cheapest model info
   */
  findCheapestForTier(requiredTier, availableProviders) {
    const registry = this._getRegistry();
    const tierSelector = this._getTierSelector();

    const tierOrder = ['SIMPLE', 'MEDIUM', 'COMPLEX', 'REASONING'];
    const minTierIndex = tierOrder.indexOf(requiredTier);

    if (minTierIndex === -1) {
      logger.warn({ tier: requiredTier }, '[CostOptimizer] Unknown tier');
      return null;
    }

    const candidates = [];

    // Collect models from all capable tiers (>= required tier)
    for (let i = minTierIndex; i < tierOrder.length; i++) {
      const tier = tierOrder[i];

      for (const provider of availableProviders) {
        const models = tierSelector.getPreferredModels(tier, provider);

        for (const model of models) {
          const cost = registry.getCost(model);
          const totalCost = cost.input + cost.output; // Simple cost metric

          candidates.push({
            model,
            provider,
            tier,
            inputCost: cost.input,
            outputCost: cost.output,
            totalCost,
            context: cost.context,
            source: cost.source,
          });
        }
      }
    }

    if (candidates.length === 0) {
      return null;
    }

    // Sort by total cost (input + output per 1M tokens)
    candidates.sort((a, b) => a.totalCost - b.totalCost);

    const cheapest = candidates[0];

    logger.debug({
      requiredTier,
      selectedModel: cheapest.model,
      selectedProvider: cheapest.provider,
      cost: cheapest.totalCost,
      candidateCount: candidates.length,
    }, '[CostOptimizer] Found cheapest model');

    return cheapest;
  }

  /**
   * Record actual cost after response
   * @param {string} sessionId - Session identifier
   * @param {string} provider - Provider used
   * @param {string} model - Model used
   * @param {number} inputTokens - Actual input tokens
   * @param {number} outputTokens - Actual output tokens
   * @param {string} tier - Complexity tier
   * @returns {number} Actual cost
   */
  recordCost(sessionId, provider, model, inputTokens, outputTokens, tier = 'MEDIUM') {
    const registry = this._getRegistry();
    const costs = registry.getCost(model);

    const inputCost = (inputTokens / 1_000_000) * costs.input;
    const outputCost = (outputTokens / 1_000_000) * costs.output;
    const actualCost = inputCost + outputCost;

    // Update session costs
    if (sessionId) {
      if (!sessionCosts.has(sessionId)) {
        sessionCosts.set(sessionId, {
          total: 0,
          requests: 0,
          byModel: {},
          byProvider: {},
          byTier: {},
        });
      }

      const session = sessionCosts.get(sessionId);
      session.total += actualCost;
      session.requests++;
      session.byModel[model] = (session.byModel[model] || 0) + actualCost;
      session.byProvider[provider] = (session.byProvider[provider] || 0) + actualCost;
      session.byTier[tier] = (session.byTier[tier] || 0) + actualCost;
    }

    // Update global stats
    globalStats.totalCost += actualCost;
    globalStats.requestCount++;
    globalStats.byProvider[provider] = (globalStats.byProvider[provider] || 0) + actualCost;
    globalStats.byTier[tier] = (globalStats.byTier[tier] || 0) + actualCost;

    logger.debug({
      sessionId,
      provider,
      model,
      inputTokens,
      outputTokens,
      cost: actualCost.toFixed(6),
      tier,
    }, '[CostOptimizer] Recorded cost');

    return actualCost;
  }

  /**
   * Calculate potential savings from routing optimization
   */
  calculateSavings(originalModel, optimizedModel, tokens) {
    const registry = this._getRegistry();

    const originalCost = registry.getCost(originalModel);
    const optimizedCost = registry.getCost(optimizedModel);

    const originalTotal = (tokens / 1_000_000) * (originalCost.input + originalCost.output);
    const optimizedTotal = (tokens / 1_000_000) * (optimizedCost.input + optimizedCost.output);

    const savings = originalTotal - optimizedTotal;

    if (savings > 0) {
      globalStats.totalSavings += savings;
    }

    return {
      originalCost: originalTotal,
      optimizedCost: optimizedTotal,
      savings: Math.max(0, savings),
      percentSaved: originalTotal > 0 ? (savings / originalTotal) * 100 : 0,
    };
  }


  /**
   * Get session cost summary
   */
  getSessionCost(sessionId) {
    return sessionCosts.get(sessionId) || {
      total: 0,
      requests: 0,
      byModel: {},
      byProvider: {},
      byTier: {},
    };
  }

  /**
   * Get global stats
   */
  getStats() {
    return {
      ...globalStats,
      sessionCount: sessionCosts.size,
      avgCostPerRequest: globalStats.requestCount > 0
        ? (globalStats.totalCost / globalStats.requestCount).toFixed(6)
        : '0',
      totalCostFormatted: `$${globalStats.totalCost.toFixed(4)}`,
      totalSavingsFormatted: `$${globalStats.totalSavings.toFixed(4)}`,
    };
  }

  /**
   * Clear session data (for cleanup)
   */
  clearSession(sessionId) {
    sessionCosts.delete(sessionId);
  }

  /**
   * Reset all stats (for testing)
   */
  resetStats() {
    sessionCosts.clear();
    globalStats.totalCost = 0;
    globalStats.totalSavings = 0;
    globalStats.requestCount = 0;
    globalStats.byProvider = {};
    globalStats.byTier = {};
  }
}

// Singleton instance
let instance = null;

function getCostOptimizer() {
  if (!instance) {
    instance = new CostOptimizer();
  }
  return instance;
}

async function getCostOptimizerAsync() {
  const optimizer = getCostOptimizer();
  await optimizer.initialize();
  return optimizer;
}

module.exports = {
  CostOptimizer,
  getCostOptimizer,
  getCostOptimizerAsync,
};
