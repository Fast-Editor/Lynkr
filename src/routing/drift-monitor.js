/**
 * Drift monitor (Phase 4.3).
 *
 * Tracks two kinds of drift:
 *   - Input drift: distribution of query embeddings week-over-week via PSI
 *     (Population Stability Index) over coarse bucket assignments.
 *   - Output drift: refusal rate, average response length, latency
 *     distribution per model.
 *
 * Computes a PSI per metric; alerts when PSI > 0.2 (warning) or > 0.3
 * (full retrain recommended). Writes alerts to data/drift-alerts.json.
 *
 * Auto-retrain is gated on LYNKR_AUTO_RETRAIN=true and not implemented here —
 * the consumer (a cron job or the dashboard) decides what to do.
 */

const fs = require('fs');
const path = require('path');
const logger = require('../logger');

const ALERTS_PATH = path.join(__dirname, '../../data/drift-alerts.json');
const WARN_THRESHOLD = 0.2;
const RETRAIN_THRESHOLD = 0.3;

function _bucketize(values, bucketCount = 10, min, max) {
  if (values.length === 0) return new Array(bucketCount).fill(0);
  const lo = min ?? Math.min(...values);
  const hi = max ?? Math.max(...values);
  const range = Math.max(1e-9, hi - lo);
  const counts = new Array(bucketCount).fill(0);
  for (const v of values) {
    const idx = Math.max(0, Math.min(bucketCount - 1, Math.floor(((v - lo) / range) * bucketCount)));
    counts[idx]++;
  }
  return counts;
}

/**
 * Population Stability Index between two distributions.
 * PSI = Σ (p_new - p_old) · ln(p_new / p_old)
 */
function psi(oldCounts, newCounts) {
  const oldTotal = oldCounts.reduce((s, c) => s + c, 0);
  const newTotal = newCounts.reduce((s, c) => s + c, 0);
  if (oldTotal === 0 || newTotal === 0) return 0;
  let sum = 0;
  for (let i = 0; i < oldCounts.length; i++) {
    const p = (oldCounts[i] + 0.5) / (oldTotal + oldCounts.length * 0.5);
    const q = (newCounts[i] + 0.5) / (newTotal + newCounts.length * 0.5);
    sum += (q - p) * Math.log(q / p);
  }
  return sum;
}

function _writeAlert(alert) {
  try {
    fs.mkdirSync(path.dirname(ALERTS_PATH), { recursive: true });
    let existing = [];
    if (fs.existsSync(ALERTS_PATH)) {
      try { existing = JSON.parse(fs.readFileSync(ALERTS_PATH, 'utf8')); } catch {}
    }
    const out = Array.isArray(existing) ? existing : [];
    out.push({ ...alert, timestamp: Date.now() });
    fs.writeFileSync(ALERTS_PATH, JSON.stringify(out.slice(-200), null, 2));
  } catch (err) {
    logger.warn({ err: err.message }, '[DriftMonitor] Alert write failed');
  }
}

/**
 * Detect drift between two value series.
 * @param {string} metric - name for logging
 * @param {number[]} oldValues - reference window (e.g. last week)
 * @param {number[]} newValues - current window (e.g. last 24h)
 * @returns {{ psi, level, metric }}
 */
function detect(metric, oldValues, newValues) {
  if (oldValues.length < 50 || newValues.length < 20) {
    return { psi: 0, level: 'insufficient_data', metric };
  }
  const combinedMin = Math.min(...oldValues, ...newValues);
  const combinedMax = Math.max(...oldValues, ...newValues);
  const oldB = _bucketize(oldValues, 10, combinedMin, combinedMax);
  const newB = _bucketize(newValues, 10, combinedMin, combinedMax);
  const p = psi(oldB, newB);
  let level = 'ok';
  if (p >= RETRAIN_THRESHOLD) level = 'retrain';
  else if (p >= WARN_THRESHOLD) level = 'warn';

  if (level !== 'ok') {
    _writeAlert({ metric, psi: p, level, oldSize: oldValues.length, newSize: newValues.length });
  }
  return { psi: p, level, metric };
}

/**
 * Detect refusal-rate drift by counting the share of responses containing
 * refusal markers in two windows.
 */
function refusalRateShift(oldResponses, newResponses) {
  const markers = [/i can't help/i, /i won't/i, /against (?:my )?guidelines/i, /i cannot/i];
  const _rate = (arr) => arr.filter(t => markers.some(m => m.test(t))).length / Math.max(1, arr.length);
  return { old: _rate(oldResponses), new: _rate(newResponses) };
}

module.exports = {
  psi,
  detect,
  refusalRateShift,
  _bucketize,
  WARN_THRESHOLD,
  RETRAIN_THRESHOLD,
};
