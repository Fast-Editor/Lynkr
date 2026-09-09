#!/usr/bin/env node
/**
 * Seed per-family capability profiles from online benchmark data.
 *
 * Reads (all optional, all fail-soft): SWE-Bench Verified leaderboard,
 * data/capability-benchmarks/*.json drop-ins, models.dev boolean flags.
 * Maps scores to families, normalizes to 0-1 caps, and writes
 * data/capability-seeds.snapshot.json for the shortfall resolver.
 * Shipped seeds (config/model-capability-seeds.json) are only ever changed
 * by human review of the printed diff — this script never touches them.
 *
 * Request-path routing never calls this (zero latency impact) and never
 * needs it: unknown families fall back to heuristic → tier caps.
 *
 * Usage:
 *   node scripts/seed-capabilities.js [--refresh] [--model provider:model]
 *     [--dry-run] [--check] [--stale-days 90]
 *
 *   --refresh   fetch remote sources (default: cache-only)
 *   --model     limit to one family (e.g. --model z.ai:glm-5.2)
 *   --dry-run   print diff, write nothing
 *   --check     exit 2 if shipped seeds are older than --stale-days (CI)
 */

const fs = require('fs');
const path = require('path');

const { fetchSweBench } = require('../src/routing/capability-seeds/swebench');
const { fetchModelsDevFlags, NO_TOOLCALL_TOOL_USE_CAP } = require('../src/routing/capability-seeds/models-dev');
const { loadBenchmarksDir } = require('../src/routing/capability-seeds/benchmarks-dir');
const { mapEntryToFamily, scoresToCaps, normalizeFamily } = require('../src/routing/capability-seeds/normalize');
const { SHIPPED_PATH, SNAPSHOT_PATH } = require('../src/routing/capability-seeds/registry');

const STALE_DAYS_DEFAULT = 90;

function _parseArgs(argv) {
  const out = { refresh: false, model: null, dryRun: false, check: false, staleDays: STALE_DAYS_DEFAULT };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--refresh') out.refresh = true;
    else if (argv[i] === '--dry-run') out.dryRun = true;
    else if (argv[i] === '--check') out.check = true;
    else if (argv[i] === '--model') out.model = String(argv[++i] || '');
    else if (argv[i] === '--stale-days') out.staleDays = Number(argv[++i]) || STALE_DAYS_DEFAULT;
  }
  return out;
}

