#!/usr/bin/env node
/**
 * WS7.2 — replay real telemetry request texts through the anchor classifier
 * and measure whether {trivial, substantive, heavyweight} separate cleanly
 * in cosine space. This is the evidence gate for keeping the three-way
 * blend (vs collapsing to a single cheap-vs-capable threshold).
 *
 * Usage: node scripts/ws7-anchor-replay.js [--db .lynkr/telemetry.db] [--limit N]
 * Requires: local Ollama with the configured embeddings model.
 *
 * Reports:
 *  - per-class counts + score distribution
 *  - top-2 sim margin per class (median/p25) — the separation metric.
 *    Margin >= ~0.05 median = classes separate; < 0.02 = collapse to binary.
 *  - tier movement vs the recorded (lexical-era) tier.
 */
const path = require('path');
const Database = require('better-sqlite3');

const args = process.argv.slice(2);
const dbPath = args.includes('--db')
  ? args[args.indexOf('--db') + 1]
  : path.join(__dirname, '../.lynkr/telemetry.db');
const limit = args.includes('--limit') ? Number(args[args.indexOf('--limit') + 1]) : 100000;

const MINING_SQL = `
  SELECT DISTINCT request_text, tier, quality_score FROM routing_telemetry
  WHERE request_text IS NOT NULL AND length(request_text)>3
    AND request_text NOT LIKE '%system-reminder%'
    AND request_text NOT LIKE '%SUGGESTION MODE%'
    AND request_text NOT LIKE '%[Lynkr]%'
    AND request_text NOT LIKE 'quota%'
    AND request_text NOT LIKE '<session>%' AND request_text NOT LIKE '<conversation>%'
  LIMIT ?`;

function pct(arr, p) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}

async function main() {
  const { scoreIntent, getDefaultCentroids } = require('../src/routing/intent-score');
  const { getModelTierSelector } = require('../src/routing/model-tiers');

  const centroids = await getDefaultCentroids();
  if (!centroids) {
    console.error('FATAL: could not build anchor centroids — is Ollama running with the embeddings model?');
    process.exit(1);
  }

  const db = new Database(dbPath, { readonly: true });
  const rows = db.prepare(MINING_SQL).all(limit);
  console.log(`Mined ${rows.length} distinct request texts from ${dbPath}\n`);

  const selector = getModelTierSelector();
  const byClass = {};
  const margins = { trivial: [], substantive: [], heavyweight: [] };
  const moves = {};
  let anchorMode = 0;
  let lexicalFallback = 0;

  for (const row of rows) {
    const r = await scoreIntent({ messages: [{ role: 'user', content: row.request_text }] });
    if (!r) continue;
    if (r.mode !== 'anchor') { lexicalFallback++; continue; }
    anchorMode++;
    const cls = r.class;
    byClass[cls] = byClass[cls] || { n: 0, scores: [], examples: [] };
    byClass[cls].n++;
    byClass[cls].scores.push(r.score);
    if (byClass[cls].examples.length < 4) {
      byClass[cls].examples.push(`${r.score.toString().padStart(2)}  ${row.request_text.slice(0, 90).replace(/\n/g, ' ')}`);
    }
    const sims = Object.entries(r.sims).sort((a, b) => b[1] - a[1]);
    margins[cls].push(sims[0][1] - sims[1][1]);

    const newTier = selector.getTier(r.score);
    const oldTier = row.tier || '??';
    const key = `${oldTier} -> ${newTier}`;
    moves[key] = (moves[key] || 0) + 1;
  }

  console.log(`Scored: ${anchorMode} anchor-mode, ${lexicalFallback} lexical-fallback\n`);
  console.log('=== Class distribution + score stats ===');
  for (const [cls, d] of Object.entries(byClass)) {
    console.log(`\n${cls}: n=${d.n}  score median=${pct(d.scores, 50)}  p10=${pct(d.scores, 10)}  p90=${pct(d.scores, 90)}`);
    console.log(`  top-2 sim margin: median=${pct(margins[cls], 50)?.toFixed(4)}  p25=${pct(margins[cls], 25)?.toFixed(4)}  min=${Math.min(...margins[cls]).toFixed(4)}`);
    for (const e of d.examples) console.log(`    ${e}`);
  }

  console.log('\n=== Tier movement (recorded lexical-era tier -> anchor tier) ===');
  for (const [k, v] of Object.entries(moves).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k}: ${v}`);
  }

  const allMargins = Object.values(margins).flat();
  const med = pct(allMargins, 50);
  console.log(`\n=== VERDICT ===`);
  console.log(`Overall top-2 sim margin: median=${med?.toFixed(4)}  p25=${pct(allMargins, 25)?.toFixed(4)}`);
  console.log(med >= 0.05
    ? 'Classes separate cleanly (median margin >= 0.05) — three-way blend is supported by the data.'
    : med >= 0.02
      ? 'Borderline separation — keep three-way but watch misroutes; consider more anchors.'
      : 'Classes do NOT separate — collapse to binary (trivial vs rest).');
}

main().catch((err) => { console.error(err); process.exit(1); });
