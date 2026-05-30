/**
 * Regret estimator (Phase 4.2).
 *
 * Periodically samples a fraction of yesterday's requests, re-runs them
 * through a strictly-better model (Opus), and compares quality. If the
 * routed model consistently underperforms vs Opus by >10%, this writes an
 * alert to data/regret-alerts.json.
 *
 * Off by default (costs real money). Enable with LYNKR_REGRET_ESTIMATOR=true
 * and run via cron: `node scripts/sample-regret.js`.
 */

const fs = require('fs');
const path = require('path');
const logger = require('../logger');

const ALERTS_PATH = path.join(__dirname, '../../data/regret-alerts.json');

/**
 * @param {object} args
 * @param {Array<{request: object, response: object, model: string, quality: number}>} args.samples
 * @param {function} args.runOpus — async (request) → { response, quality }
 * @param {number} args.threshold — fractional underperformance threshold (default 0.10)
 * @returns {Promise<{ regret, sampledCount, alerts }>}
 */
async function estimate(args) {
  const threshold = args.threshold ?? 0.10;
  const results = [];
  for (const s of args.samples) {
    try {
      const opus = await args.runOpus(s.request);
      const delta = (opus.quality - s.quality) / Math.max(1, opus.quality);
      results.push({
        model: s.model,
        routedQuality: s.quality,
        opusQuality: opus.quality,
        regret: Math.max(0, delta),
        underperforming: delta > threshold,
      });
    } catch (err) {
      logger.debug({ err: err.message }, '[RegretEstimator] Opus re-run failed');
    }
  }

  const byModel = new Map();
  for (const r of results) {
    if (!byModel.has(r.model)) byModel.set(r.model, []);
    byModel.get(r.model).push(r);
  }

  const alerts = [];
  for (const [model, runs] of byModel) {
    const underperforming = runs.filter(r => r.underperforming).length;
    const rate = underperforming / runs.length;
    if (rate > 0.5 && runs.length >= 5) {
      alerts.push({
        model,
        underperformingRate: rate,
        sampleSize: runs.length,
        avgRegret: runs.reduce((s, r) => s + r.regret, 0) / runs.length,
        timestamp: Date.now(),
      });
    }
  }

  if (alerts.length > 0) {
    try {
      fs.mkdirSync(path.dirname(ALERTS_PATH), { recursive: true });
      let existing = [];
      if (fs.existsSync(ALERTS_PATH)) {
        try { existing = JSON.parse(fs.readFileSync(ALERTS_PATH, 'utf8')); } catch {}
      }
      const out = Array.isArray(existing) ? existing : [];
      out.push(...alerts);
      // Keep last 100 alerts
      const trimmed = out.slice(-100);
      fs.writeFileSync(ALERTS_PATH, JSON.stringify(trimmed, null, 2));
    } catch (err) {
      logger.warn({ err: err.message }, '[RegretEstimator] Alert write failed');
    }
  }

  const totalRegret = results.reduce((s, r) => s + r.regret, 0) / Math.max(1, results.length);
  return { regret: totalRegret, sampledCount: results.length, alerts };
}

function isEnabled() {
  return process.env.LYNKR_REGRET_ESTIMATOR === 'true';
}

module.exports = { estimate, isEnabled };
