#!/usr/bin/env node
/**
 * Calibrate shortfall capability profiles from measured task outcomes.
 *
 * Why: config/model-capabilities.json ships profiles seeded from public
 * leaderboards (scripts/seed-capabilities.js) and a fixed tolerance from a
 * paper. Neither was measured on YOUR tasks — live incident: the shipped
 * seed put glm-5.3-flash at ~0.65 (full GLM-5.3 family), so the cheap tier
 * "covered" every requirement and cheapest-covering demoted tasks the
 * strong model had solved. This script replaces guesses with a pass/fail
 * matrix: one solo benchmark run per model, replayed through the router.
 *
 * Phases (each skipped when its output already exists):
 *   1. run     — for every --model WITHOUT an existing run dir, start a
 *                throwaway Lynkr on a spare port with all four tiers pinned
 *                to that model and run Terminal-Bench against it. Needs
 *                --run (spends money; ~1h and $1–5 per model).
 *   2. replay  — score every task's first prompt through the live router
 *                (determineProviderSmart) to get the lifted requirement
 *                vector per head. Cached in <out>/requirements.json.
 *   3. fit     — per model/head: capability = highest difficulty level at
 *                which the model still passes >= --floor of tasks (and
 *                >= --rel × the best model at that level); tau = median gap
 *                from capability to the collapse point. Hold-out check:
 *                shortfall with the fitted numbers vs "best model
 *                everywhere" on accuracy and cost.
 *   4. write   — <out>/report.md + <out>/model-capabilities.proposed.json;
 *                --apply merges modelOverrides + tau into the live config
 *                (backup first).
 *
 * Usage:
 *   node scripts/calibrate-capabilities.js \
 *     --model openrouter:z-ai/glm-5.3-flash \
 *     --model openrouter:deepseek/deepseek-v4.1-flash=~/tb-runs-auto-v2 \
 *     [--out ~/lynkr-calibration] [--dataset terminal-bench-core==0.1.1]
 *     [--concurrency 8] [--port 8091] [--price model=in/cache/out] \
 *     [--floor 0.5] [--rel 0.85] [--run] [--apply] [--dry-run]
 *
 *   model=path  reuse an existing Terminal-Bench run directory (a directory
 *               containing results.json, or its parent) instead of running.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const HEADS = ['reasoning', 'codegen', 'debugging', 'tool_use'];
const CONFIG_PATH = path.join(ROOT, 'config', 'model-capabilities.json');

// $ per 1M tokens: input / cache-read / output. Extend with --price.
const DEFAULT_PRICES = {
  'deepseek-v4.1-flash': [0.15, 0.003, 0.60],
  'deepseek-v4p1-flash': [0.30, 0.006, 1.20],
  'glm-5.3-flash': [0.15, 0.03, 0.50],
  'glm-5p3-flash': [0.15, 0.03, 0.50],
};

// ---------------------------------------------------------------------------
// args
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const out = {
    models: [], out: path.join(os.homedir(), 'lynkr-calibration'),
    dataset: 'terminal-bench-core==0.1.1', concurrency: 8, port: 8091,
    prices: { ...DEFAULT_PRICES }, floor: 0.5, rel: 0.85,
    run: false, apply: false, dryRun: false, holdoutEvery: 4,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--model') {
      const v = next(); const eq = v.indexOf('=');
      out.models.push(eq > 0 ? { spec: v.slice(0, eq), runDir: expand(v.slice(eq + 1)) } : { spec: v, runDir: null });
    } else if (a === '--out') out.out = expand(next());
    else if (a === '--dataset') out.dataset = next();
    else if (a === '--concurrency') out.concurrency = Number(next()) || 8;
    else if (a === '--port') out.port = Number(next()) || 8091;
    else if (a === '--floor') out.floor = Number(next());
    else if (a === '--rel') out.rel = Number(next());
    else if (a === '--holdout-every') out.holdoutEvery = Number(next()) || 4;
    else if (a === '--price') {
      const v = next(); const eq = v.indexOf('=');
      const nums = v.slice(eq + 1).split('/').map(Number);
      if (eq > 0 && nums.length === 3 && nums.every(Number.isFinite)) out.prices[v.slice(0, eq)] = nums;
      else die(`bad --price "${v}" (want model=in/cache/out, $ per 1M)`);
    } else if (a === '--run') out.run = true;
    else if (a === '--apply') out.apply = true;
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--help' || a === '-h') { console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0].replace(/^\/\*\*?\s?/, '').replace(/^ \* ?/gm, '')); process.exit(0); }
    else die(`unknown arg ${a}`);
  }
  if (out.models.length === 0) die('at least one --model is required');
  for (const m of out.models) {
    const c = m.spec.indexOf(':');
    if (c < 0) die(`--model must be provider:model (got "${m.spec}")`);
    m.provider = m.spec.slice(0, c); m.model = m.spec.slice(c + 1);
    m.short = m.model.split('/').pop();
    m.key = `${m.provider}:${m.model}`;
  }
  return out;
}
function expand(p) { return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : path.resolve(p); }
function die(msg) { console.error(`calibrate-capabilities: ${msg}`); process.exit(2); }
function log(msg) { console.log(`[calibrate] ${msg}`); }

// ---------------------------------------------------------------------------
// run dirs / results
// ---------------------------------------------------------------------------
function findRunRoot(dir) {
  if (!dir || !fs.existsSync(dir)) return null;
  if (fs.existsSync(path.join(dir, 'results.json'))) return dir;
  const subs = fs.readdirSync(dir).filter((d) => fs.existsSync(path.join(dir, d, 'results.json')))
    .sort().reverse();
  return subs.length ? path.join(dir, subs[0]) : null;
}

function readUsageAndModel(debugJsonPath) {
  // Terminus writes LiteLLM's debug record; original_response is either a
  // Python repr (direct OpenRouter arm) or the Anthropic JSON Lynkr returned.
  let s;
  try { s = JSON.parse(fs.readFileSync(debugJsonPath, 'utf8')).original_response || ''; } catch { return null; }
  const num = (re) => { const m = re.exec(s); return m ? Number(m[1]) : null; };
  const model = (/model='([^']+)'/.exec(s) || /"model":"([^"]+)"/.exec(s) || [])[1] || null;
  const cost = num(/\bcost=([0-9.eE+-]+)/);
  let inTok = num(/prompt_tokens=(\d+)/), outTok = num(/completion_tokens=(\d+)/), cached = num(/cached_tokens=(\d+)/) ?? 0;
  if (inTok === null) { // Anthropic shape
    inTok = num(/"input_tokens":(\d+)/); outTok = num(/"output_tokens":(\d+)/); cached = num(/"cache_read_input_tokens":(\d+)/) ?? 0;
    if (inTok !== null) inTok += cached; // Anthropic input excludes cache reads; normalise to "prompt" total
  }
  return { model, cost, inTok: inTok ?? 0, outTok: outTok ?? 0, cached: cached ?? 0 };
}

/** Per task: resolved, served-model share, tokens, provider cost, first prompt path. */
function loadRun(runRoot, wantShort) {
  const results = JSON.parse(fs.readFileSync(path.join(runRoot, 'results.json'), 'utf8')).results || [];
  const tasks = {};
  for (const r of results) {
    const t = r.task_id; const tdir = path.join(runRoot, t);
    let trial = null;
    try { trial = fs.readdirSync(tdir).find((x) => fs.existsSync(path.join(tdir, x, 'agent-logs'))); } catch { /* none */ }
    const eps = trial ? fs.readdirSync(path.join(tdir, trial, 'agent-logs')).filter((e) => e.startsWith('episode-'))
      .sort((a, b) => Number(a.split('-')[1]) - Number(b.split('-')[1])) : [];
    let served = 0, total = 0, inTok = 0, outTok = 0, cached = 0, cost = 0, costKnown = true;
    for (const e of eps) {
      const u = readUsageAndModel(path.join(tdir, trial, 'agent-logs', e, 'debug.json'));
      if (!u) continue;
      total++;
      if (u.model && u.model.toLowerCase().includes(wantShort.toLowerCase())) served++;
      inTok += u.inTok; outTok += u.outTok; cached += u.cached;
      if (u.cost === null) costKnown = false; else cost += u.cost;
    }
    tasks[t] = {
      resolved: !!r.is_resolved, failureMode: r.failure_mode || null,
      episodes: eps.length, servedShare: total ? served / total : 0,
      inTok, outTok, cached, providerCost: costKnown && total ? cost : null,
      promptPath: eps.length ? path.join(tdir, trial, 'agent-logs', eps[0], 'prompt.txt') : null,
    };
  }
  return tasks;
}

