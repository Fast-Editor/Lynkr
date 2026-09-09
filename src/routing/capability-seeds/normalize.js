/**
 * Score → capability-cap normalization + leaderboard-name → family mapping.
 *
 * Anchors (fixed permanently — τ absorbs residual error, consistency matters
 * more than precision): benchmark fraction 0.8 (≈ flagship SWE-Verified
 * territory) → caps 0.9; fraction 0 → 0.15 (never zero: even weak models do
 * trivial turns). Linear between, clamped to [0.15, 0.9].
 *
 * Per-head source weights (v1 heuristic, documented):
 *   debugging = 0.6·swe + 0.4·terminal
 *   codegen   = 0.5·livecode + 0.3·swe + 0.2·arena
 *   reasoning = 0.5·swe + 0.3·arena + 0.2·livecode
 *   tool_use  = 0.6·terminal + 0.4·swe
 * Missing sources renormalize over the present ones. A pessimistic haircut
 * (-0.03) applies to all normalized caps: underestimating a new model costs
 * money (extra escalations), overestimating costs quality.
 *
 * Family mapping: order-insensitive token overlap between the normalized
 * family id and the leaderboard name. Every family token must hit an entry
 * token exactly or as a version prefix ("4" matches "4.5", "k2" matches
 * "k2.5" — but "32b" never matches "480b"). Best overlap wins; weak matches
 * land in `unmapped` for operator review instead of being seeded silently.
 * Pure functions, never throw.
 */

const { normalizeFamily } = require('./family');

const CAP_FLOOR = 0.15;
const CAP_CEIL = 0.9;
const NORMALIZE_HAIRCUT = 0.03;

// score fraction (0-1) at which caps hit the ceiling — flagship territory.
const ANCHOR_SCORE = 0.8;

const HEAD_WEIGHTS = {
  debugging: { swe: 0.6, terminal: 0.4, livecode: 0, arena: 0 },
  codegen: { swe: 0.3, terminal: 0, livecode: 0.5, arena: 0.2 },
  reasoning: { swe: 0.5, terminal: 0, livecode: 0.2, arena: 0.3 },
  tool_use: { swe: 0.4, terminal: 0.6, livecode: 0, arena: 0 },
};

const STOPWORDS = new Set([
  'the', 'model', 'preview', 'high', 'medium', 'low',
  'agent', 'instruct', 'thinking',
  '2024', '2025', '2026',
]);

function entryTokens(name) {
  return String(name || '')
    .toLowerCase()
    .split(/[^a-z0-9.]+/)
    .map((t) => t.replace(/^\.+|\.+$/g, ''))
    .filter((t) => t && !STOPWORDS.has(t));
}

function _tokenHit(familyTok, entryToks) {
  for (const tok of entryToks) {
    if (tok === familyTok) return true;
    // version prefix: family "4" hits entry "4.5"; family "k2" hits "k2.5".
    // The char after the prefix must be a dot (never a letter/digit, so
    // "32b" can't match "480b" and "gpt-5" can't match "gpt-50").
    if (tok.length > familyTok.length && tok.startsWith(familyTok) && tok[familyTok.length] === '.') {
      return true;
    }
    // reverse: entry "4" satisfies family "4.5"? No — a bare major never
    // proves the minor. Skip.
  }
  return false;
}

function familyTokens(family) {
  return String(family || '')
    .toLowerCase()
    .split(/[^a-z0-9.]+/)
    .map((t) => t.replace(/^\.+|\.+$/g, ''))
    .filter((t) => t && !STOPWORDS.has(t));
}

/**
 * @param {string} entryName — cleaned leaderboard name
 * @param {string[]} knownFamilies — candidate family ids (seed keys w/o wildcards)
 * @returns {{ family:string|null, hits:number, of:number }}
 */
function mapEntryToFamily(entryName, knownFamilies) {
  try {
    const toks = entryTokens(entryName);
    if (toks.length === 0 || !Array.isArray(knownFamilies)) {
      return { family: null, hits: 0, of: 0 };
    }
    let best = { family: null, hits: 0, of: 0, ratio: 0 };
    for (const fam of knownFamilies) {
      const ftoks = familyTokens(fam);
      if (ftoks.length === 0) continue;
      let hits = 0;
      for (const ft of ftoks) {
        if (_tokenHit(ft, toks)) hits++;
      }
      const ratio = hits / ftoks.length;
      // Full coverage required; ties prefer the more specific family.
      if (ratio === 1 && (best.family === null || ftoks.length > best.of)) {
        best = { family: fam, hits, of: ftoks.length, ratio };
      }
    }
    return best.family ? best : { family: null, hits: 0, of: 0 };
  } catch {
    return { family: null, hits: 0, of: 0 };
  }
}

function scoreToCap(score) {
  const s = Math.max(0, Math.min(1, Number(score)));
  if (!Number.isFinite(s)) return null;
  const cap = CAP_FLOOR + (s / ANCHOR_SCORE) * (CAP_CEIL - CAP_FLOOR);
  return Math.max(CAP_FLOOR, Math.min(CAP_CEIL, cap));
}

/**
 * @param {object} scores — { swe?, terminal?, livecode?, arena? } fractions 0-1
 * @returns {null | { reasoning, codegen, debugging, tool_use }}
 */
function scoresToCaps(scores) {
  try {
    if (!scores || typeof scores !== 'object') return null;
    const present = {};
    for (const k of ['swe', 'terminal', 'livecode', 'arena']) {
      const v = Number(scores[k]);
      if (Number.isFinite(v)) present[k] = Math.max(0, Math.min(1, v));
    }
    if (Object.keys(present).length === 0) return null;
    const caps = {};
    for (const [head, weights] of Object.entries(HEAD_WEIGHTS)) {
      let total = 0;
      let wsum = 0;
      for (const [src, w] of Object.entries(weights)) {
        if (present[src] !== undefined && w > 0) {
          total += scoreToCap(present[src]) * w;
          wsum += w;
        }
      }
      if (wsum === 0) return null;
      caps[head] = Math.round((total / wsum - NORMALIZE_HAIRCUT) * 1000) / 1000;
      caps[head] = Math.max(CAP_FLOOR, Math.min(CAP_CEIL, caps[head]));
    }
    return caps;
  } catch {
    return null;
  }
}

module.exports = {
  mapEntryToFamily,
  scoresToCaps,
  scoreToCap,
  entryTokens,
  familyTokens,
  normalizeFamily,
  CAP_FLOOR,
  CAP_CEIL,
  NORMALIZE_HAIRCUT,
};
