#!/usr/bin/env node
/**
 * Build config/complexity-exemplars.json from measured task outcomes.
 *
 * "Hard" exemplars are task instructions the STRONG model failed in every
 * solo run supplied; "easy" exemplars are instructions the CHEAP model passed.
 * Everything else is left out (ambiguous). The complexity signal
 * (signals.js, type: complexity) embeds both sets once and scores a request
 * as sim(hard) − sim(easy), normalised to [0,1].
 *
 * Usage:
 *   node scripts/build-complexity-exemplars.js \
 *     --strong ~/tb-runs-auto-v2 [--strong ~/tb-runs-auto-full] \
 *     --cheap ~/tb-runs-lynkr-v14 --cheap-model glm-5.3-flash \
 *     [--out config/complexity-exemplars.json]
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

function expand(p) { return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : path.resolve(p); }
function findRunRoot(dir) {
  if (fs.existsSync(path.join(dir, 'results.json'))) return dir;
  const subs = fs.readdirSync(dir).filter((d) => fs.existsSync(path.join(dir, d, 'results.json'))).sort().reverse();
  return subs.length ? path.join(dir, subs[0]) : null;
}
function loadRun(root) {
  const res = JSON.parse(fs.readFileSync(path.join(root, 'results.json'), 'utf8')).results || [];
  const out = {};
  for (const r of res) out[r.task_id] = { resolved: !!r.is_resolved, instruction: r.instruction || null };
  return out;
}
function servedBy(root, task, needle) {
  // share of episodes whose debug record names the model
  const tdir = path.join(root, task); let trial;
  try { trial = fs.readdirSync(tdir).find((x) => fs.existsSync(path.join(tdir, x, 'agent-logs'))); } catch { return 0; }
  if (!trial) return 0;
  const eps = fs.readdirSync(path.join(tdir, trial, 'agent-logs')).filter((e) => e.startsWith('episode-'));
  let hit = 0, n = 0;
  for (const e of eps) {
    try { const s = JSON.parse(fs.readFileSync(path.join(tdir, trial, 'agent-logs', e, 'debug.json'), 'utf8')).original_response || ''; n++; if (s.toLowerCase().includes(needle.toLowerCase())) hit++; } catch { /* skip */ }
  }
  return n ? hit / n : 0;
}

function main() {
  const argv = process.argv.slice(2);
  const strong = [], cheap = []; let cheapModel = null, out = path.join(__dirname, '..', 'config', 'complexity-exemplars.json');
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--strong') strong.push(expand(argv[++i]));
    else if (argv[i] === '--cheap') cheap.push(expand(argv[++i]));
    else if (argv[i] === '--cheap-model') cheapModel = argv[++i];
    else if (argv[i] === '--out') out = expand(argv[++i]);
  }
  if (!strong.length) { console.error('need at least one --strong run dir'); process.exit(2); }
  const strongRuns = strong.map(findRunRoot).filter(Boolean).map(loadRun);
  const cheapRoots = cheap.map(findRunRoot).filter(Boolean);
  const cheapRuns = cheapRoots.map(loadRun);
  const tasks = new Set(); strongRuns.forEach((r) => Object.keys(r).forEach((t) => tasks.add(t)));
  const hard = [], easy = [], skipped = [];
  for (const t of tasks) {
    const instr = strongRuns.map((r) => r[t]?.instruction).find(Boolean); if (!instr) continue;
    const strongFailedAll = strongRuns.every((r) => r[t] && !r[t].resolved);
    const strongPassedAny = strongRuns.some((r) => r[t] && r[t].resolved);
    let cheapPassed = false;
    cheapRuns.forEach((r, i) => { if (r[t]?.resolved && (!cheapModel || servedBy(cheapRoots[i], t, cheapModel) >= 0.8)) cheapPassed = true; });
    if (strongFailedAll) hard.push({ task: t, text: instr.slice(0, 1200) });
    else if (cheapPassed) easy.push({ task: t, text: instr.slice(0, 1200) });
    else if (strongPassedAny) skipped.push(t);
  }
  const heads = ['reasoning', 'codegen', 'debugging', 'tool_use'];
  const doc = {
    generated: new Date().toISOString(),
    note: 'hard = strong model failed every supplied solo run; easy = cheap model passed. Edit freely; the signal embeds these at load.',
    // One shared pool per side; per-head pools can be curated later.
    heads: Object.fromEntries(heads.map((h) => [h, { hard: hard.map((x) => x.text), easy: easy.map((x) => x.text) }])),
    provenance: { hard: hard.map((x) => x.task), easy: easy.map((x) => x.task), ambiguous: skipped },
  };
  fs.writeFileSync(out, JSON.stringify(doc, null, 1));
  console.log(`hard ${hard.length}, easy ${easy.length}, ambiguous ${skipped.length} → ${out}`);
}
main();
