/**
 * Tier-aware fallback chain (escalate-then-demote).
 *
 * When a tier's provider fails, prefer a MORE capable tier first (climb toward
 * REASONING), and only if every higher tier is also unavailable do we fall
 * downward — all the way to the local SIMPLE tier as a last resort. This biases
 * for correctness/availability over cost, matching a conservative routing policy.
 *
 * Example ladder: SIMPLE → MEDIUM → COMPLEX → REASONING
 *   - COMPLEX fails  → [REASONING, MEDIUM, SIMPLE]
 *   - REASONING fails → [COMPLEX, MEDIUM, SIMPLE]
 *   - MEDIUM fails    → [COMPLEX, REASONING, SIMPLE]
 *
 * Pure and dependency-injectable so it can be unit-tested without real providers.
 */

const logger = require("../logger");

const TIER_ORDER = ["SIMPLE", "MEDIUM", "COMPLEX", "REASONING"];

/** Default availability check: a provider is unavailable if its circuit is OPEN. */
function defaultIsProviderAvailable(provider) {
  try {
    const { getCircuitBreakerRegistry } = require("../clients/circuit-breaker");
    const registry = getCircuitBreakerRegistry();
    const all = typeof registry.getAll === "function" ? registry.getAll() : [];
    const entry = Array.isArray(all) ? all.find((b) => b.name === provider) : null;
    return !(entry && entry.state === "OPEN");
  } catch {
    return true; // fail open — never block fallback on a health-check error
  }
}

/** Resolve a tier name to { tier, provider, model }, or null if not configured. */
function resolveTier(tier, selector) {
  try {
    const sel = selector || require("./model-tiers").getModelTierSelector();
    const r = sel.selectModel(tier);
    if (!r || !r.provider || !r.model) return null;
    return { tier, provider: r.provider, model: r.model };
  } catch {
    return null; // tier not configured (TIER_<X> unset) — skip it
  }
}

/**
 * Build the escalate-then-demote fallback chain for a failed tier.
 *
 * @param {string} currentTier - the tier whose provider just failed
 * @param {Object} [opts]
 * @param {Object} [opts.selector] - model-tiers selector (injected for tests)
 * @param {Function} [opts.isProviderAvailable] - (provider) => boolean (injected for tests)
 * @returns {Array<{tier,provider,model,demotedFrom,direction}>} ordered candidates
 */
function getFallbackChain(currentTier, opts = {}) {
  const isAvailable = opts.isProviderAvailable || defaultIsProviderAvailable;
  const idx = TIER_ORDER.indexOf(currentTier);
  if (idx === -1) return [];

  const higher = TIER_ORDER.slice(idx + 1); // ascending toward REASONING
  const lower = TIER_ORDER.slice(0, idx).reverse(); // descending toward SIMPLE
  const ordered = [...higher, ...lower];

  const seen = new Set();
  // Never re-attempt the exact provider:model that just failed.
  const current = resolveTier(currentTier, opts.selector);
  if (current) seen.add(`${current.provider}:${current.model}`);

  const chain = [];
  for (const tier of ordered) {
    const resolved = resolveTier(tier, opts.selector);
    if (!resolved) continue;
    const key = `${resolved.provider}:${resolved.model}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!isAvailable(resolved.provider)) continue;
    chain.push({
      ...resolved,
      demotedFrom: currentTier,
      direction: TIER_ORDER.indexOf(tier) > idx ? "up" : "down",
    });
  }

  logger.debug(
    { currentTier, chain: chain.map((c) => `${c.tier}:${c.provider}`) },
    "[TierFallback] Built fallback chain"
  );
  return chain;
}

module.exports = { getFallbackChain, resolveTier, TIER_ORDER };
