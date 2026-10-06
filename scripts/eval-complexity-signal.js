#!/usr/bin/env node
/**
 * Evaluate the complexity signal (and, for comparison, the anchor score and the
 * structural requirement) as predictors of pass/fail on a Terminal-Bench run.
 *
 * Prints AUC per predictor against the strong model's solo outcomes and the
 * cheap model's outcomes. AUC 0.5 = no information.
 *
 * Usage: node scripts/eval-complexity-signal.js --prompts ~/tb-runs-lynkr-v14 \
 *          --strong ~/tb-runs-auto-v2 [--cheap ~/tb-runs-lynkr-v14]
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
function outcomes(root) { const o = {}; for (const r of JSON.parse(fs.readFileSync(path.join(root, 'results.json'), 'utf8')).results) o[r.task_id] = !!r.is_resolved; return o; }
function auc(scores, labels) {
  // probability that a random FAIL task scores higher (harder) than a random PASS task
  const pos = [], neg = [];
  scores.forEach((s, i) => { if (s == null) return; (labels[i] ? neg : pos).push(s); });
  if (!pos.length || !neg.length) return null;
  let wins = 0; for (const p of pos) for (const n of neg) wins += p > n ? 1 : p === n ? 0.5 : 0;
  return wins / (pos.length * neg.length);
}

async function main() {
  const argv = process.argv.slice(2);
  const arg = (k) => { const i = argv.indexOf(k); return i >= 0 ? expand(argv[i + 1]) : null; };
  const promptsRoot = findRunRoot(arg('--prompts')); const strongRoot = findRunRoot(arg('--strong')); const cheapRoot = arg('--cheap') ? findRunRoot(arg('--cheap')) : null;
  if (!promptsRoot || !strongRoot) { console.error('--prompts and --strong run dirs required'); process.exit(2); }
  const envPath = fs.existsSync(path.join(process.cwd(), '.env')) ? path.join(process.cwd(), '.env') : path.join(os.homedir(), '.env');
  require('dotenv').config({ path: envPath }); process.env.LOG_LEVEL = 'silent'; process.env.LOG_FILE_ENABLED = 'false';
  const { determineProviderSmart } = require('../src/routing');
  const strong = outcomes(strongRoot); const cheap = cheapRoot ? outcomes(cheapRoot) : null;
  const tasks = Object.keys(strong);
  const rows = [];
  for (const t of tasks) {
    const tdir = path.join(promptsRoot, t); let trial; try { trial = fs.readdirSync(tdir).find((x) => fs.existsSync(path.join(tdir, x, 'agent-logs', 'episode-0', 'prompt.txt'))); } catch { continue; }
    if (!trial) continue;
    const raw = fs.readFileSync(path.join(tdir, trial, 'agent-logs', 'episode-0', 'prompt.txt'), 'utf8');
    const d = await determineProviderSmart({ messages: [{ role: 'user', content: raw }], tools: [] }, {});
    const sig = d.engine?.signals || {};
    const struct = d.shortfall?.structuralReq ? Object.values(d.shortfall.structuralReq).reduce((a, b) => a + b, 0) / 4 : null;
    const lifted = d.shortfall?.req ? Object.values(d.shortfall.req).reduce((a, b) => a + b, 0) / 4 : null;
    rows.push({ task: t, anchor: sig.anchor?.value ?? null, judgeP: sig.judge?.probabilities ? (sig.judge.probabilities.COMPLEX || 0) + (sig.judge.probabilities.REASONING || 0) : null, complexity: sig.complexity?.value ?? null, structural: struct, lifted, strongPass: strong[t], cheapPass: cheap ? cheap[t] : null });
  }
  const preds = ['anchor', 'judgeP', 'complexity', 'structural', 'lifted'];
  console.log(`\n${rows.length} tasks. AUC = P(predictor ranks a FAILED task as harder than a PASSED one). 0.50 = no information.\n`);
  console.log(`${'predictor'.padEnd(12)} ${'vs strong solo'.padStart(15)} ${'vs cheap'.padStart(10)}   coverage`);
  for (const p of preds) {
    const s = rows.map((r) => r[p]);
    const a1 = auc(s, rows.map((r) => r.strongPass)); const a2 = cheap ? auc(s, rows.map((r) => r.cheapPass)) : null;
    console.log(`${p.padEnd(12)} ${a1 == null ? '   n/a' : a1.toFixed(3).padStart(15)} ${a2 == null ? '      n/a' : a2.toFixed(3).padStart(10)}   ${s.filter((x) => x != null).length}/${rows.length}`);
  }
  const outPath = path.join(promptsRoot, 'complexity-eval.json'); fs.writeFileSync(outPath, JSON.stringify(rows, null, 1)); console.log(`\nrows → ${outPath}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
