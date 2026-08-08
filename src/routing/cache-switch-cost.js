/**
 * Switch-cost break-even model (Phase 3, cache-aware routing).
 *
 * Answers one question for a session that holds a warm prompt-cache prefix
 * on its pinned model: does switching to a cheaper target model pay for the
 * cache it breaks, within the turns this session is expected to have left?
 *
 *   stayPerTurn    = warm*cacheRead(cur) + new*input(cur) + out*output(cur)
 *   switchOnce     = (warm + new) * cacheWrite(target)     // one-time
 *   switchPerTurn  = warm*cacheRead(tgt) + new*input(tgt) + out*output(tgt)
 *   breakEvenTurns = switchOnce / (stayPerTurn - switchPerTurn)
 *
 * Switch iff breakEvenTurns <= expectedRemainingTurns.
 *
 * The output-token term is deliberately included: for de-escalation the
 * dominant per-turn saving is often the output-price spread (e.g. Opus $25/M
 * vs Haiku $5/M out), and omitting it makes the router hold expensive pins
 * long past the point the economics justify.
 *
 * Scope: this module prices COST-MOTIVATED switches (de-escalator, bandit
 * exploration, economic downgrades). Hard triggers — risk keywords, force
 * phrases, context overflow, vision, upward drift — are never gated here;
 * correctness beats cost and the math can never favor a pricier model anyway
 * (savings would be negative).
 *
 * Local models have no dollar cost; the price of a cold prefix is prefill
 * latency, so a warm local prefix above a size threshold holds the pin.
 *
 * All pricing comes from cache-economics.js (registry-first, provider
 * fallback) — no per-model numbers live in this file.
 *
 * @module routing/cache-switch-cost
 */

const config = require('../config');
const logger = require('../logger');

const PER_TOKEN = 1 / 1_000_000; // registry prices are USD per 1M tokens

function _cfg() {
  const c = config.routing?.cacheAware || {};
  return {
    enabled: c.enabled !== false,
    defaultRemainingTurns: c.defaultRemainingTurns ?? 10,
    newTokensPerTurn: c.newTokensPerTurn ?? 2000,
    outputTokensPerTurn: c.outputTokensPerTurn ?? 800,
    localMaxSwitchPrefixTokens: c.localMaxSwitchPrefixTokens ?? 16000,
  };
}

/**
 * Evaluate whether a cost-motivated switch away from the session's warm
 * prefix should be allowed.
 *
 * @param {Object} args
 * @param {Object|null} args.cacheState - from sessionAffinity.getCacheState:
 *   {warmPrefixTokens, provider, model, lastRequestAt, ttlMs, cold} or null.
 * @param {{provider:string, model:string|null}} args.current - pinned target.
 * @param {{provider:string, model:string|null}} args.target - proposed target.
 * @param {number} [args.newTokensPerTurn] - est. fresh input tokens per turn.
 * @param {number} [args.outputTokensPerTurn] - est. output tokens per turn.
 * @param {number|null} [args.expectedRemainingTurns] - median remaining
 *   turns; falls back to the conservative config default when null.
 * @param {Object} [args.deps] - test injection: {resolveCacheEconomics}.
 * @returns {{
 *   switchAllowed: boolean,
 *   reason: string,
 *   breakEvenTurns: number|null,
 *   expectedRemainingTurns: number,
 *   warmPrefixTokens: number,
 *   switchOnceUsd: number|null,
 *   stayPerTurnUsd: number|null,
 *   switchPerTurnUsd: number|null,
 *   projectedStaySavingsUsd: number|null,
 * }}
 */