function taskCost(entry, price) {
  if (entry.providerCost !== null && entry.providerCost !== undefined) return entry.providerCost;
  if (!price) return null;
  const [pin, pcache, pout] = price;
  const uncached = Math.max(0, entry.inTok - entry.cached);
  return (uncached * pin + entry.cached * pcache + entry.outTok * pout) / 1e6;
}

// ---------------------------------------------------------------------------
// phase 1: run
// ---------------------------------------------------------------------------
function tbBinary() {
  const cands = [path.join(os.homedir(), '.local', 'bin', 'tb'), '/usr/local/bin/tb', 'tb'];
  for (const c of cands) { const r = spawnSync(c, ['--help'], { stdio: 'ignore' }); if (r.status === 0) return c; }
  return null;
}

function portFree(port) {
  const r = spawnSync('ss', ['-tln'], { encoding: 'utf8' });
  return !(r.stdout || '').includes(`:${port} `);
}

async function waitFor(fn, ms, every = 1000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await fn()) return true; await new Promise((r) => setTimeout(r, every)); }
  return false;
}

async function runModel(m, opts) {
  const tb = tbBinary(); if (!tb) die('tb (terminal-bench CLI) not found; install it or pass model=run-dir');
  if (!portFree(opts.port)) die(`port ${opts.port} is in use; pass --port`);
  const home = path.join(opts.out, 'runs', m.short, 'lynkr-home');
  const outDir = path.join(opts.out, 'runs', m.short, 'tb');
  fs.mkdirSync(home, { recursive: true }); fs.mkdirSync(outDir, { recursive: true });
  // Throwaway Lynkr: copy the operator .env, pin all tiers to this model,
  // own port, own telemetry dir (dotenv + telemetry both key off cwd).
  const srcEnv = fs.existsSync(path.join(process.cwd(), '.env')) ? path.join(process.cwd(), '.env') : path.join(os.homedir(), '.env');
  let env = fs.existsSync(srcEnv) ? fs.readFileSync(srcEnv, 'utf8') : '';
  env = env.split('\n').filter((l) => !/^(PORT|TIER_SIMPLE|TIER_MEDIUM|TIER_COMPLEX|TIER_REASONING)=/.test(l)).join('\n');
  env += `\n# --- calibrate-capabilities: solo run for ${m.key} ---\nPORT=${opts.port}\n` +
    ['SIMPLE', 'MEDIUM', 'COMPLEX', 'REASONING'].map((t) => `TIER_${t}=${m.key}`).join('\n') + '\n';
  fs.writeFileSync(path.join(home, '.env'), env);
  log(`starting throwaway Lynkr on :${opts.port} for ${m.key} (cwd ${home})`);
  const lynkr = spawn(process.execPath, [path.join(ROOT, 'index.js')], {
    cwd: home, env: { ...process.env, PORT: String(opts.port) }, stdio: ['ignore', fs.openSync(path.join(home, 'lynkr.log'), 'a'), fs.openSync(path.join(home, 'lynkr.log'), 'a')], detached: false,
  });
  const up = await waitFor(() => !portFree(opts.port), 60000);
  if (!up) { lynkr.kill(); die(`Lynkr did not come up on :${opts.port}; see ${path.join(home, 'lynkr.log')}`); }
  log(`running ${opts.dataset} against ${m.key} (concurrency ${opts.concurrency}) → ${outDir}`);
  const t0 = Date.now();
  const r = spawnSync(tb, ['run', '--dataset', opts.dataset, '--agent', 'terminus', '--model', 'anthropic/claude-sonnet-4-5',
    '--n-concurrent-trials', String(opts.concurrency), '--output-path', outDir], {
    env: { ...process.env, ANTHROPIC_API_BASE: `http://localhost:${opts.port}`, ANTHROPIC_API_KEY: 'lynkr-calibration' },
    stdio: ['ignore', fs.openSync(path.join(outDir, 'tb-stdout.log'), 'a'), fs.openSync(path.join(outDir, 'tb-stdout.log'), 'a')],
    maxBuffer: 1 << 26,
  });
  lynkr.kill();
  log(`run finished in ${Math.round((Date.now() - t0) / 60000)} min (tb exit ${r.status})`);
  const root = findRunRoot(outDir);
  if (!root) die(`no results.json under ${outDir}`);
  return root;
}

