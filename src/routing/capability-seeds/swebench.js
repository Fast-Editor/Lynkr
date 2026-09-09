/**
 * SWE-Bench Verified adapter: per-model % resolved from the public
 * leaderboard raw data.
 *
 * Source: https://raw.githubusercontent.com/SWE-bench/swe-bench.github.io/master/data/leaderboards.json
 * Shape: { leaderboards: [{ name: "Verified"|"Lite"|..., results: [{ name, resolved, date, ... }] }] }
 * Entry names look like "Claude 4.5 Opus (high) · mini-SWE-agent · 2026-02-17"
 * (model + effort qualifier + scaffold + date). We keep the best resolved%
 * per cleaned model name; family mapping happens in normalize.js
 * (token-overlap against known families, unmapped surfaced for review).
 *
 * Fail-soft: any fetch/parse problem → { status:'skipped', reason }.
 */

const { fetchJson, getCached, setCached, skipped } = require('./sources');

const LEADERBOARDS_URL = 'https://raw.githubusercontent.com/SWE-bench/swe-bench.github.io/master/data/leaderboards.json';
const BOARD = 'Verified';

function cleanName(name) {
  return String(name || '')
    .split('·')[0] // drop scaffold + date segments
    .replace(/\((high|medium|low)\)/gi, '') // effort qualifier (we keep max across them)
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

/**
 * @param {object} [opts] — { refresh:boolean } (false = cache-only)
 * @returns {Promise<{ status, board?, entries?:Array<{name,resolved,date}>, reason? }>}
 */
async function fetchSweBench({ refresh = true } = {}) {
  if (!refresh) {
    const cached = getCached('swebench');
    if (cached) return { status: 'ok', board: BOARD, entries: cached, cached: true };
    return skipped('no cache (run with --refresh)');
  }
  try {
    const data = await fetchJson(LEADERBOARDS_URL);
    const boards = Array.isArray(data?.leaderboards) ? data.leaderboards : [];
    const verified = boards.find((b) => String(b?.name || '').toLowerCase() === BOARD.toLowerCase());
    if (!verified || !Array.isArray(verified.results)) {
      return skipped(`board "${BOARD}" not found in payload`);
    }
    const best = new Map();
    for (const r of verified.results) {
      const name = cleanName(r?.name);
      const resolved = Number(r?.resolved);
      if (!name || !Number.isFinite(resolved)) continue;
      const prev = best.get(name);
      if (!prev || resolved > prev.resolved) {
        best.set(name, { name, resolved, date: r?.date ?? null });
      }
    }
    const entries = [...best.values()];
    setCached('swebench', entries);
    return { status: 'ok', board: BOARD, entries };
  } catch (err) {
    const cached = getCached('swebench');
    if (cached) return { status: 'ok', board: BOARD, entries: cached, cached: true, stale: err.message };
    return skipped(`fetch failed and no cache: ${err.message}`);
  }
}

module.exports = { fetchSweBench, cleanName, LEADERBOARDS_URL, BOARD };
