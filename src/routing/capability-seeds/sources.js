/**
 * Shared plumbing for capability-seed sources (online benchmark data).
 *
 * Every adapter is optional and fail-soft: no network, bad payload, or
 * unknown shape → { status:'skipped', reason } — never throws, never blocks
 * the script, and never touches request-path routing (this only runs in
 * scripts/seed-capabilities.js). Fetched payloads are cached under
 * data/capability-sources-cache.json with a 7-day TTL so refreshes are
 * cheap and CI stays hermetic (tests use fixtures, never the network).
 */

const fs = require('fs');
const path = require('path');

const CACHE_PATH = path.join(__dirname, '../../../data/capability-sources-cache.json');
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 20000;

function _readCache() {
  try {
    if (!fs.existsSync(CACHE_PATH)) return {};
    return JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function _writeCache(cache) {
  try {
    fs.mkdirSync(path.dirname(CACHE_PATH), { recursive: true });
    fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2));
  } catch {
    // cache is best-effort; a failed write must not fail seeding
  }
}

function getCached(source) {
  const cache = _readCache();
  const entry = cache[source];
  if (!entry || typeof entry !== 'object') return null;
  if (Date.now() - (entry.fetchedAt || 0) > CACHE_TTL_MS) return null;
  return entry.payload ?? null;
}

function setCached(source, payload) {
  const cache = _readCache();
  cache[source] = { fetchedAt: Date.now(), payload };
  _writeCache(cache);
}

async function fetchJson(url, { timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

const skipped = (reason) => ({ status: 'skipped', reason });

module.exports = {
  CACHE_PATH,
  CACHE_TTL_MS,
  getCached,
  setCached,
  fetchJson,
  skipped,
};
