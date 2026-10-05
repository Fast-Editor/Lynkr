#!/usr/bin/env node
/**
 * Build / refresh the routing corpus fixtures used by test/routing-corpus.test.js.
 *
 * For every recorded request (a directory tree of Terminal-Bench runs, or any
 * directory of *.json request bodies), run the full routing decision under
 * the given config and store the signal snapshot plus the decision reached.
 *
 * Usage:
 *   node scripts/build-routing-corpus.js --from <run-dir|requests-dir> \
 *     --config config/routing.example.json --out test/fixtures/routing-corpus/<name>.json
 *
 * Needs the operator .env (embeddings, judge key) like the server does.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

function arg(name, dflt) { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : dflt; }

async function main() {
  const from = arg('--from'); const cfgPath = arg('--config', 'config/routing.example.json'); const out = arg('--out');
  if (!from || !out) { console.error('usage: --from <dir> --config <routing.json> --out <fixture.json>'); process.exit(2); }
  const envPath = fs.existsSync(path.join(process.cwd(), '.env')) ? path.join(process.cwd(), '.env') : path.join(os.homedir(), '.env');
  require('dotenv').config({ path: envPath });
  process.env.LOG_LEVEL = 'silent'; process.env.LOG_FILE_ENABLED = 'false';
  process.env.LYNKR_ROUTING_CONFIG = path.resolve(cfgPath);
  const { determineProviderSmart } = require('../src/routing');

  // Collect requests: Terminal-Bench layout (<task>/<trial>/agent-logs/episode-0/prompt.txt) or *.json bodies.
  const requests = [];
  for (const entry of fs.readdirSync(from)) {
    const p = path.join(from, entry);
    if (entry.endsWith('.json') && fs.statSync(p).isFile()) { requests.push({ name: entry.replace(/\.json$/, ''), payload: JSON.parse(fs.readFileSync(p, 'utf8')) }); continue; }
    if (!fs.statSync(p).isDirectory()) continue;
    const trial = fs.readdirSync(p).find((x) => fs.existsSync(path.join(p, x, 'agent-logs', 'episode-0', 'prompt.txt')));
    if (trial) requests.push({ name: entry, payload: { messages: [{ role: 'user', content: fs.readFileSync(path.join(p, trial, 'agent-logs', 'episode-0', 'prompt.txt'), 'utf8') }], tools: [] } });
  }
  const fixtures = []; const dist = {};
  for (const r of requests) {
    const d = await determineProviderSmart(r.payload, {});
    const e = d.engine; if (!e) continue;
    const signals = {};
    for (const [k, v] of Object.entries(e.signals)) signals[k] = { matched: v.matched, value: (v.value && typeof v.value === 'object') ? null : v.value, confidence: v.confidence, band: v.band, tier: v.tier };
    fixtures.push({ task: r.name, legacyTier: d.tier, signals, expected: { decision: e.decision, tier: e.tier, effort: e.effort } });
    dist[e.decision] = (dist[e.decision] || 0) + 1;
  }
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify({ generated: new Date().toISOString(), config: path.relative(process.cwd(), path.resolve(cfgPath)), fixtures }, null, 1));
  console.log(`wrote ${fixtures.length} fixtures → ${out}; decisions: ${JSON.stringify(dist)}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
