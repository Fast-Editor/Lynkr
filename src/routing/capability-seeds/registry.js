/**
 * Seed registry: per-FAMILY capability profiles from online-derived data.
 *
 * Layers (first hit wins in shortfall.js resolveCapabilities):
 *   operator modelOverrides (provider:model, manual — supreme, lives in
 *     model-capabilities.json) → snapshot (data/, fetched, `source:'seed:snapshot'`)
 *     → shipped (config/, reviewed, `source:'seed:shipped'`) → family
 *     heuristic (`source:'family'`) → tier slot (`source:'tier'`).
 *
 * Keys are normalized family ids (see family.js), lowercased, with optional
 * trailing `*` wildcards matched longest-first (gpt-5* , qwen3-*). Provider
 * never appears in keys — zai/baidu/ollama servings of glm-5.2 share one entry.
 *
 * File lifecycles mirror model-tiers.json: read once at boot, restart to
 * pick up edits. data/ is gitignored (operator-local), config/ is versioned.
 * Pure lookups after load; load never throws (missing/malformed → empty).
 */

const fs = require('fs');
const path = require('path');
const logger = require('../../logger');
const { HEADS } = require('../capabilities');

const SHIPPED_PATH = path.join(__dirname, '../../../config/model-capability-seeds.json');
const SNAPSHOT_PATH = path.join(__dirname, '../../../data/capability-seeds.snapshot.json');

let _cache = null;

function sanitizeCaps(raw) {
  const caps = {};
  for (const h of HEADS) {
    const v = Number(raw?.[h]);
    caps[h] = Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0.5;
  }
  return caps;
}

function _loadSeedsFile(filePath, label) {
  try {
    if (!fs.existsSync(filePath)) return {};
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const seeds = raw?.seeds && typeof raw.seeds === 'object' ? raw.seeds : {};
    const out = {};
    for (const [key, entry] of Object.entries(seeds)) {
      const caps = entry?.caps && typeof entry.caps === 'object' ? entry.caps : entry;
      if (!caps || typeof caps !== 'object') continue;
      out[String(key).toLowerCase()] = {
        caps: sanitizeCaps(caps),
        sources: Array.isArray(entry?.sources) ? entry.sources : [],
        note: typeof entry?.note === 'string' ? entry.note : '',
      };
    }
    return out;
  } catch (err) {
    logger.debug({ err: err.message, label }, '[SeedRegistry] seed file load failed — skipping layer');
    return {};
  }
}

function loadSeedLayers() {
  if (_cache) return _cache;
  _cache = {
    snapshot: _loadSeedsFile(SNAPSHOT_PATH, 'snapshot'),
    shipped: _loadSeedsFile(SHIPPED_PATH, 'shipped'),
  };
  return _cache;
}

function _resetSeedsCache() {
  _cache = null;
}

// Test hook: inject layers directly (Operations on the same cached object
// the resolver reads).
function _setSeedsForTests({ snapshot, shipped } = {}) {
  const base = loadSeedLayers();
  _cache = {
    snapshot: snapshot ?? base.snapshot,
    shipped: shipped ?? base.shipped,
  };
  return _cache;
}

function _matchWildcard(layer, family) {
  let best = null;
  for (const [key, entry] of Object.entries(layer)) {
    if (!key.endsWith('*')) continue;
    const prefix = key.slice(0, -1);
    if (prefix && family.startsWith(prefix) && (!best || prefix.length > best.prefix.length)) {
      best = { prefix, entry };
    }
  }
  return best?.entry ?? null;
}

/**
 * @param {string} family — normalized family id
 * @returns {null | { caps, source:'seed:snapshot'|'seed:shipped', sources, note }}
 */
function resolveSeedCaps(family) {
  try {
    const f = String(family || '').toLowerCase().trim();
    if (!f || f === 'unknown') return null;
    const { snapshot, shipped } = loadSeedLayers();
    if (snapshot[f]) return { ...snapshot[f], source: 'seed:snapshot' };
    if (shipped[f]) return { ...shipped[f], source: 'seed:shipped' };
    const snapWild = _matchWildcard(snapshot, f);
    if (snapWild) return { ...snapWild, source: 'seed:snapshot' };
    const shipWild = _matchWildcard(shipped, f);
    if (shipWild) return { ...shipWild, source: 'seed:shipped' };
    return null;
  } catch {
    return null;
  }
}

module.exports = {
  loadSeedLayers,
  _resetSeedsCache,
  _setSeedsForTests,
  resolveSeedCaps,
  sanitizeCaps,
  SHIPPED_PATH,
  SNAPSHOT_PATH,
};
