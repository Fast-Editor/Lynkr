/**
 * Shadow-mode policy A/B testing (Phase 4.4).
 *
 * Lets us test a new routing policy against production without serving its
 * decisions. The shadow policy runs alongside the active policy, makes its
 * decision, and that decision is logged. A weekly comparison job
 * (scripts/compare-policies.js) summarises agreement, cost delta, and (via
 * the regret estimator) projected quality delta on the disagreed-on subset.
 *
 * Activation:
 *   - Set LYNKR_SHADOW_POLICY=<name> to enable
 *   - Implement and register policies via registerPolicy()
 */

const fs = require('fs');
const path = require('path');
const logger = require('../logger');

const LOG_PATH = path.join(__dirname, '../../data/shadow-decisions.jsonl');

const _registry = new Map();

function registerPolicy(name, fn) {
  if (typeof fn !== 'function') throw new Error('Policy must be a function');
  _registry.set(name, fn);
}

function isEnabled() {
  return !!process.env.LYNKR_SHADOW_POLICY && _registry.has(process.env.LYNKR_SHADOW_POLICY);
}

function getShadowPolicy() {
  if (!isEnabled()) return null;
  return _registry.get(process.env.LYNKR_SHADOW_POLICY);
}

function _appendLog(entry) {
  try {
    fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
    fs.appendFileSync(LOG_PATH, JSON.stringify(entry) + '\n');
  } catch (err) {
    logger.debug({ err: err.message }, '[ShadowMode] Log append failed');
  }
}

/**
 * Compare active and shadow decisions on the same payload, log the result.
 * Does NOT change which decision is served — the caller uses activeDecision.
 */
async function compareAndLog({ payload, activeDecision, shadowFn }) {
  if (!shadowFn) return null;
  let shadowDecision;
  try {
    shadowDecision = await shadowFn(payload);
  } catch (err) {
    logger.debug({ err: err.message }, '[ShadowMode] Shadow policy failed');
    return null;
  }
  const agree = activeDecision.provider === shadowDecision?.provider
    && activeDecision.model === shadowDecision?.model;
  _appendLog({
    timestamp: Date.now(),
    policy: process.env.LYNKR_SHADOW_POLICY,
    agree,
    active: { provider: activeDecision.provider, model: activeDecision.model, tier: activeDecision.tier, score: activeDecision.score },
    shadow: shadowDecision ? { provider: shadowDecision.provider, model: shadowDecision.model, tier: shadowDecision.tier, score: shadowDecision.score } : null,
  });
  return { agree, shadow: shadowDecision };
}

module.exports = {
  registerPolicy,
  isEnabled,
  getShadowPolicy,
  compareAndLog,
  LOG_PATH,
};
