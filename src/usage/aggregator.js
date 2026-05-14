/**
 * Usage Aggregator
 *
 * Reads routing telemetry from .lynkr/telemetry.db and produces
 * actionable spend / savings reports.
 *
 * The "savings" calculation answers the question:
 *   "How much would this same workload have cost if every request
 *    had hit the most expensive flagship model?"
 *
 * That's the number Lynkr's tier router exists to make small.
 */

const telemetry = require("../routing/telemetry");
const { getCostOptimizer } = require("../routing/cost-optimizer");

// What we treat as the "flagship comparison" — the model a developer
// would otherwise run every request against if they didn't have Lynkr.
// Picked to match Claude Code / Cursor defaults.
const DEFAULT_FLAGSHIP_MODEL = "claude-sonnet-4-5-20250929";

const WINDOW_PRESETS = {
  "1d": 1 * 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
  all: null,
};

/**
 * Resolve a window string ("7d", "30d", "all") or a Date / ISO string
 * into a `since` timestamp in ms. Returns null for "all".
 */
function resolveSince(window) {
  if (!window || window === "all") return null;
  if (window instanceof Date) return window.getTime();
  if (typeof window === "string") {
    if (WINDOW_PRESETS[window] !== undefined) {
      return WINDOW_PRESETS[window] === null ? null : Date.now() - WINDOW_PRESETS[window];
    }
    if (/^\d+d$/.test(window)) {
      const days = parseInt(window, 10);
      return Date.now() - days * 24 * 60 * 60 * 1000;
    }
    const parsed = Date.parse(window);
    if (!Number.isNaN(parsed)) return parsed;
  }
  if (typeof window === "number") return window;
  return null;
}

/**
 * Compute usage stats for a time window.
 *
 * @param {Object} options
 * @param {string|Date|number} [options.window="30d"]   "1d", "7d", "30d", "all", ISO string, or epoch ms
 * @param {string}             [options.flagship]      Model id used for the "what if I'd run flagship-only" comparison
 * @param {string}             [options.model]         Filter to a single model
 * @param {string}             [options.provider]      Filter to a single provider
 * @returns {Object} Aggregated usage report
 */
function getUsage(options = {}) {
  const window = options.window || "30d";
  const since = resolveSince(window);
  const flagship = options.flagship || DEFAULT_FLAGSHIP_MODEL;

  const filters = { limit: 100000 };
  if (since !== null) filters.since = since;
  if (options.provider) filters.provider = options.provider;

  let rows;
  try {
    rows = telemetry.query(filters);
  } catch (err) {
    return {
      window,
      since: since ? new Date(since).toISOString() : null,
      flagship,
      totals: emptyTotals(),
      byTier: {},
      byProvider: {},
      byModel: {},
      error: err.message,
    };
  }

  // Optional model filter (telemetry.query doesn't support it natively)
  if (options.model) {
    rows = rows.filter((r) => r.model === options.model);
  }

  const optimizer = (() => {
    try {
      return getCostOptimizer();
    } catch {
      return null;
    }
  })();

  const totals = emptyTotals();
  const byTier = {};
  const byProvider = {};
  const byModel = {};

  for (const row of rows) {
    const inputTokens = row.input_tokens || 0;
    const outputTokens = row.output_tokens || 0;
    const totalTokens = inputTokens + outputTokens;
    const actualCost = Number(row.cost_usd) || 0;

    // Hypothetical cost if this same request had hit the flagship model.
    let flagshipCost = 0;
    if (optimizer && totalTokens > 0) {
      try {
        const est = optimizer.estimateCost(flagship, inputTokens, outputTokens);
        flagshipCost = (est.inputCost || 0) + (est.outputCost || 0);
      } catch {
        flagshipCost = 0;
      }
    }
    const saved = Math.max(0, flagshipCost - actualCost);

    totals.requests += 1;
    totals.inputTokens += inputTokens;
    totals.outputTokens += outputTokens;
    totals.totalTokens += totalTokens;
    totals.actualCost += actualCost;
    totals.flagshipCost += flagshipCost;
    totals.saved += saved;
    if (row.was_fallback) totals.fallbacks += 1;
    if (row.error_type) totals.errors += 1;

    bumpBucket(byTier, row.tier || "UNKNOWN", inputTokens, outputTokens, actualCost, flagshipCost);
    bumpBucket(byProvider, row.provider || "unknown", inputTokens, outputTokens, actualCost, flagshipCost);
    bumpBucket(byModel, row.model || "unknown", inputTokens, outputTokens, actualCost, flagshipCost);
  }

  return {
    window,
    since: since ? new Date(since).toISOString() : null,
    flagship,
    totals,
    byTier,
    byProvider,
    byModel,
  };
}

function emptyTotals() {
  return {
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    actualCost: 0,
    flagshipCost: 0,
    saved: 0,
    savedPercent: 0,
    fallbacks: 0,
    errors: 0,
  };
}

function bumpBucket(bucket, key, inputTokens, outputTokens, actualCost, flagshipCost) {
  if (!bucket[key]) {
    bucket[key] = {
      requests: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      actualCost: 0,
      flagshipCost: 0,
      saved: 0,
    };
  }
  const b = bucket[key];
  b.requests += 1;
  b.inputTokens += inputTokens;
  b.outputTokens += outputTokens;
  b.totalTokens += inputTokens + outputTokens;
  b.actualCost += actualCost;
  b.flagshipCost += flagshipCost;
  b.saved += Math.max(0, flagshipCost - actualCost);
}

/**
 * Compute and finalise totals (savedPercent etc.) on a usage object.
 * Mutates and returns the object — convenient for chaining.
 */
function finalise(usage) {
  const t = usage.totals;
  t.savedPercent = t.flagshipCost > 0 ? Math.round((t.saved / t.flagshipCost) * 1000) / 10 : 0;
  for (const bucket of [usage.byTier, usage.byProvider, usage.byModel]) {
    for (const key of Object.keys(bucket)) {
      const b = bucket[key];
      b.savedPercent = b.flagshipCost > 0 ? Math.round((b.saved / b.flagshipCost) * 1000) / 10 : 0;
    }
  }
  return usage;
}

module.exports = {
  getUsage: (options) => finalise(getUsage(options)),
  resolveSince,
  DEFAULT_FLAGSHIP_MODEL,
  WINDOW_PRESETS,
};