function _readJson(p) {
  try {
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

// Drop-in source name → normalized score slot.
function _slotFor(source) {
  const s = String(source || '').toLowerCase();
  if (s.includes('terminal')) return 'terminal';
  if (s.includes('livecode') || s.includes('bigcode')) return 'livecode';
  if (s.includes('arena')) return 'arena';
  if (s.includes('swe')) return 'swe';
  return null;
}

async function main() {
  const args = _parseArgs(process.argv.slice(2));

  if (args.check) {
    const shipped = _readJson(SHIPPED_PATH);
    const updatedAt = shipped?.updatedAt ? new Date(shipped.updatedAt).getTime() : NaN;
    const ageDays = Number.isFinite(updatedAt) ? (Date.now() - updatedAt) / 86400000 : Infinity;
    if (!(ageDays <= args.staleDays)) {
      console.error(`STALE: shipped seeds updatedAt=${shipped?.updatedAt ?? 'missing'} (> ${args.staleDays}d). Run --refresh and review the diff.`);
      process.exit(2);
    }
    console.log(`OK: shipped seeds fresh (${shipped.updatedAt}, ${ageDays.toFixed(0)}d old).`);
    return;
  }

  const shipped = _readJson(SHIPPED_PATH);
  const shippedSeeds = shipped?.seeds && typeof shipped.seeds === 'object' ? shipped.seeds : {};
  const knownFamilies = Object.keys(shippedSeeds).filter((k) => !k.endsWith('*'));
  const wildcardFamilies = Object.keys(shippedSeeds).filter((k) => k.endsWith('*'));

  let onlyFamily = null;
  if (args.model) {
    const [provider, ...rest] = args.model.split(':');
    const { family } = normalizeFamily(provider, rest.join(':') || provider);
    onlyFamily = family;
    console.log(`Limiting to family: ${onlyFamily}`);
  }

  // 1. Gather score entries per source.
  const scored = {}; // family -> { swe, terminal, livecode, arena }
  const unmapped = [];
  const scaffolded = [];
  const candidates = [];
  const statuses = [];
  const addScore = (family, slot, fraction, source) => {
    if (onlyFamily && family !== onlyFamily) return;
    scored[family] = scored[family] || {};
    // Keep the max when several entries map to one family.
    if (scored[family][slot] === undefined || fraction > scored[family][slot]) {
      scored[family][slot] = fraction;
      scored[family][`${slot}:source`] = source;
    }
  };
  // Bare-model scores only: a "+" joins scaffold + model ("live-swe-agent +
  // claude 4.5 opus") and measures the harness, not the weights. Those go to
  // a separate review list and never seed caps.
  const triage = (name, score, slot, source) => {
    if (String(name).includes('+')) {
      scaffolded.push({ source, name, score });
      return;
    }
    const m = mapEntryToFamily(name, knownFamilies);
    if (m.family) {
      addScore(m.family, slot, score, source);
      return;
    }
    const w = mapEntryToFamily(name, wildcardFamilies);
    if (w.family) {
      candidates.push({ entry: name, score, slot, prefix: w.family.replace(/\*$/, '') });
      return;
    }
    unmapped.push({ source, name, score });
  };

  const swe = await fetchSweBench({ refresh: args.refresh });
  statuses.push(`swebench[${swe.board || '?'}]: ${swe.status}${swe.cached ? ' (cache)' : ''}${swe.reason ? ` — ${swe.reason}` : ''}`);
  for (const e of swe.entries || []) {
    triage(e.name, e.resolved / 100, 'swe', `swebench-verified@${e.resolved}%`);
  }

  const dir = loadBenchmarksDir();
  for (const f of dir.files || []) {
    const slot = _slotFor(f.source);
    statuses.push(`${f.source}: ${f.status}${f.reason ? ` — ${f.reason}` : ''}${f.status === 'ok' && !slot ? ' (unknown slot — skipped)' : ''}`);
    if (f.status !== 'ok' || !slot) continue;
    for (const e of f.entries || []) {
      const fraction = f.scale === 'fraction' ? e.score : e.score / 100;
      triage(e.name, fraction, slot, `${f.source}@${e.score}`);
    }
  }

  const md = await fetchModelsDevFlags({ refresh: args.refresh });
  statuses.push(`models.dev: ${md.status}${md.cached ? ' (cache)' : ''}${md.reason ? ` — ${md.reason}` : ''}`);

  // 2. Normalize to caps.
  const proposed = {};
  for (const [family, slots] of Object.entries(scored)) {
    const scores = {};
    for (const k of ['swe', 'terminal', 'livecode', 'arena']) {
      if (Number.isFinite(slots[k])) scores[k] = slots[k];
    }
    const caps = scoresToCaps(scores);
    if (!caps) continue;
    const sources = Object.keys(scores).map((k) => slots[`${k}:source`]).filter(Boolean);
    const flag = md.flags?.[family];
    if (flag && flag.toolCall === false && caps.tool_use > NO_TOOLCALL_TOOL_USE_CAP) {
      caps.tool_use = NO_TOOLCALL_TOOL_USE_CAP;
      sources.push('models.dev:no-tool_call-cap');
    }
    proposed[family] = { caps, sources, fetchedAt: new Date().toISOString().slice(0, 10) };
  }

  // 3. Diff vs snapshot + shipped.
  const snapshot = _readJson(SNAPSHOT_PATH);
  const prevSeeds = snapshot?.seeds && typeof snapshot.seeds === 'object' ? snapshot.seeds : {};
  const moves = [];
  for (const [family, entry] of Object.entries(proposed)) {
    const prev = prevSeeds[family];
    const shippedCaps = shippedSeeds[family]?.caps;
    const sameAs = (a, b) => a && b && ['reasoning', 'codegen', 'debugging', 'tool_use'].every((h) => a[h] === b[h]);
    if (!prev && !shippedCaps) moves.push({ family, type: 'added', caps: entry.caps });
    else if (!sameAs(prev?.caps, entry.caps)) moves.push({ family, type: 'changed', from: prev?.caps ?? null, to: entry.caps });
  }

  console.log('Sources:');
  for (const s of statuses) console.log(`  - ${s}`);
  console.log(`Families scored: ${Object.keys(proposed).length}, changed vs snapshot: ${moves.length}`);
  for (const m of moves.slice(0, 30)) {
    console.log(`  ${m.type} ${m.family}: ${JSON.stringify(m.from ?? null)} → ${JSON.stringify(m.to ?? m.caps)}`);
  }
  if (moves.length > 30) console.log(`  … and ${moves.length - 30} more`);
  const topUnmapped = unmapped.sort((a, b) => b.score - a.score).slice(0, 10);
  if (topUnmapped.length > 0) {
    console.log('Unmapped (no family match — review, add alias/seed if real):');
    for (const u of topUnmapped) console.log(`  - [${u.source}] ${u.name} (${u.score})`);
  }
  const topCandidates = candidates.sort((a, b) => b.score - a.score).slice(0, 15);
  if (topCandidates.length > 0) {
    console.log('Candidate new seeds (matched a shipped wildcard — add an exact entry to graduate):');
    for (const c of topCandidates) {
      console.log(`  - "${c.entry}" (${c.slot} ${c.score}) → under prefix "${c.prefix}"`);
    }
  }
  const topScaffolded = scaffolded.sort((a, b) => b.score - a.score).slice(0, 5);
  if (topScaffolded.length > 0) {
    console.log('Scaffolded entries (harness+model composites — never seeded, shown for context):');
    for (const u of topScaffolded) console.log(`  - [${u.source}] ${u.name} (${u.score})`);
  }

  if (args.dryRun) {
    console.log('dry-run: wrote nothing.');
    return;
  }
  const next = {
    version: 1,
    fetchedAt: new Date().toISOString(),
    seeds: { ...prevSeeds },
  };
  for (const [family, entry] of Object.entries(proposed)) next.seeds[family] = entry;
  try {
    fs.mkdirSync(path.dirname(SNAPSHOT_PATH), { recursive: true });
    fs.writeFileSync(SNAPSHOT_PATH, `${JSON.stringify(next, null, 2)}\n`);
    console.log(`Wrote ${SNAPSHOT_PATH} (${Object.keys(next.seeds).length} families).`);
    console.log('Review the diff above; to promote entries to shipped seeds, copy them into config/model-capability-seeds.json and bump updatedAt.');
  } catch (err) {
    console.error(`Write failed: ${err.message}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`seed-capabilities failed: ${err?.message || err}`);
  process.exit(1);
});
