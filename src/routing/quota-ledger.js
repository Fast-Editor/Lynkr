/**
 * Subscription quota ledger (Phase 4 — quota-aware descents).
 *
 * Flat-fee subscriptions have no dollar price per token, but they do have a
 * quota bucket: sustained Opus serving drains weekly runway several times
 * faster than Haiku. This module tracks per-session burn in QUOTA UNITS so
 * the downgrade gate can shorten its horizon under pressure (see
 * cache-switch-cost.js `sessionBurnPressure`): high burn → fewer effective
 * remaining turns → holds collapse → descents clear sooner.
 *
 * Units: 1 quota unit = 1000 Haiku-class tokens (input+output blended).
 * Model weight = (inputPerM + outputPerM) / (haiku input+output), resolved
 * via cache-economics with a fail-to-middle default (2.0) for unpriced ids —
 * unknown models should exert middling pressure, never zero, never Opus.
 * Today's registry: haiku 1.0, sonnet-5 2.0, opus-4-8 5.0.
 *
 * Pressure = min(1, windowBurn / BURN_WINDOW_QUOTA) over the trailing window
 * (default 10 turns). BURN_WINDOW_QUOTA is a heuristic constant: ~ten sustained
 * full-context Opus turns. It is deliberately coarse — pressure only shortens
 * the hold horizon, it never forces a descent past the gate's own math, and
 * upgrades/tool-loops/compaction-floors bypass the gate entirely.
 *
 * Pure except for the in-memory session map (no I/O, no DB). Never throws.
 */

const BURN_WINDOW_TURNS = 10;
// ~10 sustained 10k-token Opus turns (10 × 10 × 5.0). Sustained peaks pin
// pressure at 1; occasional upgrades barely register. Heuristic — see above.
const BURN_WINDOW_QUOTA = 500;
const MAX_SESSIONS = 500;
const UNKNOWN_MODEL_WEIGHT = 2.0;
const HAIKU_BASELINE_PER_M = 6; // claude-haiku-4-5-20251001: 1 input + 5 output

const _windows = new Map(); // sessionId -> number[] (recent turn burns)

function _evictIfNeeded() {
  while (_windows.size > MAX_SESSIONS) {
    const oldest = _windows.keys().next();
    if (oldest.done) break;
    _windows.delete(oldest.value);
  }
}

/**
 * Quota weight for a model id: output+input price relative to Haiku baseline.
 * @param {string|null} model
 * @param {function|null} [resolveFn] - (provider, model) => {inputPerM, outputPerM} (tests)
 */
function modelWeight(model, resolveFn = null) {
  try {
    const resolve = resolveFn || require('./cache-economics').resolveCacheEconomics;
    const econ = resolve('azure-anthropic', model);
    if (!econ || typeof econ.inputPerM !== 'number' || typeof econ.outputPerM !== 'number') {
      return UNKNOWN_MODEL_WEIGHT;
    }
    if (econ.unknownPricing) return UNKNOWN_MODEL_WEIGHT;
    return (econ.inputPerM + econ.outputPerM) / HAIKU_BASELINE_PER_M;
  } catch {
    return UNKNOWN_MODEL_WEIGHT;
  }
}

/**
 * Record one served turn.
 * @param {string|null} sessionId
 * @param {object} usage - {model, inputTokens, outputTokens}
 * @param {function|null} [resolveFn] - test injection for modelWeight
 */
function record(sessionId, usage = {}, resolveFn = null) {
  if (!sessionId) return;
  const input = Number(usage.inputTokens) || 0;
  const output = Number(usage.outputTokens) || 0;
  if (input <= 0 && output <= 0) return;
  const burn = ((input + output) / 1000) * modelWeight(usage.model, resolveFn);
  let window = _windows.get(sessionId);
  if (!window) {
    window = [];
    _windows.set(sessionId, window);
  }
  window.push(burn);
  while (window.length > BURN_WINDOW_TURNS) window.shift();
  _evictIfNeeded();
}

/**
 * Current burn pressure for a session: 0 (idle/cheap) → 1 (sustained peaks).
 */
function pressure(sessionId) {
  const window = _windows.get(sessionId);
  if (!window || window.length === 0) return 0;
  const burn = window.reduce((a, b) => a + b, 0);
  return Math.max(0, Math.min(1, burn / BURN_WINDOW_QUOTA));
}

/** Test/ops helpers. */
function _reset() { _windows.clear(); }
function _windowBurn(sessionId) {
  const window = _windows.get(sessionId);
  return window ? window.reduce((a, b) => a + b, 0) : 0;
}

module.exports = {
  record,
  pressure,
  modelWeight,
  BURN_WINDOW_TURNS,
  BURN_WINDOW_QUOTA,
  _reset,
  _windowBurn,
};
