#!/usr/bin/env node
/**
 * Calibrate tier thresholds from telemetry.
 *
 * Phase 1.4 of the routing overhaul. Reads quality_score history from the
 * routing_telemetry table, finds where each tier's median quality drops below
 * acceptable, and writes adjusted [lo, hi] ranges to
 * data/calibrated-thresholds.json. ModelTierSelector picks the file up on
 * next start.
 *
 * Usage: node scripts/calibrate-thresholds.js [--days N] [--dry-run]
 *        npx lynkr calibrate
 *
 * Behavior when telemetry is sparse (<100 rows with quality_score):
 *   - No file is written and existing calibration is left alone.
 *   - Exits 0 with a "skipped" message.
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_DAYS = 7;
const MIN_SAMPLES = 100;
/** Quality score below which a complexity bucket is "underperforming" for its tier. */
const QUALITY_FLOOR = {
  SIMPLE: 55,
  MEDIUM: 60,
  COMPLEX: 65,
  REASONING: 70,
};

const OUTPUT_PATH = path.join(__dirname, '../data/calibrated-thresholds.json');
const TELEMETRY_DB_CANDIDATES = [
  path.join(__dirname, '../.lynkr/telemetry.db'),
  path.join(__dirname, '../data/lynkr.db'),
];

function _findDb() {
  for (const p of TELEMETRY_DB_CANDIDATES) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function _parseArgs(argv) {
  const out = { days: DEFAULT_DAYS, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--days') out.days = Number(argv[++i]) || DEFAULT_DAYS;
    else if (a === '--dry-run') out.dryRun = true;
  }
  return out;
}

const DEFAULT_RANGES = {
  SIMPLE: [0, 25],
  MEDIUM: [26, 50],
  COMPLEX: [51, 75],
  REASONING: [76, 100],
};

function _openDb(dbPath) {
  let Database;
  try {
    Database = require('better-sqlite3');
  } catch (err) {
    console.error('better-sqlite3 not installed. Install with: npm install --save-optional better-sqlite3');
    process.exit(2);
  }
  return new Database(dbPath, { readonly: true, fileMustExist: true });
}

function calibrate({ days = DEFAULT_DAYS, dryRun = false } = {}) {
  const dbPath = _findDb();
  if (!dbPath) {
    console.log('No telemetry DB found — skipping calibration.');
    return { skipped: true, reason: 'no_db' };
  }

  let db;
  try {
    db = _openDb(dbPath);
  } catch (err) {
    console.error(`Failed to open telemetry DB: ${err.message}`);
    return { skipped: true, reason: 'db_open_failed', error: err.message };
  }

  const since = Date.now() - days * 24 * 3600 * 1000;
  let rows;
  try {
    rows = db
      .prepare(
        `SELECT tier, complexity_score AS score, quality_score AS q
           FROM routing_telemetry
          WHERE timestamp >= ?
            AND quality_score IS NOT NULL
            AND complexity_score IS NOT NULL
            AND tier IS NOT NULL`
      )
      .all(since);
  } catch (err) {
    console.error(`Telemetry query failed (DB may be corrupt or schema missing): ${err.message}`);
    return { skipped: true, reason: 'query_failed', error: err.message };
  } finally {
    try { db.close(); } catch {}
  }

  if (!rows || rows.length < MIN_SAMPLES) {
    console.log(`Only ${rows ? rows.length : 0} rows with quality_score in last ${days}d (need ≥${MIN_SAMPLES}). Skipping.`);
    return { skipped: true, reason: 'insufficient_samples', count: rows ? rows.length : 0 };
  }

  // Bucket by score (0-100 in width-5 buckets) per tier, compute median quality.
  const buckets = new Map(); // tier -> Map<bucketLowerBound, q-values[]>
  for (const row of rows) {
    const s = Math.max(0, Math.min(100, Math.floor(row.score)));
    const bucket = Math.floor(s / 5) * 5;
    if (!buckets.has(row.tier)) buckets.set(row.tier, new Map());
    const b = buckets.get(row.tier);
    if (!b.has(bucket)) b.set(bucket, []);
    b.get(bucket).push(row.q);
  }

  const _median = (arr) => {
    const s = arr.slice().sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };

  // Default ranges; will adjust per-tier upper bound if late buckets show poor quality.
  const ranges = { ...DEFAULT_RANGES };
  const tierOrder = ['SIMPLE', 'MEDIUM', 'COMPLEX', 'REASONING'];
  const stats = {};

  for (const tier of tierOrder) {
    const floor = QUALITY_FLOOR[tier];
    const tierBuckets = buckets.get(tier);
    if (!tierBuckets) {
      stats[tier] = { samples: 0, adjusted: false };
      continue;
    }
    const ordered = Array.from(tierBuckets.entries()).sort((a, b) => a[0] - b[0]);
    let suggestedUpper = DEFAULT_RANGES[tier][1];
    const buckets_summary = [];
    for (const [lo, vals] of ordered) {
      if (vals.length < 5) {
        buckets_summary.push({ bucket: lo, samples: vals.length, median: null });
        continue;
      }
      const med = _median(vals);
      buckets_summary.push({ bucket: lo, samples: vals.length, median: med });
      if (med < floor && lo + 4 < suggestedUpper) {
        suggestedUpper = lo + 4; // shrink tier upper bound just below the failing bucket
      }
    }
    if (suggestedUpper !== DEFAULT_RANGES[tier][1]) {
      ranges[tier] = [DEFAULT_RANGES[tier][0], suggestedUpper];
      stats[tier] = { samples: ordered.reduce((s, [, v]) => s + v.length, 0), adjusted: true, buckets: buckets_summary };
    } else {
      stats[tier] = { samples: ordered.reduce((s, [, v]) => s + v.length, 0), adjusted: false, buckets: buckets_summary };
    }
  }

  // Re-stitch ranges so they don't overlap or leave gaps.
  for (let i = 1; i < tierOrder.length; i++) {
    const prev = ranges[tierOrder[i - 1]];
    const cur = ranges[tierOrder[i]];
    if (cur[0] !== prev[1] + 1) cur[0] = prev[1] + 1;
    if (cur[0] > cur[1]) cur[1] = cur[0]; // collapsed; tier disabled in practice
  }

  const out = {
    calibratedAt: new Date().toISOString(),
    days,
    sampleCount: rows.length,
    ranges,
    stats,
  };

  if (dryRun) {
    console.log(JSON.stringify(out, null, 2));
    return { ...out, dryRun: true };
  }

  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(out, null, 2));
  console.log(`Wrote ${OUTPUT_PATH}`);
  console.log(`Ranges: ${tierOrder.map((t) => `${t}=${ranges[t].join('-')}`).join(', ')}`);
  return out;
}

if (require.main === module) {
  const opts = _parseArgs(process.argv.slice(2));
  calibrate(opts);
}

module.exports = { calibrate };
