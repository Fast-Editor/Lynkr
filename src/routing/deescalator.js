/**
 * De-escalation policy (WS2.3).
 *
 * The routing pipeline today only ratchets *up* — risk / agentic minTier /
 * context / vision / kNN-ambiguous all escalate; nothing ever demotes. That
 * means once a request_type has been escalated for ANY reason (even a
 * one-off), it stays over-provisioned forever.
 *
 * This module supplies the missing signal: for a given (tier, request_type),
 * has the *lower* tier historically served ≥ N similar requests at quality
 * ≥ Q with error rate < E? If yes, the caller may demote — cheaper AND
 * evidence-backed.
 *
 * The check is a plain SELECT against routing_telemetry (cached 60s) so
 * enabling it in-line does not add DB pressure at request rate.
 *
 * @module routing/deescalator
 */

const logger = require('../logger');
const telemetry = require('./telemetry');

const TIER_ORDER = ['SIMPLE', 'MEDIUM', 'COMPLEX', 'REASONING'];

// Fixed thresholds. Chosen conservatively so a demotion only fires when the
// lower tier has demonstrable evidence: a full-week window, a meaningful
// sample count, high average quality, and a low error rate.
const MIN_SAMPLES = 30;
const MIN_QUALITY = 70;
const MAX_ERROR_RATE = 0.05;
const WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const CACHE_TTL_MS = 60 * 1000;

/** @type {Map<string, {value: string|null, ts: number}>} */
const _cache = new Map();

function _cacheKey(tier, requestType) {
  return `${tier}::${requestType || '<none>'}`;
}

function _lowerTier(tier) {
  const idx = TIER_ORDER.indexOf(tier);
  if (idx <= 0) return null;
  return TIER_ORDER[idx - 1];
}

/**
 * Return the demoted tier if evidence supports it; null otherwise.
 *
 * @param {Object} args
 * @param {string} args.tier - The tier the router currently plans to serve.
 * @param {string|null} args.requestType - Complexity analyzer's request_type.
 * @param {Object} [args.analysis] - Passed through for callers that want it;
 *   currently unused by the rule, kept for signature stability.
 * @param {Object} [args.deps] - Test-injectable dependencies.
 * @param {Function} [args.deps.getQualityByTierAndType] - Override the telemetry query.
 * @param {Function} [args.deps.now] - Override Date.now() for tests.
 * @returns {string|null} The lower tier, or null if demotion is not warranted.
 */
function suggestDemotion({ tier, requestType, analysis, deps = {} } = {}) {
  if (!tier || !requestType) return null;
  const lower = _lowerTier(tier);
  if (!lower) return null;

  const now = typeof deps.now === 'function' ? deps.now() : Date.now();
  const key = _cacheKey(tier, requestType);
  const cached = _cache.get(key);
  if (cached && now - cached.ts < CACHE_TTL_MS) {
    return cached.value;
  }

  const query = deps.getQualityByTierAndType || telemetry.getQualityByTierAndType;
  if (typeof query !== 'function') return null;

  let rows = null;
  try {
    rows = query({
      since: now - WINDOW_MS,
      until: now,
      tiers: [lower],
    });
  } catch (err) {
    logger.debug({ err: err.message }, '[Deescalator] telemetry query failed');
    return null;
  }

  const match = Array.isArray(rows)
    ? rows.find((r) => r.tier === lower && r.request_type === requestType)
    : null;

  const ok = match
    && match.count >= MIN_SAMPLES
    && (match.avg_quality ?? 0) >= MIN_QUALITY
    && (match.error_rate ?? 1) < MAX_ERROR_RATE;

  const value = ok ? lower : null;
  _cache.set(key, { value, ts: now });
  return value;
}

/** Test helper — clear the memoized decisions. */
function _clearCache() {
  _cache.clear();
}

/**
 * Shadow-mode policy. Wraps the live routing decision by delegating to
 * `determineProviderSmart` and then applying `suggestDemotion` on the result.
 * Registered with shadow-mode.js under name 'deescalate-v1' so operators can
 * evaluate the projected cost/quality delta before enabling live demotion.
 */
async function shadowDeescalate(payload) {
  // Late require to avoid the circular src/routing/index.js ↔ deescalator.js
  // reference (index.js registers the shadow policy at module load).
  const { determineProviderSmart } = require('./index');
  const base = await determineProviderSmart(payload, { _shadow: true });
  if (!base?.tier) return base;
  const requestType = base?.analysis?.breakdown?.taskType?.reason
    ?? base?.analysis?.taskType
    ?? null;
  const demoted = suggestDemotion({
    tier: base.tier,
    requestType,
    analysis: base.analysis,
  });
  if (!demoted) return base;
  try {
    const { getModelTierSelector } = require('./model-tiers');
    const selected = getModelTierSelector().selectModel(demoted, null);
    return {
      ...base,
      provider: selected.provider,
      model: selected.model,
      tier: demoted,
      method: (base.method || 'tier_config') + '+deescalated_shadow',
      _shadowDemotedFrom: base.tier,
    };
  } catch {
    return base;
  }
}

module.exports = {
  suggestDemotion,
  shadowDeescalate,
  TIER_ORDER,
  _clearCache,
};
