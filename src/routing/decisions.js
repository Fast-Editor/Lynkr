/**
 * Decision engine: evaluate signals, walk decisions by priority, first match
 * wins. Returns a result with a full trace so `lynkr route --preview` and
 * telemetry can explain every choice.
 *
 * In "observe" mode the engine's tier is recorded but the legacy chain's tier
 * is served. In "enforce" mode routing/index.js adopts the engine's tier when
 * it differs. The default config has a single `legacy` decision whose tier is
 * `from:legacy`, so a fresh install agrees with the legacy chain by
 * construction and operators add decisions above it.
 */
'use strict';

const rc = require('./routing-config');
const signalsMod = require('./signals');

function _evalRule(rule, signals) {
  const op = String(rule.operator || 'AND').toUpperCase();
  const conds = Array.isArray(rule.conditions) ? rule.conditions : [];
  const results = conds.map((c) => (c && typeof c.operator === 'string') ? _evalRule(c, signals) : signalsMod.testCondition(c, signals));
  if (op === 'NOT') return !results[0];
  if (op === 'OR') return results.some(Boolean);
  return results.every(Boolean); // AND; empty = true
}

function _resolveTier(spec, ctx, signals) {
  if (!spec) return null;
  if (spec === 'from:legacy') return ctx.legacy?.tier || null;
  if (spec === 'from:anchor') return signals.anchor?.band || ctx.legacy?.tier || null;
  if (spec === 'from:judge') return signals.judge?.tier || ctx.legacy?.tier || null;
  return rc.TIERS.includes(spec) ? spec : null;
}

/**
 * @param {object} ctx — see signals.js
 * @returns {{ decision, tier, effort, hosts, plugins, mode, signals, trace }}
 */
async function evaluate(ctx, config) {
  const cfg = config || rc.load();
  const signals = await signalsMod.evaluateAll(ctx, cfg);
  return decideFromSignals(signals, ctx, cfg);
}

/**
 * Pure decision step over already-evaluated signals. Used by evaluate() and
 * by the corpus regression test (fixtures store signal snapshots so the test
 * is deterministic without embeddings or the judge).
 */
function decideFromSignals(signals, ctx, config) {
  const cfg = config || rc.load();
  const considered = [];
  let matched = null;
  for (const d of cfg.decisions) {
    let ok = false;
    try { ok = _evalRule(d.rules || { operator: 'AND', conditions: [] }, signals); } catch { ok = false; }
    considered.push({ name: d.name, priority: d.priority, matched: ok });
    if (ok) { matched = d; break; }
  }
  const tier = matched ? _resolveTier(matched.tier, ctx, signals) : (ctx.legacy?.tier || null);
  return {
    decision: matched ? matched.name : null,
    tier,
    effort: matched?.effort ?? null,
    hosts: Array.isArray(matched?.hosts) ? matched.hosts : null,
    plugins: matched?.plugins && typeof matched.plugins === 'object' ? matched.plugins : null,
    mode: cfg.mode === 'enforce' ? 'enforce' : 'observe',
    agreesWithLegacy: !ctx.legacy?.tier || tier === ctx.legacy.tier,
    signals: Object.fromEntries(Object.entries(signals).map(([k, v]) => [k, { matched: v.matched, value: v.value, confidence: v.confidence, band: v.band, tier: v.tier }])),
    trace: { considered, legacy: ctx.legacy || null },
  };
}

/** Compact header-safe summary. */
function headerSummary(result) {
  if (!result) return {};
  const sig = Object.entries(result.signals || {}).filter(([, v]) => v.matched).map(([k, v]) => `${k}=${v.band || v.tier || (typeof v.value === 'object' ? 'y' : v.value)}`).join(',');
  return {
    'X-Lynkr-Decision': result.decision || 'none',
    'X-Lynkr-Decision-Tier': result.tier || '',
    'X-Lynkr-Decision-Mode': result.mode,
    'X-Lynkr-Signals': sig.slice(0, 500),
  };
}

module.exports = { evaluate, decideFromSignals, headerSummary, mode: rc.mode };
