/**
 * Lens recommendations engine.
 *
 * Registry-driven analyzers over routing telemetry that answer "what should
 * the operator change", TokenJam-style, with three disciplines borrowed
 * deliberately:
 *
 *  - PAST OVERSPEND, never projected savings: every dollar figure is
 *    backward-looking so the operator can check it against a bill already
 *    paid. Ceilings are labeled as ceilings in estimateBasis.
 *  - THREE-STATE HONESTY: 'actionable' (evidence found), 'clean' (ran,
 *    found nothing), 'not_measured' (data doesn't exist yet on this
 *    install). An un-run scan is not an all-clear.
 *  - MECHANISM badges: 'auto' (Lynkr could act), 'snippet' (client-side
 *    fix the operator applies), 'info' (diagnosis only).
 *
 * Analyzer contract: analyze({db, since, until}) -> finding
 *   {id, title, mechanism, state, framing: 'usd'|'tokens',
 *    pastOverspendUsd|null, pastOverspendTokens|null, stats: [{label,value}],
 *    evidence: {columns:[], rows:[][]}, fix, caveat, estimateBasis}
 *
 * The analyzers' overspend bases are disjoint by construction (dead tool
 * schemas / harness side traffic / uncached input / tier price deltas), so
 * the total is a plain sum — revisit if an analyzer is added whose basis
 * overlaps an existing one.
 *
 * @module dashboard/recommendations
 */

const logger = require('../../logger');
const telemetry = require('../../routing/telemetry');

const ANALYZERS = [
  require('./deadweight'),
  require('./side-requests'),
  require('./cache-weakspots'),
  require('./downsize'),
];

const DEFAULT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const RESULT_TTL_MS = 45 * 1000;

let _cached = null;

/**
 * Run all analyzers. Cached for 45s — findings shift slowly and the
 * dashboard polls every 30s.
 *
 * @param {Object} [opts] {windowMs, force}
 */
function run(opts = {}) {
  const windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
  if (!opts.force && _cached && Date.now() - _cached.computedAt < RESULT_TTL_MS
    && _cached.windowMs === windowMs) {
    return _cached;
  }

  const db = telemetry.getDb();
  const until = Date.now();
  const since = until - windowMs;

  const findings = [];
  for (const analyzer of ANALYZERS) {
    try {
      const finding = db
        ? analyzer.analyze({ db, since, until })
        : { id: analyzer.id, title: analyzer.title, state: 'not_measured', reason: 'telemetry unavailable' };
      if (finding) findings.push(finding);
    } catch (err) {
      logger.debug({ analyzer: analyzer.id, err: err.message }, '[Recommendations] analyzer failed');
      findings.push({ id: analyzer.id, title: analyzer.title, state: 'not_measured', reason: err.message });
    }
  }

  // Rank by dollars, biggest first; token-framed findings after usd ones.
  findings.sort((a, b) => (b.pastOverspendUsd ?? -1) - (a.pastOverspendUsd ?? -1));

  let spendUsd = 0;
  try {
    if (db) {
      spendUsd = db
        .prepare('SELECT SUM(COALESCE(cost_usd,0)) s FROM routing_telemetry WHERE timestamp > ?')
        .get(since)?.s ?? 0;
    }
  } catch { /* spend share stays 0 */ }

  const totalRecoverableUsd = findings
    .filter((f) => f.state === 'actionable' && typeof f.pastOverspendUsd === 'number')
    .reduce((acc, f) => acc + f.pastOverspendUsd, 0);

  _cached = {
    computedAt: Date.now(),
    windowMs,
    spendUsd,
    totalRecoverableUsd,
    findings,
  };
  return _cached;
}

/** Test helper — drop the memoized result. */
function _clearCacheForTests() {
  _cached = null;
}

module.exports = { run, ANALYZERS, _clearCacheForTests };
