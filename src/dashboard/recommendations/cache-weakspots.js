/**
 * cache-weakspots — prompt-cache hit ratio per (provider, model), worst first.
 *
 * Reads the per-request cache counters (cache_read_tokens /
 * cache_creation_tokens). Rows recorded before capture began are NULL and
 * excluded — when nothing has been measured yet the finding says so
 * explicitly instead of reporting a fake all-clear.
 */

const MIN_REQUESTS = 5;
const WEAK_RATIO = 0.5;

module.exports = {
  id: 'cache-weakspots',
  title: 'Weak prompt-cache hit ratios',

  analyze({ db, since }) {
    const rows = db
      .prepare(
        `SELECT provider, model, COUNT(*) n,
                SUM(COALESCE(cache_read_tokens,0)) rd,
                SUM(COALESCE(cache_creation_tokens,0)) cr,
                SUM(COALESCE(input_tokens,0)) inp
         FROM routing_telemetry
         WHERE timestamp > ? AND cache_read_tokens IS NOT NULL
         GROUP BY provider, model
         HAVING COUNT(*) >= ${MIN_REQUESTS}`
      )
      .all(since);

    if (!rows.length) {
      return {
        id: this.id, title: this.title, mechanism: 'info', state: 'not_measured',
        framing: 'usd', pastOverspendUsd: null, pastOverspendTokens: null,
        stats: [], evidence: { columns: [], rows: [] }, fix: null,
        caveat: null,
        estimateBasis: 'Cache counters are captured from this version onward — data accrues as requests flow. An un-run measurement is not an all-clear.',
      };
    }

    const { resolveCacheEconomics } = require('../../routing/cache-economics');
    const weak = [];
    let usd = 0;
    for (const r of rows) {
      const total = r.rd + r.cr + r.inp;
      const ratio = total > 0 ? r.rd / total : 0;
      if (ratio >= WEAK_RATIO) continue;
      const econ = resolveCacheEconomics(r.provider, r.model);
      // Ceiling: what the uncached input cost beyond cache-read price.
      const missedUsd = econ.unknownPricing || econ.mechanism === 'local'
        ? null
        : (r.inp * Math.max(0, econ.inputPerM - econ.cacheReadPerM)) / 1_000_000;
      if (missedUsd != null) usd += missedUsd;
      weak.push([r.provider, r.model, r.n, `${Math.round(ratio * 100)}%`, r.inp, missedUsd ?? '(local/unknown)']);
    }

    if (!weak.length) {
      return {
        id: this.id, title: this.title, mechanism: 'info', state: 'clean',
        framing: 'usd', pastOverspendUsd: 0, pastOverspendTokens: null,
        stats: [{ label: 'models measured', value: rows.length }],
        evidence: { columns: [], rows: [] }, fix: null, caveat: null,
        estimateBasis: `Hit ratio = cache reads ÷ (reads + writes + uncached input); weak = below ${WEAK_RATIO * 100}%.`,
      };
    }

    return {
      id: this.id,
      title: this.title,
      mechanism: 'info',
      state: 'actionable',
      framing: 'usd',
      pastOverspendUsd: usd,
      pastOverspendTokens: null,
      stats: [
        { label: 'weak (provider, model) pairs', value: weak.length },
        { label: 'models measured', value: rows.length },
      ],
      evidence: {
        columns: ['provider', 'model', 'requests', 'hit ratio', 'uncached input tokens', 'ceiling $'],
        rows: weak.sort((a, b) => parseFloat(a[3]) - parseFloat(b[3])),
      },
      fix: 'Low ratios usually mean an unstable prefix: per-request bytes in the system prompt, client-side history rewrites, or conversations too short to cache. Check the silent-invalidator list and whether the distiller freeze covers these sessions.',
      caveat: 'The dollar figure is a CEILING — it prices every uncached input token at the read discount, which assumes perfect cacheability. Real recovery is lower.',
      estimateBasis: 'Uncached input tokens × (input price − cache-read price) for pairs below a 50% hit ratio, this window. NULL-counter rows (pre-capture) excluded.',
    };
  },
};