// ---------------------------------------------------------------------------
// phase 2: replay
// ---------------------------------------------------------------------------
async function replayRequirements(taskPrompts, cachePath) {
  let cache = {};
  if (fs.existsSync(cachePath)) { try { cache = JSON.parse(fs.readFileSync(cachePath, 'utf8')); } catch { cache = {}; } }
  const todo = Object.entries(taskPrompts).filter(([t]) => !cache[t]);
  if (todo.length === 0) { log(`requirements cached for ${Object.keys(cache).length} tasks`); return cache; }
  // Load the operator .env like the server does, then the router.
  require('dotenv').config({ path: fs.existsSync(path.join(process.cwd(), '.env')) ? path.join(process.cwd(), '.env') : path.join(os.homedir(), '.env') });
  process.env.LOG_FILE_ENABLED = 'false';
  process.env.LOG_LEVEL = 'silent'; // after dotenv: the operator .env usually sets info
  const { determineProviderSmart } = require(path.join(ROOT, 'src', 'routing'));
  const { buildRequirementVector } = require(path.join(ROOT, 'src', 'routing', 'capabilities'));
  const sfmod = require(path.join(ROOT, 'src', 'routing', 'shortfall'));
  log(`replaying ${todo.length} task prompts through the router`);
  for (const [t, promptPath] of todo) {
    try {
      const raw = fs.readFileSync(promptPath, 'utf8');
      const d = await determineProviderSmart({ messages: [{ role: 'user', content: raw }], tools: [] }, {});
      let sf = d.shortfall || null;
      if (!sf || !sf.req) {
        // The router only computes shortfall in weighted mode below risk-high;
        // rebuild the same lifted vector here so every task gets scored.
        const structural = buildRequirementVector({ dimensions: d.analysis?.breakdown || {}, agenticResult: d.agenticResult || null });
        const lifted = sfmod.liftRequirement(structural, { anchorScore: d.analysis?.anchorScore, jev: d.analysis?.jev });
        sf = { req: lifted.req, structuralReq: structural, lift: lifted.lift.applied, rebuilt: true };
      }
      cache[t] = {
        req: sf.req || null, structuralReq: sf.structuralReq || null, lift: sf.lift || [], rebuilt: !!sf.rebuilt,
        liveTier: d.tier || null, anchorScore: d.analysis?.anchorScore ?? null,
        jev: d.analysis?.jev ? { tier: d.analysis.jev.tier, confidence: d.analysis.jev.confidence, probabilities: d.analysis.jev.probabilities } : null,
      };
    } catch (err) { cache[t] = { req: null, error: String(err && err.message || err) }; }
    fs.writeFileSync(cachePath, JSON.stringify(cache, null, 2));
  }
  return cache;
}

