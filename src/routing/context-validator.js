/**
 * Context-window validation for routed models.
 *
 * After tier selection, verifies the chosen model can hold the estimated
 * input tokens (plus response headroom). When it can't, callers should
 * escalate to a context-capable model.
 *
 * Phase 1.3 of the routing overhaul.
 *
 * @module routing/context-validator
 */

const logger = require('../logger');
const { getModelRegistrySync } = require('./model-registry');

/** Fraction of the context window reserved for the prompt (rest left for response). */
const HEADROOM_FRACTION = 0.85;

function getContextLimit(model) {
  if (!model) return null;
  try {
    const registry = getModelRegistrySync();
    const cost = registry.getCost(model);
    return cost?.context || null;
  } catch (err) {
    return null;
  }
}

/**
 * Quick yes/no fit check.
 * Unknown context windows return true (assume fits — we don't have data to reject).
 */
function fits(model, estimatedTokens, fraction = HEADROOM_FRACTION) {
  const ctx = getContextLimit(model);
  if (!ctx) return true;
  return estimatedTokens <= ctx * fraction;
}

/**
 * Detailed validation result.
 * @returns {{ ok: boolean, context: number|null, required: number, limit: number|null, reason?: string }}
 */
function validate(model, estimatedTokens) {
  const ctx = getContextLimit(model);
  if (!ctx) {
    return {
      ok: true,
      reason: 'unknown_context',
      context: null,
      required: estimatedTokens,
      limit: null,
    };
  }
  const limit = Math.floor(ctx * HEADROOM_FRACTION);
  if (estimatedTokens <= limit) {
    return { ok: true, context: ctx, required: estimatedTokens, limit };
  }
  logger.debug(
    { model, context: ctx, required: estimatedTokens, limit },
    '[ContextValidator] Estimated tokens exceed model context'
  );
  return { ok: false, context: ctx, required: estimatedTokens, limit };
}

module.exports = {
  validate,
  fits,
  getContextLimit,
  HEADROOM_FRACTION,
};
