#!/usr/bin/env node
/**
 * Off-policy evaluation report (ROUTING-NOTES §3 + §4.10.3).
 *
 * Scores counterfactual routing policies against logged production
 * decisions — no live traffic involved. Reads routing_telemetry rows
 * (propensity + candidates + quality_score, and context where the bandit
 * ran) and prints IPS / SNIPS / DR / WDR estimates for each reference
 * policy, alongside the logged policy's actual mean reward.
 *
 * Usage:
 *   node scripts/ope-report.js [--days 30] [--limit 50000]
 *
 * Reading the output:
 *   - "logged" is what the live policy actually achieved (ground truth).
 *   - A candidate policy whose WDR estimate beats "logged" — with a healthy
 *     effective sample size — is evidence worth acting on. A tiny ESS means
 *     a few high-weight rows dominate; distrust the number regardless of
 *     how good it looks.
 *   - Rows logged before the `context` column existed contribute to
 *     IPS/SNIPS but not to the DR regression term (drRows shows coverage).
 */

const telemetry = require('../src/routing/telemetry');
const { evaluatePolicy, policies } = require('../src/routing/ope');

function arg(name, fallback) {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1 || idx + 1 >= process.argv.length) return fallback;
  const n = Number.parseInt(process.argv[idx + 1], 10);
  return Number.isNaN(n) ? fallback : n;
}

const days = arg('days', 30);
const limit = arg('limit', 50_000);

const rows = telemetry.query({
  since: Date.now() - days * 24 * 60 * 60 * 1000,
  limit,
});

if (rows.length === 0) {
  console.log(`No telemetry rows in the last ${days} days.`);
  process.exit(0);
}

// Multi-candidate rows are where policies can actually differ; single-
// candidate rows contribute identically to every policy's estimate.
const multiCandidate = rows.filter((r) => {
  try {
    const c = typeof r.candidates === 'string' ? JSON.parse(r.candidates) : r.candidates;
    return Array.isArray(c) && c.length > 1;
  } catch {
    return false;
  }
});

console.log(`\nOff-policy evaluation — last ${days} days`);
console.log(`rows: ${rows.length} total, ${multiCandidate.length} with a real choice (>1 candidate)\n`);

const fmt = (v) => (v == null ? '   n/a' : (v * 100).toFixed(2).padStart(6));

const results = [];
for (const [name, policyFn] of Object.entries(policies)) {
  const r = evaluatePolicy(rows, policyFn);
  results.push({ name, ...r });
}

const logged = results[0]?.loggedMeanReward;
console.log(`logged policy actual mean reward: ${logged == null ? 'n/a' : (logged * 100).toFixed(2)} (quality points)\n`);
console.log('policy                 |    IPS |  SNIPS |     DR |    WDR |     ESS | usable | drRows');
console.log('-----------------------+--------+--------+--------+--------+---------+--------+-------');
for (const r of results) {
  console.log(
    `${r.name.padEnd(22)} | ${fmt(r.ips)} | ${fmt(r.snips)} | ${fmt(r.dr)} | ${fmt(r.wdr)} | ${String(r.effectiveSampleSize == null ? 'n/a' : Math.round(r.effectiveSampleSize)).padStart(7)} | ${String(r.usable).padStart(6)} | ${String(r.drRows).padStart(6)}`
  );
}
console.log('\nEstimates are quality points (0-100 scale). Prefer WDR; check ESS before trusting any gap.');