function evaluateSwitch({
  cacheState,
  current,
  target,
  newTokensPerTurn,
  outputTokensPerTurn,
  expectedRemainingTurns,
  deps = {},
} = {}) {
  const cfg = _cfg();
  const remaining = Number.isFinite(expectedRemainingTurns) && expectedRemainingTurns > 0
    ? expectedRemainingTurns
    : cfg.defaultRemainingTurns;

  const base = {
    switchAllowed: true,
    reason: 'no_cache_state',
    breakEvenTurns: null,
    expectedRemainingTurns: remaining,
    warmPrefixTokens: cacheState?.warmPrefixTokens ?? 0,
    switchOnceUsd: null,
    stayPerTurnUsd: null,
    switchPerTurnUsd: null,
    projectedStaySavingsUsd: null,
  };

  if (!cfg.enabled) return { ...base, reason: 'feature_disabled' };
  if (!current?.provider || !target?.provider) return base;
  if (current.provider === target.provider && current.model === target.model) {
    return { ...base, reason: 'same_model' };
  }

  // No tracked state → nothing warm to protect (provider reports no cache
  // usage, or no response seen yet). Switching is cache-free.
  if (!cacheState || !(cacheState.warmPrefixTokens > 0)) return base;

  // State recorded for a different model than the pin we're defending —
  // stale after a prior switch; treat as no protection.
  if (cacheState.model && current.model && cacheState.model !== current.model) {
    return { ...base, reason: 'stale_cache_state' };
  }

  // Phase 2 — TTL clock. Anthropic-style caches refresh on every read, so
  // lastRequestAt + ttlMs going stale means the prefix is already cold and
  // the switch costs nothing extra.
  if (cacheState.cold) return { ...base, reason: 'cache_cold' };

  let resolve = deps.resolveCacheEconomics;
  if (typeof resolve !== 'function') {
    ({ resolveCacheEconomics: resolve } = require('./cache-economics'));
  }

  const econCur = resolve(current.provider, current.model);
  const econTgt = resolve(target.provider, target.model);

  const W = cacheState.warmPrefixTokens;
  const N = Number.isFinite(newTokensPerTurn) && newTokensPerTurn >= 0
    ? newTokensPerTurn : cfg.newTokensPerTurn;
  const O = Number.isFinite(outputTokensPerTurn) && outputTokensPerTurn >= 0
    ? outputTokensPerTurn : cfg.outputTokensPerTurn;

  // Local pin: no dollars in either column — the cost of abandoning the
  // warm prefix is prefill latency on whatever serves the next turn.
  // Hold while the prefix is large; small prefixes re-fill fast enough.
  if (econCur.mechanism === 'local' && econTgt.mechanism === 'local') {
    const allowed = W <= cfg.localMaxSwitchPrefixTokens;
    return {
      ...base,
      switchAllowed: allowed,
      reason: allowed ? 'local_prefix_small' : 'local_prefill_hold',
    };
  }

  const stayPerTurn = (W * econCur.cacheReadPerM + N * econCur.inputPerM + O * econCur.outputPerM) * PER_TOKEN;
  const switchOnce = (W + N) * econTgt.cacheWritePerM * PER_TOKEN;
  const switchPerTurn = (W * econTgt.cacheReadPerM + N * econTgt.inputPerM + O * econTgt.outputPerM) * PER_TOKEN;
  const savingsPerTurn = stayPerTurn - switchPerTurn;

  const priced = {
    ...base,
    switchOnceUsd: switchOnce,
    stayPerTurnUsd: stayPerTurn,
    switchPerTurnUsd: switchPerTurn,
    projectedStaySavingsUsd: savingsPerTurn,
  };

  // Switching to a same-or-more-expensive target never pays on economics.
  // (Escalations don't route through this gate, so blocking is safe.)
  if (savingsPerTurn <= 0) {
    return {
      ...priced,
      switchAllowed: false,
      reason: 'never_profitable',
      breakEvenTurns: Infinity,
    };
  }

  const breakEvenTurns = switchOnce / savingsPerTurn;
  const allowed = breakEvenTurns <= remaining;

  logger.debug({
    current: `${current.provider}:${current.model}`,
    target: `${target.provider}:${target.model}`,
    warmPrefixTokens: W,
    breakEvenTurns: Number(breakEvenTurns.toFixed(2)),
    expectedRemainingTurns: remaining,
    allowed,
  }, '[CacheSwitchCost] break-even evaluated');

  return {
    ...priced,
    switchAllowed: allowed,
    reason: allowed ? 'break_even_cleared' : 'break_even_blocked',
    breakEvenTurns,
  };
}

module.exports = { evaluateSwitch };
