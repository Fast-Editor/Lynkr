#!/usr/bin/env node
/**
 * lynkr route --preview <request.json|->   Explain how a request would route.
 *
 * Runs the full routing decision (signals, legacy chain, decision engine)
 * without calling any provider or writing telemetry. Prints every signal's
 * value, the legacy tier, the matched decision and its tier/effort, and
 * whether observe/enforce mode would change the served tier.
 *
 * Options: --json   machine-readable output
 *          --config <path>  use an alternative config/routing.json
 */
'use strict';

const fs = require('fs');
const path = require('path');

function main() {
  const argv = process.argv.slice(2);
  const json = argv.includes('--json');
  const ci = argv.indexOf('--config');
  if (ci >= 0) process.env.LYNKR_ROUTING_CONFIG = path.resolve(argv[ci + 1]);
  const pi = argv.indexOf('--preview');
  const file = pi >= 0 ? argv[pi + 1] : argv.find((a) => !a.startsWith('--'));
  if (!file) {
    console.error('usage: lynkr route --preview <request.json|-> [--json] [--config routing.json]');
    process.exit(2);
  }
  const raw = file === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(file, 'utf8');
  let payload;
  try { payload = JSON.parse(raw); } catch (e) { console.error(`not JSON: ${e.message}`); process.exit(2); }
  if (typeof payload === 'string' || (payload && !payload.messages)) {
    // Bare text → a single user message.
    const text = typeof payload === 'string' ? payload : raw;
    payload = { messages: [{ role: 'user', content: text }], tools: [] };
  }

  // Load the operator .env like the server does; silence logs.
  const envPath = fs.existsSync(path.join(process.cwd(), '.env')) ? path.join(process.cwd(), '.env') : path.join(require('os').homedir(), '.env');
  require('dotenv').config({ path: envPath });
  process.env.LOG_LEVEL = 'silent'; process.env.LOG_FILE_ENABLED = 'false';

  const { determineProviderSmart } = require('../src/routing');
  const rc = require('../src/routing/routing-config');

  (async () => {
    const d = await determineProviderSmart(payload, {});
    const e = d.engine || null;
    const out = {
      config: { path: rc.configPath(), mode: rc.mode() },
      legacy: { tier: d.tier, provider: d.provider, model: d.model, method: d.method, score: d.score ?? null, anchorScore: d.analysis?.anchorScore ?? null, escalations: d.escalations || [] },
      judge: d.analysis?.jev ? { tier: d.analysis.jev.tier, confidence: d.analysis.jev.confidence, probabilities: d.analysis.jev.probabilities } : null,
      shortfall: d.shortfall ? { selected: d.shortfall.selected, lift: d.shortfall.lift, req: d.shortfall.req } : null,
      engine: e ? { decision: e.decision, tier: e.tier, effort: e.effort, hosts: e.hosts, mode: e.mode, agreesWithLegacy: e.agreesWithLegacy, considered: e.trace?.considered, signals: e.signals } : null,
      served: e && e.mode === 'enforce' && e.tier ? e.tier : d.tier,
    };
    if (json) { console.log(JSON.stringify(out, null, 2)); return; }
    const pad = (s, n) => String(s ?? '').padEnd(n);
    console.log(`\nconfig   ${out.config.path}  (mode: ${out.config.mode})`);
    console.log(`\nSIGNALS`);
    for (const [k, v] of Object.entries(out.engine?.signals || {})) {
      const val = v.band || v.tier || (v.value && typeof v.value === 'object' ? JSON.stringify(v.value) : v.value);
      console.log(`  ${pad(k, 12)} ${v.matched ? 'matched  ' : '-        '} ${pad(val, 22)} ${v.confidence != null ? 'conf ' + Number(v.confidence).toFixed(2) : ''}`);
    }
    console.log(`\nLEGACY   tier=${out.legacy.tier}  model=${out.legacy.model}  method=${out.legacy.method}  anchor=${out.legacy.anchorScore}` + (out.judge ? `  judge=${out.judge.tier}@${out.judge.confidence}` : ''));
    if (out.legacy.escalations.length) console.log(`         escalations: ${out.legacy.escalations.map((x) => `${x.source}:${x.fromTier}→${x.toTier}`).join(', ')}`);
    if (out.shortfall) console.log(`SHORTFALL wants ${out.shortfall.selected?.tier}:${out.shortfall.selected?.model}  lift=${(out.shortfall.lift || []).join('+') || '-'}`);
    console.log(`\nDECISIONS`);
    for (const c of (out.engine?.considered || [])) console.log(`  ${c.matched ? '✔' : '·'} ${pad(c.name, 32)} priority ${c.priority}`);
    console.log(`\nENGINE   decision=${out.engine?.decision}  tier=${out.engine?.tier}  effort=${out.engine?.effort ?? '-'}  hosts=${out.engine?.hosts ? out.engine.hosts.join(',') : '-'}`);
    console.log(`SERVED   ${out.served}${out.engine && !out.engine.agreesWithLegacy ? (out.engine.mode === 'enforce' ? '  (engine overrode legacy)' : '  (observe: engine would pick ' + out.engine.tier + ')') : ''}\n`);
  })().catch((err) => { console.error(err); process.exit(1); });
}

if (require.main === module || process.env._LYNKR_SUBCMD === 'route') main();
module.exports = { main };
