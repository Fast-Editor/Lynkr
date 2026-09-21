/**
 * Tier-driven model selection for the OAuth subscription passthrough.
 *
 * Context: when a picked tier resolves to `azure-anthropic` for a first-party
 * subscription client, src/api/router.js forwards the request byte-for-byte
 * to api.anthropic.com — serving whatever model the CLIENT chose. Tier picks
 * (COMPLEX/sonnet, REASONING/opus, force keywords) were computed and then
 * silently discarded, so escalation could never fire.
 *
 * This module decides the model the passthrough should ACTUALLY serve. The
 * subscription is not model-locked (the same OAuth token serves Haiku, Sonnet
 * and Opus), so rewriting `body.model` to a tier-configured Claude model is
 * accepted upstream. Only the `model` field is ever rewritten — messages,
 * tools, system prompt, thinking blocks and cache_control breakpoints pass
 * through verbatim, which is what keeps Anthropic's prefix cache usable
 * across the switch (same bytes, new model = one cold-prefix turn, then warm).
 *
 * Rules (first match wins):
 *   1. Kill-switch: LYNKR_PASSTHROUGH_MODEL_ROUTING=false → verbatim always.
 *   2. Side-channel tiers (suggestion/autocomplete/bare/drift frames routed to
 *      static SIMPLE) → verbatim. Never spend Opus on harness wrapper text.
 *   3. Unknown client model or unrankable tier model → verbatim (fail-closed).
 *   4. Tier model outranks client model → upgrade to the tier model. Upgrades
 *      always fire, even on a warm prefix — correctness beats one cold turn,
 *      same policy as the normal flow's hard triggers (cache-switch-cost.js
 *      scope: escalations are never gated).
 *   5. Pinned (previously served) model outranks client model → downgrade
 *      gate: hold the pin (pin_hold) ONLY while real warmth is at stake —
 *      cacheState present, fresh (not TTL-cold), recorded for this same
 *      model, and warmPrefixTokens >= HOLD_MIN_PREFIX_TOKENS (2000). Otherwise
 *      allow the downgrade (nothing warm worth protecting). This is the
 *      normal flow's break-even philosophy ported to a flat subscription:
 *      dollars can't justify holding (marginal cost is $0), but a large warm
 *      prefix is paid latency on every switch, so a large fresh one protects
 *      the pin while a cold/small/absent one doesn't.
 *   6. Otherwise → verbatim. A client that explicitly chose Opus keeps Opus
 *      even on a SIMPLE-scored turn.
 *
 * Pure functions, no I/O. Never throws.
 */

const FAMILY_RANK = [
  { re: /opus/i, rank: 3 },
  { re: /sonnet/i, rank: 2 },
  { re: /haiku/i, rank: 1 },
];

/**
 * Rank a Claude model id by family. Works on short aliases
 * (claude-sonnet-4-5), dated ids (claude-haiku-4-5-20251001) and
 * provider-prefixed forms. Returns null for anything unrecognized so
 * callers fail closed to verbatim passthrough.
 */
function familyRank(modelId) {
  if (!modelId || typeof modelId !== 'string') return null;
  for (const f of FAMILY_RANK) {
    if (f.re.test(modelId)) return f.rank;
  }
  return null;
}

function isRoutingEnabled() {
  // Default ON. Set LYNKR_PASSTHROUGH_MODEL_ROUTING=false to restore pure
  // byte-for-byte passthrough (pre-routing behavior).
  return process.env.LYNKR_PASSTHROUGH_MODEL_ROUTING !== 'false';
}

function isSideTier(tier) {
  if (!tier || typeof tier !== 'object') return false;
  return tier.pinned === false && String(tier.method || '').startsWith('side_request');
}

// Warm-prefix floor for the downgrade hold (rule 5). Deliberately a
// constant, not an env knob: one fewer dial, same protection. At/above this
// many warm tokens the pin holds across lower-scored turns; below it (or
// cold/absent/stale) the tier falls straight back.
const HOLD_MIN_PREFIX_TOKENS = 2000;

function holdMinPrefixTokens() {
  return HOLD_MIN_PREFIX_TOKENS;
}

/**
 * Resolve the effective tier model for dispatch (pure).
 *
 * A tier object can arrive with a weaker model than its label promises:
 * model-swapping overrides (kNN/bandit) keep the tier label while serving
 * cheaper, the no_user_messages fallback historically carried null, and
 * stale pins replay both shapes indefinitely. On the orchestrator path
 * those dynamics have dollar logic behind them; on the flat-fee
 * subscription passthrough a demotion saves $0 and only risks quality —
 * so here the label wins ties: effective model = max(tierModel,
 * configured(tier)) by family rank. Promotions (stronger-than-configured,
 * e.g. a held Opus on a COMPLEX tier) always survive.
 *
 * @param {object} args
 * @param {string|null} args.tierName - tier label ('COMPLEX', ...)
 * @param {string|null} args.tierModel - model carried on the tier object
 * @param {function|null} args.selectModelFn - (tier) => {model} | null
 * @returns {{model:string|null, resolved:boolean}} resolved=true when the
 *   configured model replaced the carried one.
 */
