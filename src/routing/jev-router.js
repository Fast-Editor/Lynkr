/**
 * Jev (TypeSafe System One) routing judge.
 *
 * Replaces the qwen-based difficulty classifier as the second opinion in
 * intent scoring: one typed Choice over the four tiers (+ a parallel
 * risk Noul, free — questions share state) instead of JSON coaxed through
 * a thinking block. Native per-option probabilities replace self-reported
 * confidence; 0.5s vs up-to-10s timeout; no local prefill.
 *
 * Design constraints (operator policy):
 *   - No new env vars. Endpoint, pinned model, timeout, cache size and the
 *     promotion cut are constants below. Only TYPESAFE_API_KEY is read from
 *     env (pre-existing); absent key disables the client. Rollback is a
 *     revert, not a flag — a hardcoded kill-switch you can only flip with a
 *     code edit is theater; the fail-soft nulls are the real safety.
 *   - Fail-soft: any failure (no key, timeout, 429/529, malformed body)
 *     returns null and callers fall back exactly as if no classifier ran.
 *     Single attempt, no retries in the hot path.
 *   - Pinned model version (jev-1.13.0 observed live), never jev-latest:
 *     routing must not ride alias drift. Re-run the difficulty evals on
 *     any bump. Criteria text is hashed into telemetry so prompt tweaks
 *     don't silently invalidate history either.
 *
 * Pure except for fetch (injectable) and the LRU cache. Never throws.
 */

const crypto = require('crypto');
const logger = require('../logger');

const JEV_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
const JEV_MODEL = 'jev-1.13.0';
const JEV_TIMEOUT_MS = 3000;
const JEV_CACHE_CAPACITY = 500;
// Promotion cut for letting a Jev tier override the heuristic (Phase 2).
// Matches the existing upward-gate in intent-score _reconcile (0.8);
// ratify against shadow agreement-vs-confidence data when available.
const JEV_PROMOTE_CONFIDENCE = 0.8;
// Risk corroboration cut: Noul at/above this corroborates upward only
// (may escalate, never clears a keyword hit).
const JEV_RISK_CUT = 0.85;

const VALID_TIERS = ['SIMPLE', 'MEDIUM', 'COMPLEX', 'REASONING'];

// v1 criteria — carries the hard-won disambiguators from the qwen prompt
// generations (casual follow-ups, arithmetic, verify-file-exists).
const TIER_CRITERIA_V1 = {
  SIMPLE: 'Greetings, confirmations, casual follow-ups about people, stories or everyday facts, trivial lookups and arithmetic. Any tiny model handles. NOT reasoning: who kills him?, 12+21, prove me wrong lol.',
  MEDIUM: 'One specific mechanical task or focused explanation. A mid-size model suffices. Examples: list the exports from this file, explain this regex, verify the file exists before reading it.',
  COMPLEX: 'Multi-file design, systemic refactor, architecture review, debugging that requires broad code understanding. Needs a strong general model.',
  REASONING: 'Formal proof, correctness verification, security audit, novel algorithm design, reasoning from first principles. Needs a frontier reasoning model.',
};

const TIER_INSTRUCTIONS = 'Which difficulty tier should serve this coding-assistant request? Judge the TASK the model must perform, not the vocabulary.';
const RISK_INSTRUCTIONS = 'This request involves auth, secrets, credentials, production systems, deployments, or destructive/data-loss operations.';

const CRITERIA_HASH = crypto
  .createHash('sha256')
  .update(JSON.stringify(TIER_CRITERIA_V1))
  .digest('hex')
  .slice(0, 12);

// Defensive caps (far below the ~32k-token request budget; condensed states
// never approach them — the guard exists so a pathological upstream payload
// can't turn a 0.5s judgment into a 30k-token one).
const MAX_REQUEST_CHARS = 4000;
const MAX_CONTEXT_CHARS = 500;

const _cache = new Map(); // key -> result (LRU-ish: delete+re-set on hit)

