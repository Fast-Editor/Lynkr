/**
 * side-requests — harness side traffic served above the SIMPLE tier.
 *
 * Coding harnesses replay the conversation for their own bookkeeping
 * (title generation, topic detection). Those calls embed the user's text,
 * so they score like the user's request and ride the same tier — observed
 * live: a title request served by a frontier COMPLEX model. The whole
 * category needs a tiny model.
 */

const SIDE_PATTERNS = [
  "Generate a title%",
  "%Analyze if this message indicates a new conversation topic%",
  "Please write a %commit message%",
  "Summarize this conversation%",
];

module.exports = {
  id: 'side-requests',
  title: 'Harness side traffic on expensive tiers',

  analyze({ db, since }) {
    const where = SIDE_PATTERNS.map(() => 'request_text LIKE ?').join(' OR ');
    const rows = db
      .prepare(
        `SELECT tier, provider, model, COUNT(*) n, SUM(COALESCE(cost_usd,0)) cost
         FROM routing_telemetry
         WHERE timestamp > ? AND COALESCE(tool_count,0) = 0 AND (${where})
         GROUP BY tier, provider, model
         ORDER BY cost DESC`
      )
      .all(since, ...SIDE_PATTERNS);

    const above = rows.filter((r) => r.tier && r.tier !== 'SIMPLE');
    const total = rows.reduce((a, r) => a + r.n, 0);
    if (!above.length) {
      return {
        id: this.id, title: this.title, mechanism: 'auto', state: total > 0 ? 'clean' : 'clean',
        framing: 'usd', pastOverspendUsd: 0, pastOverspendTokens: null,
        stats: [{ label: 'side requests seen', value: total }],
        evidence: { columns: [], rows: [] }, fix: null, caveat: null,
        estimateBasis: 'Tool-less requests matching known harness bookkeeping prompts (title/topic/commit/summary).',
      };
    }

    const usd = above.reduce((a, r) => a + r.cost, 0);
    return {
      id: this.id,
      title: this.title,
      mechanism: 'auto',
      state: 'actionable',
      framing: 'usd',
      pastOverspendUsd: usd,
      pastOverspendTokens: null,
      stats: [
        { label: 'side requests above SIMPLE', value: above.reduce((a, r) => a + r.n, 0) },
        { label: 'total side requests', value: total },
      ],
      evidence: {
        columns: ['tier', 'provider', 'model', 'requests', 'spend $'],
        rows: above.map((r) => [r.tier, r.provider, r.model, r.n, r.cost]),
      },
      fix: 'Route harness bookkeeping (title generation, topic detection, commit messages) to the SIMPLE tier unconditionally — a pattern guard ahead of intent scoring. Lynkr can enforce this; the patterns above are the trigger list.',
      caveat: 'Ceiling figure: it counts the full spend of these calls, not the delta vs a SIMPLE-tier serve (which would be near zero for local SIMPLE tiers).',
      estimateBasis: 'Sum of cost_usd for tool-less requests matching harness prompt patterns, served on any tier above SIMPLE, this window.',
    };
  },
};