function resolveTierModel({ tierName = null, tierModel = null, selectModelFn = null } = {}) {
  try {
    let configured = null;
    try {
      configured = (typeof selectModelFn === 'function' && tierName)
        ? selectModelFn(tierName)?.model || null
        : null;
    } catch { configured = null; }
    const rT = familyRank(tierModel);
    const rC = familyRank(configured);
    if (rC !== null && (rT === null || rC > rT)) {
      return { model: configured, resolved: true };
    }
    return { model: tierModel ?? null, resolved: false };
  } catch {
    return { model: tierModel ?? null, resolved: false };
  }
}

/**
 * Downgrade gate (rule 5): is there enough live warmth to justify holding
 * the pinned model instead of following the fresh lower tier down?
 * Mirrors cache-switch-cost.js staleness/TTL handling: stale-model state,
 * TTL-cold state, absent state and small prefixes all allow the downgrade.
 */
function shouldHoldForCache(pinModel, cacheState) {
  if (!cacheState || typeof cacheState !== 'object') return null;
  if (cacheState.cold) return { hold: false, reason: 'downgrade_cache_cold' };
  if (cacheState.model && pinModel && cacheState.model !== pinModel) {
    return { hold: false, reason: 'downgrade_cache_stale' };
  }
  const warm = Number(cacheState.warmPrefixTokens) || 0;
  if (warm >= holdMinPrefixTokens()) {
    return { hold: true, reason: 'hold_upgraded_pin_warm', warmPrefixTokens: warm };
  }
  return { hold: false, reason: 'downgrade_prefix_small', warmPrefixTokens: warm };
}

/**
 * @param {object} args
 * @param {string|null} args.tierModel - model from the picked tier's config
 * @param {string|null} args.clientModel - req.body.model (what the client asked for)
 * @param {string|null} [args.pinModel] - model recorded on the session pin (previously served)
 * @param {string|null} [args.tierMethod] - tier.method (side-channel detection)
 * @param {boolean|null} [args.tierPinned] - tier.pinned flag
 * @param {object|null} [args.cacheState] - sessionAffinity.getCacheState(sessionId):
 *   {warmPrefixTokens, provider, model, lastRequestAt, ttlMs, cold} or null.
 *   Caller (router fork) loads it; kept out of here so this stays pure.
 * @returns {{model:string|null, action:'verbatim'|'upgrade'|'pin_hold', reason:string, warmPrefixTokens:number|null}}
 */
function decidePassthroughModel({ tierModel = null, clientModel = null, pinModel = null, tierMethod = null, tierPinned = null, cacheState = null } = {}) {
  try {
    if (!isRoutingEnabled()) {
      return { model: clientModel, action: 'verbatim', reason: 'routing_disabled', warmPrefixTokens: null };
    }
    if (isSideTier({ method: tierMethod, pinned: tierPinned })) {
      return { model: clientModel, action: 'verbatim', reason: 'side_request', warmPrefixTokens: null };
    }
    const clientRank = familyRank(clientModel);
    if (clientRank === null) {
      return { model: clientModel, action: 'verbatim', reason: 'unknown_client_model', warmPrefixTokens: null };
    }
    const tierRank = familyRank(tierModel);
    if (tierRank !== null && tierRank > clientRank) {
      return { model: tierModel, action: 'upgrade', reason: 'tier_outranks_client', warmPrefixTokens: null };
    }
    const pinRank = familyRank(pinModel);
    if (pinRank !== null && pinRank > clientRank) {
      const gate = shouldHoldForCache(pinModel, cacheState);
      if (gate && gate.hold) {
        return { model: pinModel, action: 'pin_hold', reason: gate.reason, warmPrefixTokens: gate.warmPrefixTokens ?? null };
      }
      return {
        model: clientModel,
        action: 'verbatim',
        reason: gate ? gate.reason : 'downgrade_no_cache_state',
        warmPrefixTokens: (gate && gate.warmPrefixTokens) ?? null,
      };
    }
    return { model: clientModel, action: 'verbatim', reason: 'no_upgrade', warmPrefixTokens: null };
  } catch {
    return { model: clientModel ?? null, action: 'verbatim', reason: 'error_fail_closed', warmPrefixTokens: null };
  }
}

module.exports = { familyRank, isRoutingEnabled, isSideTier,   decidePassthroughModel,
  resolveTierModel, shouldHoldForCache, holdMinPrefixTokens };