function _evictIfNeeded() {
  while (_cache.size > JEV_CACHE_CAPACITY) {
    const oldest = _cache.keys().next();
    if (oldest.done) break;
    _cache.delete(oldest.value);
  }
}

function getApiKey() {
  const raw = process.env.TYPESAFE_API_KEY;
  if (!raw || typeof raw !== 'string') return null;
  const key = raw.trim().replace(/^["']|["']$/g, '').split(/\s/)[0];
  return key || null;
}

function _stripReminders(s) {
  return typeof s === 'string'
    ? s.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim()
    : s;
}

function _cacheKey(text, context, signals) {
  return crypto
    .createHash('sha256')
    .update(`${text || ''}\0${context || ''}\0${JSON.stringify(signals || {})}\0${CRITERIA_HASH}`)
    .digest('hex');
}

/**
 * Build the Jev state: current ask in full, condensed context, precomputed
 * signals. Signals over transcripts: the counts/flags carry the routing
 * information at ~30 tokens instead of ~6k.
 */
function buildJevState({ text, context = null, signals = {} } = {}) {
  let current = _stripReminders(text || '');
  if (current.length > MAX_REQUEST_CHARS) current = current.slice(0, MAX_REQUEST_CHARS);
  let ctx = context ? _stripReminders(context) : null;
  if (ctx && ctx.length > MAX_CONTEXT_CHARS) ctx = ctx.slice(0, MAX_CONTEXT_CHARS);
  return {
    current_request: current,
    conversation_context: ctx || undefined,
    signals: {
      message_count: Number(signals.message_count) || 0,
      tools_attached: Number(signals.tools_attached) || 0,
      effective_tools: Number(signals.effective_tools) || 0,
      has_tool_history: !!signals.has_tool_history,
      session_turn: Number(signals.session_turn) || 0,
    },
  };
}

function _normalizeTier(t) {
  if (!t || typeof t !== 'string') return null;
  const up = t.trim().toUpperCase();
  return VALID_TIERS.includes(up) ? up : null;
}

function _num01(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : null;
}

/**
 * One batched evaluation: Choice(tier) + Noul(risky) sharing state.
 * @returns {null | {tier, confidence, probabilities, risky, model, latencyMs, criteriaHash}}
 */
async function evaluateJev(state, { fetchFn = null, endpoint = JEV_ENDPOINT, apiKey = null } = {}) {
  const key = apiKey || getApiKey();
  if (!key) return null;
  const fetchImpl = fetchFn || globalThis.fetch;
  if (typeof fetchImpl !== 'function') return null;
  const started = Date.now();
  try {
    const body = {
      state,
      model: JEV_MODEL,
      questions: {
        tier: { type: 'choice', instructions: TIER_INSTRUCTIONS, criteria: TIER_CRITERIA_V1 },
        risky: { type: 'noul', instructions: RISK_INSTRUCTIONS },
      },
    };
    const resp = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(JEV_TIMEOUT_MS),
    });
    if (!resp || !resp.ok) return null;
    const data = await resp.json();
    const t = data?.answers?.tier;
    const tier = _normalizeTier(t?.choice);
    if (!tier) return null;
    return {
      tier,
      confidence: _num01(t?.confidence) ?? 0,
      probabilities: (t?.probabilities && typeof t.probabilities === 'object') ? t.probabilities : null,
      risky: _num01(data?.answers?.risky?.noul),
      model: typeof data?.model === 'string' ? data.model : JEV_MODEL,
      latencyMs: Date.now() - started,
      criteriaHash: CRITERIA_HASH,
    };
  } catch (err) {
    logger.debug({ err: err?.message || String(err) }, '[Jev] evaluation failed — fail-soft null');
    return null;
  }
}

/**
 * LRU-cached classify() matching the qwen classifyDifficulty return shape
 * ({tier, confidence}) plus Jev extras, so intent-score swaps one call.
 */
