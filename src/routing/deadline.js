/**
 * Deadline-aware routing (Phase 6.3).
 *
 * Reads LYNKR-Deadline-Ms from the request, filters out candidate models
 * whose P95 latency exceeds the deadline. If the originally-routed model
 * is too slow, find a faster qualifying alternative.
 */

const { getLatencyTracker } = require('./latency-tracker');

const SAFETY_FACTOR = 1.2; // leave 20% safety margin against P95 estimates

function getDeadlineMs(req) {
  if (!req) return null;
  const h = req.headers || req;
  const raw = h['lynkr-deadline-ms'] || h['LYNKR-Deadline-Ms'];
  if (!raw) return null;
  const num = Number(raw);
  return Number.isFinite(num) && num > 0 ? num : null;
}

/**
 * Check whether a routed model is fast enough for the deadline.
 */
function fits(provider, model, deadlineMs) {
  if (!deadlineMs) return true;
  const tracker = getLatencyTracker();
  const p95 = tracker.getModelP95(provider, model);
  if (p95 === null) return true; // unknown — assume yes
  return p95 * SAFETY_FACTOR <= deadlineMs;
}

/**
 * Pick the fastest model among candidates that meets the deadline.
 */
function chooseFastest(candidates, deadlineMs) {
  if (!Array.isArray(candidates) || candidates.length === 0) return null;
  const tracker = getLatencyTracker();
  let bestP95 = Infinity;
  let best = null;
  for (const c of candidates) {
    const p95 = tracker.getModelP95(c.provider, c.model) ?? 5000;
    const eligible = !deadlineMs || p95 * SAFETY_FACTOR <= deadlineMs;
    if (eligible && p95 < bestP95) {
      bestP95 = p95;
      best = { ...c, p95 };
    }
  }
  return best;
}

module.exports = { getDeadlineMs, fits, chooseFastest, SAFETY_FACTOR };
