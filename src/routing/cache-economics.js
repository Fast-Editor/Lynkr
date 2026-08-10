/**
 * Per-provider prompt-cache economics.
 *
 * Single resolution point for "what does the prompt cache cost on this
 * provider/model": read price, write price, TTL, and mechanism. The
 * switch-cost math in `cache-switch-cost.js` and the cache-state tracker in
 * `session-affinity.js` read from here — decision code never hardcodes
 * per-model numbers.
 *
 * Resolution order per field:
 *   1. model-registry entry (models.dev carries absolute cacheRead/cacheWrite
 *      $/1M for many models)
 *   2. provider-type fallback table below (multipliers of the model's input
 *      price), researched Aug 2026.
 *
 * Mechanisms:
 *   - 'explicit'  — cache_control breakpoints, paid writes (Anthropic-style).
 *     TTL refreshes on every read, so lastRequestAt + ttlMs is a live clock.
 *   - 'automatic' — provider caches transparently, writes are free
 *     (OpenAI/DeepSeek/Gemini-style). TTL is best-effort.
 *   - 'local'     — no dollar cost at all; the "cost" of a cold prefix is
 *     prefill latency, handled separately in cache-switch-cost.js.
 *
 * @module routing/cache-economics
 */

const logger = require('../logger');

// Fallback economics keyed by Lynkr provider type. `readMult`/`writeMult`
// are multipliers of the model's per-1M input price.
const PROVIDER_CACHE_DEFAULTS = {
  // Anthropic-hosted (explicit cache_control, 1.25x write for the 5-min TTL,
  // TTL refreshed on every read).
  'azure-anthropic': { readMult: 0.1, writeMult: 1.25, ttlMs: 5 * 60 * 1000, mechanism: 'explicit' },
  bedrock:           { readMult: 0.1, writeMult: 1.25, ttlMs: 5 * 60 * 1000, mechanism: 'explicit' },
  databricks:        { readMult: 0.1, writeMult: 1.25, ttlMs: 5 * 60 * 1000, mechanism: 'explicit' },

  // OpenAI automatic prefix caching: writes free, ~5-10 min idle eviction.
  openai:         { readMult: 0.1, writeMult: 0, ttlMs: 10 * 60 * 1000, mechanism: 'automatic' },
  'azure-openai': { readMult: 0.1, writeMult: 0, ttlMs: 10 * 60 * 1000, mechanism: 'automatic' },

  // Gemini implicit caching / GLM / Kimi / aggregators: free automatic
  // caching, best-effort TTL. Aggregators (openrouter/edenai) depend on the
  // underlying model; models.dev per-model data wins when present.
  vertex:     { readMult: 0.1,  writeMult: 0, ttlMs: 5 * 60 * 1000, mechanism: 'automatic' },
  zai:        { readMult: 0.1,  writeMult: 0, ttlMs: 5 * 60 * 1000, mechanism: 'automatic' },
  moonshot:   { readMult: 0.1,  writeMult: 0, ttlMs: 5 * 60 * 1000, mechanism: 'automatic' },
  openrouter: { readMult: 0.1,  writeMult: 0, ttlMs: 5 * 60 * 1000, mechanism: 'automatic' },
  edenai:     { readMult: 0.1,  writeMult: 0, ttlMs: 5 * 60 * 1000, mechanism: 'automatic' },
  // DeepSeek direct (via aggregators today, kept for model-level matches):
  deepseek:   { readMult: 0.02, writeMult: 0, ttlMs: 5 * 60 * 1000, mechanism: 'automatic' },

  // Local runtimes: no dollars; KV cache lives as long as the model stays
  // loaded (ollama keep_alive default ~5 min).
  ollama:   { readMult: 0, writeMult: 0, ttlMs: 5 * 60 * 1000, mechanism: 'local' },
  llamacpp: { readMult: 0, writeMult: 0, ttlMs: 5 * 60 * 1000, mechanism: 'local' },
  lmstudio: { readMult: 0, writeMult: 0, ttlMs: 5 * 60 * 1000, mechanism: 'local' },
};

const GENERIC_DEFAULT = { readMult: 0.1, writeMult: 0, ttlMs: 5 * 60 * 1000, mechanism: 'automatic' };

/**
 * Fallback cache economics for a provider type (no model lookup).
 * @param {string|null} providerType
 * @returns {{readMult:number, writeMult:number, ttlMs:number, mechanism:string}}
 */
function getProviderCacheDefaults(providerType) {
  return PROVIDER_CACHE_DEFAULTS[providerType] || GENERIC_DEFAULT;
}

/**
 * Resolve full cache economics for a provider/model pair.
 *
 * @param {string|null} providerType - Lynkr provider type (e.g. 'databricks')
 * @param {string|null} model - model name for registry lookup
 * @returns {{
 *   inputPerM:number, outputPerM:number,
 *   cacheReadPerM:number, cacheWritePerM:number,
 *   ttlMs:number, mechanism:string, unknownPricing:boolean
 * }} All prices are USD per 1M tokens.
 */
function resolveCacheEconomics(providerType, model) {
  const defaults = getProviderCacheDefaults(providerType);

  let cost = null;
  try {
    const { getModelRegistrySync } = require('./model-registry');
    cost = model ? getModelRegistrySync().getCost(model) : null;
  } catch (err) {
    logger.debug({ err: err.message }, '[CacheEconomics] registry lookup failed');
  }

  const inputPerM = typeof cost?.input === 'number' ? cost.input : 0;
  const outputPerM = typeof cost?.output === 'number' ? cost.output : 0;

  // Registry cacheTtlMs/cacheMechanism (Phase 4 entries) win over the
  // provider fallback; models.dev absolute cache prices win over multipliers.
  const mechanism = cost?.cacheMechanism || defaults.mechanism;
  const ttlMs = typeof cost?.cacheTtlMs === 'number' ? cost.cacheTtlMs : defaults.ttlMs;

  const cacheReadPerM = mechanism === 'local'
    ? 0
    : (typeof cost?.cacheRead === 'number' ? cost.cacheRead : inputPerM * defaults.readMult);
  const cacheWritePerM = mechanism === 'local'
    ? 0
    : (typeof cost?.cacheWrite === 'number' ? cost.cacheWrite : inputPerM * defaults.writeMult);

  return {
    inputPerM,
    outputPerM,
    cacheReadPerM,
    cacheWritePerM,
    ttlMs,
    mechanism,
    unknownPricing: !!cost?.unknown,
  };
}

module.exports = {
  PROVIDER_CACHE_DEFAULTS,
  getProviderCacheDefaults,
  resolveCacheEconomics,
};