async function classifyJev(text, { context = null, signals = {}, fetchFn = null } = {}) {
  const clean = _stripReminders(text || '');
  if (!clean) return null;
  const cacheKey = _cacheKey(clean, context, signals);
  const hit = _cache.get(cacheKey);
  if (hit) {
    _cache.delete(cacheKey);
    _cache.set(cacheKey, hit);
    return { ...hit, cached: true };
  }
  const state = buildJevState({ text: clean, context, signals });
  const result = await evaluateJev(state, { fetchFn });
  if (result) {
    _cache.set(cacheKey, result);
    _evictIfNeeded();
  }
  return result;
}

function _clearCache() {
  _cache.clear();
}

const _TIER_PRI = { SIMPLE: 1, MEDIUM: 2, COMPLEX: 3, REASONING: 4 };
function _pri(tier) {
  return _TIER_PRI[tier] || 0;
}

// Tier midpoints (mirrors intent-score _reconcile) so an override keeps the
// numeric score coherent with the decided tier for drift math, badges and
// telemetry. Deliberately duplicated, not imported: intent-score doesn't
// export the table and this module stays dependency-free.
const TIER_MIDPOINT = { SIMPLE: 10, MEDIUM: 35, COMPLEX: 63, REASONING: 88 };

/**
 * Jev tier override (pure): when a high-confidence Jev verdict disagrees
 * with the score-derived base tier, the verdict wins either direction.
 * Score bands remain the fallback (Jev null/low-confidence). Force paths
 * already returned upstream; agentic floors and risk lifts apply after.
 * @returns {null | {tier, score}} — score is the tier midpoint for coherence.
 */
function jevTierOverride({ baseTier, jevTier, jevConfidence } = {}) {
  if (!baseTier || !_pri(baseTier)) return null;
  if (!jevTier || !_pri(jevTier)) return null;
  if (typeof jevConfidence !== 'number' || jevConfidence < JEV_PROMOTE_CONFIDENCE) return null;
  if (_pri(jevTier) === _pri(baseTier)) return null;
  return { tier: jevTier, score: TIER_MIDPOINT[jevTier] ?? null };
}

/**
 * Shortfall floor target (pure; called by the router after shortfall).
 * A high-confidence Jev tier is a measured verdict — cheapest-covering must
 * not demote below the stronger of (scored legacy pick, Jev verdict).
 * @returns {string|null} floor tier, or null when no floor applies.
 */
function jevFloorTarget({ selectedTier, legacyTier, jevTier, jevConfidence } = {}) {
  if (typeof jevConfidence !== 'number' || jevConfidence < JEV_PROMOTE_CONFIDENCE) return null;
  if (!jevTier || !_pri(jevTier)) return null;
  const floor = _pri(legacyTier) >= _pri(jevTier) ? legacyTier : jevTier;
  if (!floor || !( _pri(selectedTier) < _pri(floor))) return null;
  return floor;
}

/**
 * Risk corroboration lift (pure; escalate-only, one band).
 * @returns {string|null} lifted tier, or null when no lift applies.
 */
function jevRiskLift({ tier, risky, riskLevel } = {}) {
  if (tier !== 'SIMPLE' && tier !== 'MEDIUM') return null;
  if (typeof risky !== 'number' || risky < JEV_RISK_CUT) return null;
  if (riskLevel === 'high') return null; // keyword path owns high risk
  return tier === 'SIMPLE' ? 'MEDIUM' : 'COMPLEX';
}

module.exports = {
  JEV_ENDPOINT,
  JEV_MODEL,
  JEV_TIMEOUT_MS,
  JEV_PROMOTE_CONFIDENCE,
  JEV_RISK_CUT,
  TIER_CRITERIA_V1,
  CRITERIA_HASH,
  VALID_TIERS,
  getApiKey,
  buildJevState,
  evaluateJev,
  classifyJev,
  jevFloorTarget,
  jevRiskLift,
  jevTierOverride,
  TIER_MIDPOINT,
  _clearCache,
};
