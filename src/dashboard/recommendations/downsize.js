/**
 * downsize — request types where the tier below has statistically proven
 * itself, Wilson-bounded.
 *
 * The de-escalator's live rule uses raw averages (>=30 rows, avg quality
 * >=70). This analyzer applies the stricter test TokenJam-bench uses for
 * verdicts: the WILSON LOWER BOUND of the lower tier's success rate must
 * clear the bar, so 21-of-30 (lower bound ~0.52) stays "unproven" while
 * 140-of-170 (~0.76) is a verdict. Success = quality >= 70 and no error.
 *
 * No quality-equivalence claim is made — the verdict is "the lower tier's
 * measured floor clears the bar on this request type", nothing more.
 */

const { wilsonLowerBound } = require('./wilson');

const TIER_ORDER = ['SIMPLE', 'MEDIUM', 'COMPLEX', 'REASONING'];
const MIN_SAMPLES = 20;
const SUCCESS_QUALITY = 70;
const WILSON_BAR = 0.7;
const EVIDENCE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000; // evidence looks back further than the spend window

module.exports = {
  id: 'downsize',
  title: 'Tiers that could step down (Wilson-proven)',

  analyze({ db, since, until }) {
    // Lower-tier track record per request_type over 30 days.
    const evidence = db
      .prepare(
        `SELECT tier, request_type,
                COUNT(*) n,
                SUM(CASE WHEN COALESCE(quality_score,0) >= ${SUCCESS_QUALITY} AND error_type IS NULL THEN 1 ELSE 0 END) k,
                AVG(COALESCE(cost_usd,0)) avg_cost
         FROM routing_telemetry
         WHERE timestamp > ? AND tier IS NOT NULL AND request_type IS NOT NULL
         GROUP BY tier, request_type`
      )
      .all(until - EVIDENCE_WINDOW_MS);

    const byKey = new Map(evidence.map((r) => [`${r.tier}::${r.request_type}`, r]));

    // Spend at each upper tier per request_type, this window.
    const upperSpend = db
      .prepare(
        `SELECT tier, request_type, COUNT(*) n, SUM(COALESCE(cost_usd,0)) cost, AVG(COALESCE(cost_usd,0)) avg_cost
         FROM routing_telemetry
         WHERE timestamp > ? AND tier IS NOT NULL AND request_type IS NOT NULL
         GROUP BY tier, request_type`
      )
      .all(since);

    const rows = [];
    let usd = 0;
    let anyEvidence = false;
    for (const u of upperSpend) {
      const idx = TIER_ORDER.indexOf(u.tier);
      if (idx <= 0) continue;
      const lower = byKey.get(`${TIER_ORDER[idx - 1]}::${u.request_type}`);
      if (!lower) continue;
      anyEvidence = true;
      if (lower.n < MIN_SAMPLES) continue;
      const bound = wilsonLowerBound(lower.k, lower.n);
      if (bound < WILSON_BAR) continue;
      // Empirical per-request price delta between the two tiers on the SAME
      // request type — measured, not modeled.
      const delta = Math.max(0, (u.avg_cost ?? 0) - (lower.avg_cost ?? 0)) * u.n;
      usd += delta;
      rows.push([
        u.request_type, u.tier, `${TIER_ORDER[idx - 1]}`,
        `${lower.k}/${lower.n}`, bound.toFixed(2), u.n, delta,
      ]);
    }

    if (!rows.length) {
      return {
        id: this.id, title: this.title, mechanism: 'info',
        state: anyEvidence ? 'clean' : 'not_measured',
        framing: 'usd', pastOverspendUsd: anyEvidence ? 0 : null, pastOverspendTokens: null,
        stats: [],
        evidence: { columns: [], rows: [] }, fix: null, caveat: null,
        estimateBasis: anyEvidence
          ? `No (tier, request_type) pair has a lower tier whose Wilson lower bound clears ${WILSON_BAR} on >=${MIN_SAMPLES} samples yet.`
          : 'Needs quality-scored telemetry with request_type populated — accrues as traffic flows (request_type capture is recent).',
      };
    }

    rows.sort((a, b) => b[6] - a[6]);
    return {
      id: this.id,
      title: this.title,
      mechanism: 'info',
      state: 'actionable',
      framing: 'usd',
      pastOverspendUsd: usd,
      pastOverspendTokens: null,
      stats: [
        { label: 'proven (request_type, tier) pairs', value: rows.length },
      ],
      evidence: {
        columns: ['request_type', 'served tier', 'proven lower tier', 'lower success', 'Wilson lower bound', 'requests this window', 'measured delta $'],
        rows,
      },
      fix: 'The live de-escalator will demote these automatically as its own thresholds clear; to act sooner, adjust the TIER_* mapping for these request types or lower the de-escalator sample bar deliberately.',
      caveat: 'Verdict is "the lower tier\'s measured success floor clears the bar" — not quality equivalence. Success = quality >= 70 with no error.',
      estimateBasis: 'Per-request cost delta between tiers measured on the SAME request_type (30-day evidence window), × this window\'s upper-tier request count. Wilson 95% lower bound.',
    };
  },
};