// ---------------------------------------------------------------------------
// phase 3: fit
// ---------------------------------------------------------------------------
function passRateAt(level, rows, head, win = 0.1) {
  const sel = rows.filter((r) => Math.abs(r.req[head] - level) <= win);
  if (sel.length < 5) return null;
  return { n: sel.length, rate: sel.filter((r) => r.pass).length / sel.length };
}

function fitModel(rows, bestRows, floor, rel) {
  // rows: [{task, req, pass}] for this model; bestRows: same shape, strongest model.
  const levels = []; for (let l = 0.1; l <= 0.951; l += 0.05) levels.push(Math.round(l * 100) / 100);
  const caps = {}, detail = {};
  for (const h of HEADS) {
    let cap = null, collapse = null; const curve = [];
    for (const l of levels) {
      const p = passRateAt(l, rows, h); if (!p) continue;
      const b = bestRows ? passRateAt(l, bestRows, h) : null;
      const okAbs = p.rate >= floor;
      const okRel = !b || b.rate === 0 || p.rate >= rel * b.rate;
      curve.push({ level: l, n: p.n, rate: Math.round(p.rate * 100) / 100, best: b ? Math.round(b.rate * 100) / 100 : null, ok: okAbs && okRel });
      if (okAbs && okRel) cap = l;
      if (cap !== null && l > cap && p.rate < floor / 2 && collapse === null) collapse = l;
    }
    if (cap === null) {
      // never met the floor in any window: use the overall pass rate as a
      // pessimistic scalar (a model that passes 30% overall gets ~0.3)
      const overall = rows.length ? rows.filter((r) => r.pass).length / rows.length : 0;
      cap = Math.max(0.1, Math.round(overall * 100) / 100);
    }
    caps[h] = cap; detail[h] = { curve, collapse };
  }
  return { caps, detail };
}

