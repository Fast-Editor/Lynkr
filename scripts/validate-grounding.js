#!/usr/bin/env node
/**
 * Validate the grounding check against a Terminal-Bench run.
 *
 * For every task whose final reply claimed completion, run grounding.check()
 * with the evidence the model actually saw (that episode's prompt), and
 * compare the verdict with the test result. Reports the confusion matrix:
 * flagged false-completions (good) vs flagged true-completions (bad).
 *
 * Usage: node scripts/validate-grounding.js --run ~/tb-runs-lynkr-v14 [--threshold 0.6]
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

async function main() {
  const argv = process.argv.slice(2);
  const run = findRunRoot(expand(argv[argv.indexOf('--run') + 1] || '')); if (!run) { console.error('--run <dir> required'); process.exit(2); }
  const ti = argv.indexOf('--threshold'); const threshold = ti >= 0 ? Number(argv[ti + 1]) : 0.6;
  const envPath = fs.existsSync(path.join(process.cwd(), '.env')) ? path.join(process.cwd(), '.env') : path.join(os.homedir(), '.env');
  require('dotenv').config({ path: envPath });
  process.env.LOG_LEVEL = 'silent'; process.env.LOG_FILE_ENABLED = 'false';
  const grounding = require('../src/routing/grounding');
  await grounding.warm();
  const results = JSON.parse(fs.readFileSync(path.join(run, 'results.json'), 'utf8')).results;
  const rows = [];
  for (const r of results) {
    const tdir = path.join(run, r.task_id); let trial;
    try { trial = fs.readdirSync(tdir).find((x) => fs.existsSync(path.join(tdir, x, 'agent-logs'))); } catch { continue; }
    if (!trial) continue;
    const eps = fs.readdirSync(path.join(tdir, trial, 'agent-logs')).filter((e) => e.startsWith('episode-')).sort((a, b) => Number(a.split('-')[1]) - Number(b.split('-')[1]));
    if (!eps.length) continue;
    const last = path.join(tdir, trial, 'agent-logs', eps[eps.length - 1]);
    let reply, prompt; try { reply = fs.readFileSync(path.join(last, 'response.json'), 'utf8'); prompt = fs.readFileSync(path.join(last, 'prompt.txt'), 'utf8'); } catch { continue; }
    const g = await grounding.check({ replyText: reply, evidence: prompt, onlyWhenDone: true, threshold });
    if (g.verdict === 'skipped' && g.reason === 'no_completion_claim') continue;
    rows.push({ task: r.task_id, resolved: !!r.is_resolved, verdict: g.verdict, maxContradiction: g.maxContradiction ?? null, minEntailment: g.minEntailment ?? null, ms: g.ms });
  }
  const flagged = (v) => v === 'contradicted';
  const tp = rows.filter((x) => !x.resolved && flagged(x.verdict)).length; // false completion caught
  const fn = rows.filter((x) => !x.resolved && !flagged(x.verdict)).length;
  const fp = rows.filter((x) => x.resolved && flagged(x.verdict)).length;  // true completion wrongly flagged
  const tn = rows.filter((x) => x.resolved && !flagged(x.verdict)).length;
  console.log(`\nrun ${run}\ncompletion claims: ${rows.length}  (false completions ${tp + fn}, true completions ${fp + tn})  threshold ${threshold}`);
  console.log(`  caught false completions : ${tp}/${tp + fn}  (${tp + fn ? Math.round(100 * tp / (tp + fn)) : 0}%)`);
  console.log(`  wrongly flagged true ones : ${fp}/${fp + tn}  (${fp + tn ? Math.round(100 * fp / (fp + tn)) : 0}%)`);
  const byVerdict = {}; for (const x of rows) { const k = `${x.resolved ? 'PASS' : 'FAIL'}:${x.verdict}`; byVerdict[k] = (byVerdict[k] || 0) + 1; }
  console.log('  verdict matrix:', JSON.stringify(byVerdict));
  console.log(`  median ms/check: ${rows.map((x) => x.ms).sort((a, b) => a - b)[Math.floor(rows.length / 2)]}`);
  console.log('\n  false completions NOT caught:', rows.filter((x) => !x.resolved && !flagged(x.verdict)).map((x) => `${x.task}(${x.verdict},c=${x.maxContradiction})`).join(', '));
  console.log('  true completions flagged   :', rows.filter((x) => x.resolved && flagged(x.verdict)).map((x) => `${x.task}(c=${x.maxContradiction})`).join(', ') || 'none');
  const outPath = path.join(run, 'grounding-validation.json'); fs.writeFileSync(outPath, JSON.stringify({ threshold, rows }, null, 1)); console.log(`\n  rows → ${outPath}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
