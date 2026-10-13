#!/usr/bin/env node
/**
 * lynkr audit <session_id|--last N>   Per-session routing ledger from telemetry.
 *
 * Prints, per turn: time, tier, model, decision, effort, latency, status,
 * cost, judge verdict, previous-turn outcome. Totals at the bottom.
 * Reads <cwd>/.lynkr/telemetry.db (same path the server writes).
 */
'use strict';

const path = require('path');
const fs = require('fs');

function main() {
  const argv = process.argv.slice(2);
  const json = argv.includes('--json');
  const lastIdx = argv.indexOf('--last');
  const lastVal = lastIdx >= 0 ? argv[lastIdx + 1] : null;
  const sessionId = argv.find((a) => !a.startsWith('--') && a !== lastVal);
  const dbPath = path.resolve(process.cwd(), '.lynkr', 'telemetry.db');
  if (!fs.existsSync(dbPath)) { console.error(`no telemetry db at ${dbPath}`); process.exit(2); }
  const Database = require('better-sqlite3');
  const db = new Database(dbPath, { readonly: true });

  if (!sessionId) {
    const n = lastIdx >= 0 ? Number(argv[lastIdx + 1]) || 10 : 10;
    const rows = db.prepare(`SELECT session_id, COUNT(*) turns, MIN(timestamp) t0, MAX(timestamp) t1, SUM(cost_usd) cost,
        SUM(status_code != 200) errors, GROUP_CONCAT(DISTINCT tier) tiers
      FROM routing_telemetry WHERE session_id IS NOT NULL GROUP BY session_id ORDER BY t1 DESC LIMIT ?`).all(n);
    if (json) { console.log(JSON.stringify(rows, null, 2)); return; }
    console.log(`\nlast ${rows.length} sessions`);
    for (const r of rows) console.log(`  ${r.session_id}  turns=${String(r.turns).padStart(3)}  tiers=${r.tiers}  cost=$${(r.cost || 0).toFixed(4)}  errors=${r.errors}  ${new Date(r.t1).toISOString()}`);
    console.log(`\nlynkr audit <session_id> for the per-turn ledger\n`);
    return;
  }
  const rows = db.prepare(`SELECT id, timestamp, tier, model, provider, routing_method, decision_name, engine_tier, engine_mode, effort,
      latency_ms, status_code, error_type, cost_usd, input_tokens, output_tokens, cache_read_tokens,
      jev_verdict, jev_confidence, prev_turn_outcome, prev_turn_attributable, escalation_source
    FROM routing_telemetry WHERE session_id = ? ORDER BY id`).all(sessionId);
  if (!rows.length) { console.error(`no rows for session ${sessionId}`); process.exit(1); }
  if (json) { console.log(JSON.stringify(rows, null, 2)); return; }
  const pad = (s, n) => String(s ?? '-').padEnd(n);
  console.log(`\nsession ${sessionId}  (${rows.length} turns)\n`);
  console.log(`  ${pad('#', 3)} ${pad('time', 8)} ${pad('tier', 9)} ${pad('model', 30)} ${pad('decision', 22)} ${pad('eff', 6)} ${pad('ms', 7)} ${pad('st', 4)} ${pad('$', 9)} ${pad('judge', 14)} ${pad('prev-outcome', 16)}`);
  let cost = 0, inTok = 0, outTok = 0, cached = 0, errs = 0;
  rows.forEach((r, i) => {
    cost += r.cost_usd || 0; inTok += r.input_tokens || 0; outTok += r.output_tokens || 0; cached += r.cache_read_tokens || 0; if (r.status_code !== 200) errs++;
    const t = new Date(r.timestamp).toISOString().slice(11, 19);
    const dec = r.decision_name ? `${r.decision_name}${r.engine_tier && r.engine_tier !== r.tier ? '→' + r.engine_tier : ''}` : '-';
    const judge = r.jev_verdict ? `${r.jev_verdict}@${Number(r.jev_confidence || 0).toFixed(2)}` : '-';
    const po = r.prev_turn_outcome ? `${r.prev_turn_outcome}${r.prev_turn_attributable ? '' : '(env)'}` : '-';
    console.log(`  ${pad(i + 1, 3)} ${pad(t, 8)} ${pad(r.tier, 9)} ${pad(String(r.model || '').split('/').pop().slice(0, 30), 30)} ${pad(dec.slice(0, 22), 22)} ${pad(r.effort, 6)} ${pad(r.latency_ms, 7)} ${pad(r.status_code, 4)} ${pad((r.cost_usd || 0).toFixed(5), 9)} ${pad(judge, 14)} ${pad(po, 16)}${r.escalation_source ? '  esc:' + r.escalation_source : ''}`);
  });
  console.log(`\n  cost $${cost.toFixed(4)}   in ${inTok} (cached ${cached}, ${inTok ? Math.round(100 * cached / (inTok + cached)) : 0}%)   out ${outTok}   errors ${errs}\n`);
}

if (require.main === module || process.env._LYNKR_SUBCMD === 'audit') main();
module.exports = { main };
