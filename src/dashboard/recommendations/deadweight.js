/**
 * deadweight — tool schemas carried on every request but never called.
 *
 * Telemetry stores per-request tool COUNTS, not names, so the detectable
 * unit is the session: sessions whose every request shipped a tool loadout
 * and whose tool_calls_made never left zero paid schema rent for nothing.
 * (Per-tool attribution needs tool names in telemetry — future work.)
 */

const EST_TOKENS_PER_TOOL = 150; // typical JSON schema; stated in estimateBasis
const MIN_REQUESTS = 3;

module.exports = {
  id: 'deadweight',
  title: 'Tool schemas carried but never used',

  analyze({ db, since }) {
    const rows = db
      .prepare(
        `SELECT session_id,
                COUNT(*) reqs,
                AVG(COALESCE(tool_count,0)) avg_tools,
                MAX(model) model,
                MAX(provider) provider,
                SUM(COALESCE(cost_usd,0)) session_cost
         FROM routing_telemetry
         WHERE timestamp > ? AND session_id IS NOT NULL AND COALESCE(tool_count,0) > 0
         GROUP BY session_id
         HAVING SUM(COALESCE(tool_calls_made,0)) = 0 AND COUNT(*) >= ${MIN_REQUESTS}
         ORDER BY reqs * avg_tools DESC
         LIMIT 50`
      )
      .all(since);

    if (!rows.length) {
      return {
        id: this.id, title: this.title, mechanism: 'snippet', state: 'clean',
        framing: 'usd', pastOverspendUsd: 0, pastOverspendTokens: 0,
        stats: [], evidence: { columns: [], rows: [] },
        fix: null, caveat: null,
        estimateBasis: 'Sessions with >=3 requests, a tool loadout on every request, and zero tool calls.',
      };
    }

    const { resolveCacheEconomics } = require('../../routing/cache-economics');
    let tokens = 0;
    let usd = 0;
    const evidence = [];
    for (const r of rows) {
      const wastedTokens = Math.round(r.avg_tools * EST_TOKENS_PER_TOOL * r.reqs);
      tokens += wastedTokens;
      const econ = resolveCacheEconomics(r.provider, r.model);
      const rowUsd = econ.unknownPricing ? null : (wastedTokens * econ.inputPerM) / 1_000_000;
      if (rowUsd != null) usd += rowUsd;
      evidence.push([
        r.session_id, r.reqs, Math.round(r.avg_tools), wastedTokens,
        rowUsd != null ? rowUsd : '(price unknown)',
      ]);
    }

    return {
      id: this.id,
      title: this.title,
      mechanism: 'snippet',
      state: 'actionable',
      framing: 'usd',
      pastOverspendUsd: usd,
      pastOverspendTokens: tokens,
      stats: [
        { label: 'sessions affected', value: rows.length },
        { label: 'est. schema tokens re-sent', value: tokens },
      ],
      evidence: {
        columns: ['session', 'requests', 'avg tools', 'est. wasted tokens', 'est. $'],
        rows: evidence,
      },
      fix: 'These sessions never called a tool — their MCP servers/tool registrations paid schema rent on every request. Trim unused MCP servers from the client config, or scope them per-project.',
      caveat: 'Schema size is estimated at ~150 tokens per tool; telemetry stores tool counts, not names, so attribution is per-session rather than per-tool.',
      estimateBasis: 'avg tools × ~150 est. tokens/schema × requests per session, priced at each session\'s model input rate. Sessions with any tool call are excluded entirely.',
    };
  },
};
