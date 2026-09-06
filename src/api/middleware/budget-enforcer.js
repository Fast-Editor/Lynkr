/**
 * Budget enforcement middleware (Phase 6.2).
 *
 * Reads tenant/budget context from request headers, checks the hierarchical
 * budget ceiling, and rejects with 429 if exceeded.
 *
 * Header contract:
 *   LYNKR-Virtual-Key, LYNKR-Team-Id, LYNKR-Customer-Id, LYNKR-Org-Id
 */

const logger = require('../../logger');
const { getHierarchicalBudget } = require('../../budget/hierarchical-budget');

function _readContext(req) {
  const h = req.headers || {};
  return {
    virtual_key: h['lynkr-virtual-key'] || null,
    team: h['lynkr-team-id'] || null,
    customer: h['lynkr-customer-id'] || null,
    org: h['lynkr-org-id'] || null,
  };
}

// Default expected-output tokens when the caller didn't set max_tokens —
// same shape as LiteLLM's TPM floor: the estimate is soft admission control,
// trued up by the post-response recordSpend(), not a hard ceiling.
const DEFAULT_OUTPUT_TOKENS_ESTIMATE = 1024;

// Cached blended per-1k price across the configured tier models. Routing
// hasn't picked a model yet at middleware time, so the estimate prices at
// the average of what this install could plausibly serve. Refreshed every
// 60s (tier config can hot-reload).
let _priceCache = { at: 0, inputPer1k: 0, outputPer1k: 0 };
const PRICE_CACHE_TTL_MS = 60_000;

function _blendedTierPricing() {
  const now = Date.now();
  if (now - _priceCache.at < PRICE_CACHE_TTL_MS) return _priceCache;
  try {
    const { getModelTierSelector } = require('../../routing/model-tiers');
    const { getModelRegistrySync } = require('../../routing/model-registry');
    const registry = getModelRegistrySync && getModelRegistrySync();
    const models = getModelTierSelector().getAllConfiguredModels();
    let inputSum = 0;
    let outputSum = 0;
    let priced = 0;
    for (const m of models) {
      const cost = registry?.getCost?.(m.model);
      if (!cost || cost.unknown) continue;
      inputSum += cost.input ?? 0;
      outputSum += cost.output ?? 0;
      priced += 1;
    }
    _priceCache = {
      at: now,
      inputPer1k: priced > 0 ? inputSum / priced : 0,
      outputPer1k: priced > 0 ? outputSum / priced : 0,
    };
  } catch {
    _priceCache = { at: now, inputPer1k: 0, outputPer1k: 0 };
  }
  return _priceCache;
}

/**
 * Pre-flight cost estimate for a request that hasn't been routed yet:
 * estimated input tokens (4-chars≈1-token over system+tools+messages) plus
 * expected output (caller's max_tokens, else a floor), priced at the blended
 * average of the configured tier models. Falls back to a $0.01 nominal gate
 * when nothing is priceable — never LESS strict than the old behavior.
 *
 * @param {object} body — request payload
 * @returns {number} estimated USD cost
 */
function estimateRequestCost(body) {
  try {
    const { countPayloadTokens } = require('../../utils/tokens');
    const inputTokens = countPayloadTokens(body || {}).total || 0;
    const outputTokens = Math.min(
      typeof body?.max_tokens === 'number' && body.max_tokens > 0
        ? body.max_tokens
        : DEFAULT_OUTPUT_TOKENS_ESTIMATE,
      32_000,
    );
    const price = _blendedTierPricing();
    const est = (inputTokens / 1000) * price.inputPer1k
      + (outputTokens / 1000) * price.outputPer1k;
    // Floor at the old nominal $0.01 so free/unpriced configs still gate
    // exhausted accounts exactly as before.
    return Math.max(0.01, est);
  } catch {
    return 0.01;
  }
}

/**
 * Express middleware. Estimates request cost from the payload's token count
 * and blended tier pricing, and rejects if the budget would be exceeded.
 * Actual spend is recorded post-response (estimate → true-up pattern).
 */
function budgetEnforcer(req, res, next) {
  if (process.env.LYNKR_BUDGET_ENFORCER === 'false') return next();
  const context = _readContext(req);
  const budget = getHierarchicalBudget();
  const check = budget.check(context, estimateRequestCost(req.body));
  if (!check.ok) {
    logger.warn({ exceeded: check.exceeded }, '[BudgetEnforcer] Budget exceeded');
    return res.status(429).json({
      error: {
        type: 'budget_exceeded',
        message: `Budget exceeded for ${check.exceeded.level}=${check.exceeded.id}`,
        ...check.exceeded,
      },
    });
  }
  res.locals = res.locals || {};
  res.locals.budgetContext = context;
  next();
}

/**
 * Helper for handlers to record spend after a request completes.
 * Call this from the orchestrator with the actual cost.
 */
function recordSpend(context, amount) {
  if (!context) return;
  getHierarchicalBudget().record(context, amount);
}

module.exports = { budgetEnforcer, recordSpend, estimateRequestCost };