function fitTau(fits) {
  const gaps = [];
  for (const f of Object.values(fits)) for (const h of HEADS) {
    const c = f.detail[h].collapse; if (c !== null && c !== undefined) gaps.push(c - f.caps[h]);
  }
  if (gaps.length === 0) return { tau: 0.15, source: 'default (no collapse points observed)' };
  gaps.sort((a, b) => a - b);
  const med = gaps[Math.floor(gaps.length / 2)];
  return { tau: Math.max(0.05, Math.min(0.3, Math.round(med * 100) / 100)), source: `median collapse gap over ${gaps.length} head curves` };
}

function simulateShortfall(req, candidates, overrides, tau) {
  const sf = require(path.join(ROOT, 'src', 'routing', 'shortfall'));
  sf._setProfilesForTests({ modelOverrides: overrides, tau });
  const r = sf.selectByShortfall(req, candidates, { tau });
  sf._resetProfilesCache();
  return r ? r.selected : null;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
(async () => {
  const opts = parseArgs(process.argv.slice(2));
  fs.mkdirSync(opts.out, { recursive: true });

  // Resolve run dirs / plan
  const plan = [];
  for (const m of opts.models) {
    const existing = m.runDir ? findRunRoot(m.runDir) : findRunRoot(path.join(opts.out, 'runs', m.short, 'tb'));
    if (m.runDir && !existing) die(`${m.spec}: no results.json under ${m.runDir}`);
    m.runRoot = existing;
    plan.push(`${m.key.padEnd(44)} ${existing ? 'reuse ' + existing : (opts.run ? 'RUN  (~1h, est. $1–5)' : 'needs run — pass --run')}`);
  }
  console.log('\nPlan:\n  ' + plan.join('\n  ') + `\n  out: ${opts.out}  floor ${opts.floor}  rel ${opts.rel}\n`);
  if (opts.dryRun) { log('dry run — nothing executed'); return; }

  // Phase 1
  for (const m of opts.models) {
    if (m.runRoot) continue;
    if (!opts.run) die(`${m.key} has no run; re-run with --run to benchmark it (spends money) or pass model=run-dir`);
    m.runRoot = await runModel(m, opts);
  }

  // Load runs
  for (const m of opts.models) {
    m.tasks = loadRun(m.runRoot, m.short);
    const n = Object.keys(m.tasks).length;
    const solo = Object.values(m.tasks).filter((t) => t.servedShare >= 0.8);
    log(`${m.key}: ${n} tasks in run, ${solo.length} served ≥80% by this model, ${solo.filter((t) => t.resolved).length} passed`);
  }

  // Phase 2
  const prompts = {};
  for (const m of opts.models) for (const [t, e] of Object.entries(m.tasks)) if (e.promptPath && !prompts[t]) prompts[t] = e.promptPath;
  const reqs = await replayRequirements(prompts, path.join(opts.out, 'requirements.json'));
  const scored = Object.entries(reqs).filter(([, r]) => r.req).map(([t, r]) => t);
  log(`${scored.length} tasks have requirement vectors`);

  // Phase 3
  const rowsFor = (m) => scored.filter((t) => m.tasks[t] && m.tasks[t].servedShare >= 0.8)
    .map((t) => ({ task: t, req: reqs[t].req, pass: m.tasks[t].resolved }));
  const rowsets = {}; for (const m of opts.models) rowsets[m.key] = rowsFor(m);
  const best = opts.models.slice().sort((a, b) => (rowsets[b.key].filter((r) => r.pass).length / Math.max(1, rowsets[b.key].length))
    - (rowsets[a.key].filter((r) => r.pass).length / Math.max(1, rowsets[a.key].length)))[0];
  const fits = {};
  for (const m of opts.models) fits[m.key] = fitModel(rowsets[m.key], m.key === best.key ? null : rowsets[best.key], opts.floor, opts.rel);
  const { tau, source: tauSource } = fitTau(fits);
  const overrides = {}; for (const m of opts.models) overrides[m.key] = fits[m.key].caps;

  // Hold-out simulation: tasks every model was measured on, every Nth held out.
  const common = scored.filter((t) => opts.models.every((m) => m.tasks[t] && m.tasks[t].servedShare >= 0.8));
  const held = common.filter((_, i) => i % opts.holdoutEvery === 0);
  const candidates = opts.models.map((m) => ({ provider: m.provider, model: m.model, tier: m.key === best.key ? 'COMPLEX' : 'MEDIUM', cost: 1 }));
  let simPass = 0, simCost = 0, bestPass = 0, bestCost = 0, picks = {};
  for (const t of held) {
    const sel = simulateShortfall(reqs[t].req, candidates, overrides, tau);
    const chosen = sel ? opts.models.find((m) => m.model === sel.model) : best;
    picks[chosen.key] = (picks[chosen.key] || 0) + 1;
    simPass += chosen.tasks[t].resolved ? 1 : 0; simCost += taskCost(chosen.tasks[t], opts.prices[chosen.short]) ?? 0;
    bestPass += best.tasks[t].resolved ? 1 : 0; bestCost += taskCost(best.tasks[t], opts.prices[best.short]) ?? 0;
  }

  // Phase 4
  const proposed = { modelOverrides: overrides, tau, generated: new Date().toISOString(), floor: opts.floor, rel: opts.rel, tauSource };
  fs.writeFileSync(path.join(opts.out, 'model-capabilities.proposed.json'), JSON.stringify(proposed, null, 2));
  const lines = [];
  lines.push(`# Capability calibration — ${new Date().toISOString()}`, '');
  lines.push(`Tasks with requirement vectors: ${scored.length}. Best model: ${best.key}.`, '');
  lines.push('## Measured pass rates (tasks served ≥80% by the model)', '');
  for (const m of opts.models) { const rs = rowsets[m.key]; lines.push(`- ${m.key}: ${rs.filter((r) => r.pass).length}/${rs.length} passed (run ${m.runRoot})`); }
  lines.push('', `## Fitted profiles (floor ${opts.floor}, rel ${opts.rel})`, '');
  lines.push('| model | ' + HEADS.join(' | ') + ' |', '|---|' + HEADS.map(() => '---').join('|') + '|');
  for (const m of opts.models) lines.push(`| ${m.key} | ` + HEADS.map((h) => fits[m.key].caps[h].toFixed(2)).join(' | ') + ' |');
  lines.push('', `tau = ${tau} (${tauSource})`, '');
  lines.push('## Pass-rate curves', '');
  for (const m of opts.models) for (const h of HEADS) {
    const c = fits[m.key].detail[h].curve; if (!c.length) continue;
    lines.push(`- ${m.short} / ${h}: ` + c.map((p) => `${p.level}:${Math.round(p.rate * 100)}%${p.best !== null ? '/' + Math.round(p.best * 100) + '%' : ''}(n${p.n})${p.ok ? '' : '✗'}`).join(' '));
  }
  lines.push('', `## Hold-out check (${held.length} tasks, every ${opts.holdoutEvery}th of ${common.length} common)`, '');
  if (held.length === 0) lines.push('Not enough tasks measured on every model — run the missing models solo.');
  else {
    lines.push(`- shortfall (fitted): ${simPass}/${held.length} passed, $${simCost.toFixed(2)}; picks ${JSON.stringify(picks)}`);
    lines.push(`- ${best.short} everywhere: ${bestPass}/${held.length} passed, $${bestCost.toFixed(2)}`);
    lines.push(`- verdict: ${simPass >= bestPass && simCost < bestCost ? 'shortfall WINS (same or better accuracy, cheaper)' : simPass >= bestPass ? 'same accuracy, not cheaper' : `shortfall loses ${bestPass - simPass} task(s) for $${(bestCost - simCost).toFixed(2)} saved`}`);
  }
  fs.writeFileSync(path.join(opts.out, 'report.md'), lines.join('\n') + '\n');
  console.log('\n' + lines.join('\n'));
  log(`wrote ${path.join(opts.out, 'report.md')} and model-capabilities.proposed.json`);

  if (opts.apply) {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    fs.copyFileSync(CONFIG_PATH, CONFIG_PATH + `.bak-${Date.now()}`);
    cfg.modelOverrides = { ...(cfg.modelOverrides || {}), ...overrides };
    cfg.tau = tau;
    cfg.notes = (cfg.notes || '') + ` | calibrate-capabilities ${new Date().toISOString().slice(0, 10)}: modelOverrides/tau fitted from measured runs (see ${path.join(opts.out, 'report.md')}).`;
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n');
    log(`applied to ${CONFIG_PATH} (backup written). Restart Lynkr; shortfall "enabled" is left as-is.`);
  } else {
    log('not applied (pass --apply to merge into config/model-capabilities.json)');
  }
})().catch((err) => { console.error(err); process.exit(1); });
