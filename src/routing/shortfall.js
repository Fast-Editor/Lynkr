/**
 * Shortfall matching (item 1: HyDRA port, phase 1).
 *
 * Selects the cheapest candidate whose capabilities cover the predicted
 * requirement vector within tolerance τ:
 *
 *   shortfall(m) = Σ w_k · max(0, req_k − cap_mk)
 *
 * All four heads share the [0,1] bandwidth, so v1 weights are uniform
 * (band compensation is a no-op until heads diverge — noted for phase 2).
 *
 * Contracts:
 *   - Catalog-decoupled: candidates arrive as [{provider, model, tier}];
 *     capabilities resolve per MODEL FAMILY (provider never matters:
 *     zai/baidu/ollama servings of glm-5.2 share caps) via operator
 *     modelOverrides → seed snapshot/shipped → family heuristic → tier
 *     profile. Adding, removing, or repricing a model re-routes via config
 *     with zero retraining.
 *   - Self-contained config: enabled/tau/weights also live in
 *     config/model-capabilities.json — no env vars. The file is read once at
 *     boot (same lifecycle as config/model-tiers.json); restart to pick up
 *     edits.
 *   - Cost comes from the caller (model-registry) or per-1k blended estimate;
 *     unknown cost sorts last (conservative — never wins on cheapness alone).
 *   - No covering candidate (all shortfalls > τ) → minimal shortfall wins,
 *     tiebreak higher tier (correctness over cost, matches tier-fallback.js
 *     escalate-then-demote bias). Never returns null on valid input; returns
 *     null only on malformed input so callers fail open to legacy routing.
 *   - Pure except for config load (cached). Never throws.
 */

const fs = require('fs');
const path = require('path');
const logger = require('../logger');
const { HEADS } = require('./capabilities');

const PROFILES_PATH = path.join(__dirname, '../../config/model-capabilities.json');

const DEFAULT_TAU = 0.24; // HyDRA iso-quality operating point
const TIER_PRIORITY = { SIMPLE: 1, MEDIUM: 2, COMPLEX: 3, REASONING: 4 };

let _profilesCache = null;

function _defaultWeights() {
  const w = {};
  for (const h of HEADS) w[h] = 1 / HEADS.length;
  return w;
}

function _sanitizeCaps(raw) {
  const caps = {};
  for (const h of HEADS) {
    const v = Number(raw?.[h]);
    caps[h] = Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0.5;
  }
  return caps;
}

function loadProfiles() {
  if (_profilesCache) return _profilesCache;
  try {
    const raw = JSON.parse(fs.readFileSync(PROFILES_PATH, 'utf8'));
    const tierProfiles = {};
    const fileTiers = raw?.tierProfiles && typeof raw.tierProfiles === 'object'
      ? raw.tierProfiles
      : {};
    for (const [tier, caps] of Object.entries(fileTiers)) {
      if (caps && typeof caps === 'object') tierProfiles[tier] = _sanitizeCaps(caps);
    }
    const modelOverrides = {};
    const fileOverrides = raw?.modelOverrides && typeof raw.modelOverrides === 'object'
      ? raw.modelOverrides
      : {};
    for (const [key, caps] of Object.entries(fileOverrides)) {
      if (caps && typeof caps === 'object') modelOverrides[String(key).toLowerCase()] = _sanitizeCaps(caps);
    }
    const tau = Number(raw?.tau);
    const weights = _normalizeWeights(raw?.weights);
    _profilesCache = {
      tierProfiles,
      modelOverrides,
      enabled: raw?.enabled === true,
      tau: Number.isFinite(tau) && tau >= 0 ? tau : DEFAULT_TAU,
      weights,
    };
  } catch (err) {
    logger.debug({ err: err.message }, '[Shortfall] profiles load failed — disabled with tier fallbacks');
    _profilesCache = { tierProfiles: {}, modelOverrides: {}, enabled: false, tau: DEFAULT_TAU, weights: _defaultWeights() };
  }
  return _profilesCache;
}

// Exposed for tests (cache reset / profile injection).
function _resetProfilesCache() {
  _profilesCache = null;
}

function _setProfilesForTests(profiles) {
  const base = loadProfiles();
  _profilesCache = {
    tierProfiles: profiles?.tierProfiles ?? base.tierProfiles,
    modelOverrides: profiles?.modelOverrides ?? base.modelOverrides,
    enabled: profiles?.enabled ?? base.enabled,
    tau: profiles?.tau ?? base.tau,
    weights: profiles?.weights ?? base.weights,
  };
  return _profilesCache;
}

function _normalizeWeights(raw) {
  const w = _defaultWeights();
  if (!raw || typeof raw !== 'object') return w;
  let touched = false;
  for (const h of HEADS) {
    const v = Number(raw[h]);
    if (Number.isFinite(v) && v >= 0) {
      w[h] = v;
      touched = true;
    }
  }
  if (!touched) return _defaultWeights();
  const sum = Object.values(w).reduce((a, b) => a + b, 0);
  if (sum <= 0) return _defaultWeights();
  for (const h of HEADS) w[h] = w[h] / sum;
  return w;
}

function getTau() {
  return loadProfiles().tau;
}

function getWeights() {
  return { ...loadProfiles().weights };
}

function isEnabled() {
  return loadProfiles().enabled === true;
}

