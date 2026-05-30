#!/usr/bin/env node
/**
 * Learn per-task-type output-token ratios from telemetry.
 *
 * Phase 2.3 of the routing overhaul. The cost-optimizer's default assumption
 * of `output = 0.5 × input` is wrong for code generation (typically 1.5-3×)
 * and summarization (typically 0.1-0.2×). This script builds an empirical
 * ratio table from past completions, written to data/output-ratios.json.
 *
 * The cost-optimizer reads this file when estimating cost during routing.
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_DAYS = 30;
const MIN_SAMPLES_PER_TASK = 30;
const OUTPUT_PATH = path.join(__dirname, '../data/output-ratios.json');
const TELEMETRY_DB_CANDIDATES = [
  path.join(__dirname, '../.lynkr/telemetry.db'),
  path.join(__dirname, '../data/lynkr.db'),
];

// Fallback ratios when no telemetry exists.
// Derived from public benchmark data (RouterBench task distribution).
const FALLBACK_RATIOS = {
  simple_qa: 0.30,
  code_gen: 2.10,
  code_edit: 1.40,
  summarization: 0.15,
  reasoning: 1.50,
  tool_use: 0.80,
  default: 0.50,
};

function _findDb() {
  for (const p of TELEMETRY_DB_CANDIDATES) if (fs.existsSync(p)) return p;
  return null;
}

function _openDb(dbPath) {
  let Database;
  try {
    Database = require('better-sqlite3');
  } catch {
    console.error('better-sqlite3 not installed. Install with: npm install --save-optional better-sqlite3');
    process.exit(2);
  }
  return new Database(dbPath, { readonly: true, fileMustExist: true });
}

function _median(arr) {
  const s = arr.slice().sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function _parseArgs(argv) {
  const out = { days: DEFAULT_DAYS, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--days') out.days = Number(argv[++i]) || DEFAULT_DAYS;
    else if (argv[i] === '--dry-run') out.dryRun = true;
  }
  return out;
}

function learn({ days = DEFAULT_DAYS, dryRun = false } = {}) {
  const dbPath = _findDb();
  if (!dbPath) {
    console.log('No telemetry DB — writing fallback ratios.');
    if (!dryRun) {
      fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
      fs.writeFileSync(OUTPUT_PATH, JSON.stringify({
        learnedAt: new Date().toISOString(),
        source: 'fallback',
        ratios: FALLBACK_RATIOS,
      }, null, 2));
    }
    return { source: 'fallback', ratios: FALLBACK_RATIOS };
  }

  let db;
  try {
    db = _openDb(dbPath);
  } catch (err) {
    console.error(`Failed to open telemetry DB: ${err.message}. Writing fallback ratios.`);
    if (!dryRun) {
      fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
      fs.writeFileSync(OUTPUT_PATH, JSON.stringify({
        learnedAt: new Date().toISOString(),
        source: 'fallback',
        ratios: FALLBACK_RATIOS,
      }, null, 2));
    }
    return { source: 'fallback', ratios: FALLBACK_RATIOS };
  }

  const since = Date.now() - days * 24 * 3600 * 1000;
  let rows;
  try {
    rows = db
      .prepare(
        `SELECT task_type, input_tokens AS i, output_tokens AS o
           FROM routing_telemetry
          WHERE timestamp >= ?
            AND input_tokens > 0
            AND output_tokens > 0
            AND task_type IS NOT NULL`
      )
      .all(since);
  } catch (err) {
    console.error(`Query failed: ${err.message}. Writing fallback.`);
    rows = [];
  } finally {
    try { db.close(); } catch {}
  }

  // Bucket by task type
  const buckets = new Map();
  for (const row of rows) {
    const key = String(row.task_type || 'default').toLowerCase();
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(row.o / row.i);
  }

  const ratios = { ...FALLBACK_RATIOS };
  const stats = {};
  for (const [task, vals] of buckets) {
    if (vals.length >= MIN_SAMPLES_PER_TASK) {
      ratios[task] = +_median(vals).toFixed(3);
      stats[task] = { samples: vals.length, median: ratios[task] };
    } else {
      stats[task] = { samples: vals.length, median: null, used_fallback: true };
    }
  }

  const out = {
    learnedAt: new Date().toISOString(),
    days,
    source: rows.length > 0 ? 'telemetry' : 'fallback',
    sampleCount: rows.length,
    ratios,
    stats,
  };

  if (dryRun) {
    console.log(JSON.stringify(out, null, 2));
    return out;
  }

  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(out, null, 2));
  console.log(`Wrote ${OUTPUT_PATH} (source=${out.source}, samples=${out.sampleCount})`);
  return out;
}

if (require.main === module) {
  const opts = _parseArgs(process.argv.slice(2));
  learn(opts);
}

module.exports = { learn, FALLBACK_RATIOS };
