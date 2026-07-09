/**
 * WS5.6 — auto-calibration.
 *
 * The core logic of `scripts/calibrate-thresholds.js` extracted so it can
 * run inside the server process on a schedule, not just from the CLI.
 *
 * Read quality_score history from the routing_telemetry table, bucket by
 * (tier, complexity_score) with width-5 buckets, and shrink each tier's
 * upper bound to just below the first bucket whose median quality falls
 * under a per-tier floor. Ranges are then re-stitched to leave no gaps
 * before writing to `data/calibrated-thresholds.json`.
 *
 * The CLI script (`scripts/calibrate-thresholds.js`) is now a thin wrapper
 * around `runCalibration()` — same defaults, same output format.
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

const DEFAULT_RANGES = {
  SIMPLE: [0, 25],
  MEDIUM: [26, 50],
  COMPLEX: [51, 75],
  REASONING: [76, 100],
};

const OUTPUT_PATH = path.join(__dirname, '../../data/calibrated-thresholds.json');
const TELEMETRY_DB_CANDIDATES = [
  path.join(__dirname, '../../.lynkr/telemetry.db'),
  path.join(__dirname, '../../data/lynkr.db'),
];

function _findDb(dbPath) {
  if (dbPath) return fs.existsSync(dbPath) ? dbPath : null;
  for (const p of TELEMETRY_DB_CANDIDATES) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function _openDb(dbPath) {
  let Database;
  try {
    Database = require('better-sqlite3');
  } catch (err) {
    throw new Error(
      'better-sqlite3 not installed. Install with: npm install --save-optional better-sqlite3'
    );
  }
  return new Database(dbPath, { readonly: true, fileMustExist: true });
}

function _median(arr) {
  const s = arr.slice().sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Run calibration against a telemetry DB and (unless dryRun) write the
 * result to `data/calibrated-thresholds.json`.
 *
 * @param {object} [opts]
 * @param {number} [opts.days=7]
 * @param {boolean} [opts.dryRun=false]
 * @param {string} [opts.dbPath] — explicit DB path (else auto-discover).
 * @param {string} [opts.outputPath] — override output path (tests set this).
 * @returns {object} — either `{skipped:true, reason}` or a full result
 *   `{calibratedAt, days, sampleCount, ranges, stats}` (with `dryRun:true`
 *   when appropriate).
 */
function runCalibration({ days = DEFAULT_DAYS, dryRun = false, dbPath, outputPath = OUTPUT_PATH } = {}) {
  const resolvedDb = _findDb(dbPath);
  if (!resolvedDb) {
    return { skipped: true, reason: 'no_db' };
  }

  let db;
  try {
    db = _openDb(resolvedDb);
  } catch (err) {
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
    return { skipped: true, reason: 'query_failed', error: err.message };
  } finally {
    try { db.close(); } catch { /* ignore */ }
  }

  if (!rows || rows.length < MIN_SAMPLES) {
    return {
      skipped: true,
      reason: 'insufficient_samples',
      count: rows ? rows.length : 0,
      minSamples: MIN_SAMPLES,
    };
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
    const bucketsSummary = [];
    for (const [lo, vals] of ordered) {
      if (vals.length < 5) {
        bucketsSummary.push({ bucket: lo, samples: vals.length, median: null });
        continue;
      }
      const med = _median(vals);
      bucketsSummary.push({ bucket: lo, samples: vals.length, median: med });
      if (med < floor && lo + 4 < suggestedUpper) {
        // shrink tier upper bound just below the failing bucket
        suggestedUpper = lo + 4;
      }
    }
    if (suggestedUpper !== DEFAULT_RANGES[tier][1]) {
      ranges[tier] = [DEFAULT_RANGES[tier][0], suggestedUpper];
      stats[tier] = {
        samples: ordered.reduce((s, [, v]) => s + v.length, 0),
        adjusted: true,
        buckets: bucketsSummary,
      };
    } else {
      stats[tier] = {
        samples: ordered.reduce((s, [, v]) => s + v.length, 0),
        adjusted: false,
        buckets: bucketsSummary,
      };
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

  if (dryRun) return { ...out, dryRun: true };

  try {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, JSON.stringify(out, null, 2));
    return { ...out, writtenTo: outputPath };
  } catch (err) {
    return { skipped: true, reason: 'write_failed', error: err.message };
  }
}

module.exports = {
  runCalibration,
  MIN_SAMPLES,
  DEFAULT_RANGES,
  QUALITY_FLOOR,
  OUTPUT_PATH,
};