/**
 * Resolve capabilities for one candidate. Precedence (first hit wins):
 *   1. operator "provider:model" / "provider:*" override (manual, supreme,
 *      returned verbatim — not even the quant haircut applies)
 *   2. seed snapshot / shipped seeds by normalized MODEL FAMILY
 *      (zai/baidu/ollama servings of glm-5.2 share one entry)
 *   3. family-ladder heuristic (zero-network estimate, never frontier)
 *   4. tier profile → tier-priority fallback (SIMPLE 0.2 … REASONING 0.9)
 *
 * Quantized self-hosted servings (Q4_K_M, gguf, …) take a small haircut at
 * every level except 1: same brain, smaller body.
 *
 * @returns {{ caps, source }} — source is override|seed:snapshot|
 *   seed:shipped|family|tier|tier-fallback (telemetry provenance).
 */
function resolveCapabilitiesWithSource({ provider, model, tier }) {
  const { tierProfiles, modelOverrides } = loadProfiles();
  const key = `${String(provider || '').toLowerCase()}:${String(model || '').toLowerCase()}`;
  const wild = `${String(provider || '').toLowerCase()}:*`;
  const pick = modelOverrides[key] || modelOverrides[wild];
  if (pick) return { caps: { ...pick }, source: 'override' };

  let family = 'unknown';
  let quant = false;
  try {
    const fam = require('./capability-seeds/family');
    ({ family, quant } = fam.normalizeFamily(provider, model));
  } catch { /* family helpers unavailable — tier fallback below */ }

  try {
    const { resolveSeedCaps } = require('./capability-seeds/registry');
    const seed = resolveSeedCaps(family);
    if (seed) {
      const caps = quant
        ? require('./capability-seeds/family').applyQuantHaircut(seed.caps)
        : { ...seed.caps };
      return { caps, source: seed.source };
    }
  } catch { /* seed layers unavailable — keep falling through */ }

  try {
    const { heuristicCaps } = require('./capability-seeds/family-heuristics');
    const heur = heuristicCaps(family);
    if (heur) {
      const caps = quant
        ? require('./capability-seeds/family').applyQuantHaircut(heur)
        : heur;
      return { caps, source: 'family' };
    }
  } catch { /* heuristic unavailable — tier fallback below */ }

  const tp = tierProfiles[tier];
  if (tp) {
    const caps = quant
      ? require('./capability-seeds/family').applyQuantHaircut(tp)
      : { ...tp };
    return { caps, source: 'tier' };
  }
  const p = (TIER_PRIORITY[tier] || 1) / 4;
  const caps = {};
  for (const h of HEADS) caps[h] = Math.round(p * 1000) / 1000;
  return { caps, source: 'tier-fallback' };
}

function resolveCapabilities(candidate) {
  return resolveCapabilitiesWithSource(candidate).caps;
}

function shortfall(req, caps, weights = null) {
  const w = weights || _defaultWeights();
  let s = 0;
  for (const h of HEADS) {
    const r = Math.max(0, Math.min(1, Number(req?.[h]) || 0));
    const c = Math.max(0, Math.min(1, Number(caps?.[h]) || 0));
    s += (w[h] ?? 0) * Math.max(0, r - c);
  }
  return Math.round(s * 10000) / 10000;
}

function _costValue(c) {
  const n = Number(c);
  return Number.isFinite(n) && n >= 0 ? n : Number.POSITIVE_INFINITY;
}

/**
 * @param {object} req — requirement vector {reasoning, codegen, debugging, tool_use} in [0,1]
 * @param {Array<{provider, model, tier, cost?}>} candidates — catalog-constrained set
 *   (callers pass getAllConfiguredModels() + model-registry costs)
 * @param {object} [opts] — { tau, weights }
 * @returns {null | { selected, shortfalls: Array<{provider, model, tier, shortfall, cost, source}>, tau }}
 */
function selectByShortfall(req, candidates, opts = {}) {
  try {
    if (!req || typeof req !== 'object') return null;
    if (!Array.isArray(candidates) || candidates.length === 0) return null;
    const tau = opts.tau ?? getTau();
    const weights = opts.weights ?? getWeights();

    const rows = candidates
      .filter((c) => c && c.provider && c.model)
      .map((c) => {
        const { caps, source } = resolveCapabilitiesWithSource(c);
        return {
          provider: c.provider,
          model: c.model,
          tier: c.tier || 'MEDIUM',
          cost: _costValue(c.cost),
          shortfall: shortfall(req, caps, weights),
          source,
        };
      });
    if (rows.length === 0) return null;

    const covering = rows.filter((r) => r.shortfall <= tau);
    const pool = covering.length > 0 ? covering : rows;
    pool.sort((a, b) => {
      if (covering.length > 0) {
        // Cheapest covering wins; cost tie (incl. all-unknown) breaks toward
        // the LOWER tier — a covering lower tier is sufficient by definition,
        // so prefer it over excess headroom (avoids over-provisioning).
        if (a.cost !== b.cost) return a.cost - b.cost;
        return (TIER_PRIORITY[a.tier] || 0) - (TIER_PRIORITY[b.tier] || 0);
      }
      // Nothing covers: minimal shortfall wins, tiebreak higher tier then cheaper.
      if (a.shortfall !== b.shortfall) return a.shortfall - b.shortfall;
      const tp = (TIER_PRIORITY[b.tier] || 0) - (TIER_PRIORITY[a.tier] || 0);
      if (tp !== 0) return tp;
      return a.cost - b.cost;
    });

    return { selected: pool[0], shortfalls: rows, tau };
  } catch (err) {
    logger.debug({ err: err.message }, '[Shortfall] select failed — failing open');
    return null;
  }
}

module.exports = {
  HEADS,
  DEFAULT_TAU,
  loadProfiles,
  _resetProfilesCache,
  _setProfilesForTests,
  getTau,
  getWeights,
  isEnabled,
  resolveCapabilities,
  resolveCapabilitiesWithSource,
  shortfall,
  selectByShortfall,
};
