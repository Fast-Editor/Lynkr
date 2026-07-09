#!/usr/bin/env node
/**
 * Calibrate tier thresholds from telemetry.
 *
 * CLI wrapper around `src/routing/calibration.js`. WS5.6 moved the core
 * logic into a module so the same code path drives both this manual
 * script and the in-process auto-calibration scheduler.
 *
 * Usage: node scripts/calibrate-thresholds.js [--days N] [--dry-run]
 *        npx lynkr calibrate
 *
 * Behavior when telemetry is sparse (<100 rows with quality_score):
 *   - No file is written and existing calibration is left alone.
 *   - Exits 0 with a "skipped" message.
 */

const { runCalibration } = require('../src/routing/calibration');

const DEFAULT_DAYS = 7;

function _parseArgs(argv) {
  const out = { days: DEFAULT_DAYS, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--days') out.days = Number(argv[++i]) || DEFAULT_DAYS;
    else if (a === '--dry-run') out.dryRun = true;
  }
  return out;
}

function _reportSkipped(result) {
  switch (result.reason) {
    case 'no_db':
      console.log('No telemetry DB found — skipping calibration.');
      break;
    case 'db_open_failed':
      console.error(`Failed to open telemetry DB: ${result.error}`);
      process.exit(2);
      break;
    case 'query_failed':
      console.error(`Telemetry query failed (DB may be corrupt or schema missing): ${result.error}`);
      break;
    case 'insufficient_samples':
      console.log(
        `Only ${result.count} rows with quality_score (need ≥${result.minSamples}). Skipping.`
      );
      break;
    case 'write_failed':
      console.error(`Failed to write calibrated thresholds: ${result.error}`);
      process.exit(2);
      break;
    default:
      console.log(`Skipped: ${result.reason}`);
  }
}

function calibrate(opts) {
  const result = runCalibration(opts);
  if (result.skipped) {
    _reportSkipped(result);
    return result;
  }
  if (result.dryRun) {
    console.log(JSON.stringify(result, null, 2));
    return result;
  }
  const tierOrder = ['SIMPLE', 'MEDIUM', 'COMPLEX', 'REASONING'];
  console.log(`Wrote ${result.writtenTo}`);
  console.log(`Ranges: ${tierOrder.map((t) => `${t}=${result.ranges[t].join('-')}`).join(', ')}`);
  return result;
}

if (require.main === module) {
  const opts = _parseArgs(process.argv.slice(2));
  calibrate(opts);
}

module.exports = { calibrate };
