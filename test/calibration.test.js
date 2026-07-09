/**
 * WS5.6 — auto-calibration module.
 *
 * Covers:
 *   - < MIN_SAMPLES rows → skipped, existing file left alone
 *   - Enough rows, all quality within floor → no adjustment
 *   - A tier's late buckets dip below floor → upper bound shrinks
 *   - Output file written on disk with the expected shape
 *   - reloadCalibratedThresholds() picks up on-disk changes
 *   - Missing DB → skipped, doesn't crash
 *   - dryRun=true → does not write to disk
 *
 * Skipped when better-sqlite3 is unavailable (matches the runtime skip
 * behaviour in `src/routing/telemetry.js`).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

function _sqliteAvailable() {
  try { require('better-sqlite3'); return true; } catch { return false; }
}

const {
  runCalibration,
  MIN_SAMPLES,
  DEFAULT_RANGES,
} = require('../src/routing/calibration');

function _mkTempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lynkr-calibrate-'));
  const dbPath = path.join(dir, 'telemetry.db');
  const Database = require('better-sqlite3');
  const db = new Database(dbPath);
  // Match the shape of routing_telemetry that calibration.js queries.
  db.exec(`
    CREATE TABLE routing_telemetry (
      request_id TEXT,
      timestamp INTEGER,
      tier TEXT,
      complexity_score REAL,
      quality_score REAL
    );
  `);
  return { dir, dbPath, db };
}

function _seedRows(db, rows) {
  const stmt = db.prepare(
    'INSERT INTO routing_telemetry (request_id, timestamp, tier, complexity_score, quality_score) VALUES (?, ?, ?, ?, ?)'
  );
  const now = 1_700_000_000_000; // fixed epoch so tests don't rely on Date.now
  const insertMany = db.transaction((all) => {
    for (const r of all) {
      stmt.run(
        r.request_id ?? crypto.randomUUID(),
        r.timestamp ?? now,
        r.tier,
        r.score,
        r.quality,
      );
    }
  });
  insertMany(rows);
}

// Node ≥ 19 exposes global crypto; polyfill for older test envs.
if (typeof crypto === 'undefined') {
  global.crypto = { randomUUID: () => Math.random().toString(36).slice(2) };
}

test('skips when telemetry has fewer than MIN_SAMPLES rows', { skip: !_sqliteAvailable() }, () => {
  const { dir, dbPath, db } = _mkTempDb();
  try {
    _seedRows(db, Array.from({ length: MIN_SAMPLES - 1 }, (_, i) => ({
      tier: 'SIMPLE', score: 10, quality: 80,
      timestamp: Date.now() - 1000 * i,
    })));
    db.close();
    const outputPath = path.join(dir, 'calibrated.json');
    const result = runCalibration({ dbPath, outputPath });
    assert.equal(result.skipped, true);
    assert.equal(result.reason, 'insufficient_samples');
    assert.equal(fs.existsSync(outputPath), false, 'must not write on skip');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('skips gracefully when the DB does not exist', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lynkr-calibrate-nodb-'));
  try {
    const result = runCalibration({ dbPath: path.join(dir, 'nope.db') });
    assert.equal(result.skipped, true);
    assert.equal(result.reason, 'no_db');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('writes calibrated ranges when a tier bucket dips below its quality floor',
  { skip: !_sqliteAvailable() }, () => {
    const { dir, dbPath, db } = _mkTempDb();
    try {
      const rows = [];
      const now = Date.now();
      // SIMPLE tier, 200 rows across score buckets [0,5,10,15,20].
      // Buckets 0-15 → high quality (80). Bucket 20 → 30 (below floor 55).
      // That should shrink SIMPLE's upper bound from 25 down toward 24
      // (i.e. lo + 4 of the failing bucket = 20 + 4 = 24).
      for (let s = 0; s < 20; s += 5) {
        for (let i = 0; i < 40; i++) {
          rows.push({ tier: 'SIMPLE', score: s + 1, quality: 80, timestamp: now - i * 1000 });
        }
      }
      for (let i = 0; i < 40; i++) {
        rows.push({ tier: 'SIMPLE', score: 22, quality: 30, timestamp: now - i * 1000 });
      }
      // Fill MEDIUM/COMPLEX/REASONING with plenty of high-quality rows so
      // they stay at defaults (nothing to adjust).
      for (const tier of ['MEDIUM', 'COMPLEX', 'REASONING']) {
        const base = DEFAULT_RANGES[tier][0];
        for (let i = 0; i < 60; i++) {
          rows.push({ tier, score: base + 1, quality: 95, timestamp: now - i * 1000 });
        }
      }
      _seedRows(db, rows);
      db.close();

      const outputPath = path.join(dir, 'calibrated.json');
      const result = runCalibration({ dbPath, outputPath });
      assert.equal(result.skipped, undefined, `should not skip; result=${JSON.stringify(result)}`);
      assert.equal(fs.existsSync(outputPath), true, 'calibrated file must be written');

      const saved = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
      assert.deepEqual(saved.ranges.SIMPLE, [0, 24], 'SIMPLE upper should shrink to 24');
      // Re-stitching: MEDIUM should start at SIMPLE_hi + 1.
      assert.equal(saved.ranges.MEDIUM[0], 25);
      // Higher tiers with all-good buckets keep their defaults.
      assert.deepEqual(saved.ranges.REASONING, DEFAULT_RANGES.REASONING);
      assert.equal(saved.stats.SIMPLE.adjusted, true);
      assert.equal(saved.stats.REASONING.adjusted, false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

test('dryRun=true produces the result but does not write to disk',
  { skip: !_sqliteAvailable() }, () => {
    const { dir, dbPath, db } = _mkTempDb();
    try {
      const now = Date.now();
      const rows = Array.from({ length: MIN_SAMPLES * 2 }, (_, i) => ({
        tier: 'SIMPLE', score: 10, quality: 90, timestamp: now - i * 1000,
      }));
      _seedRows(db, rows);
      db.close();
      const outputPath = path.join(dir, 'calibrated.json');
      const result = runCalibration({ dbPath, outputPath, dryRun: true });
      assert.equal(result.dryRun, true);
      assert.ok(result.ranges);
      assert.equal(fs.existsSync(outputPath), false, 'dryRun must not write');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

test('reloadCalibratedThresholds() picks up new ranges from disk',
  { skip: !_sqliteAvailable() }, () => {
    // Snapshot & restore the real calibrated-thresholds.json so this test
    // doesn't clobber a dev/live config sitting in the repo.
    const CALIBRATED_PATH = path.join(__dirname, '../data/calibrated-thresholds.json');
    const backup = fs.existsSync(CALIBRATED_PATH) ? fs.readFileSync(CALIBRATED_PATH, 'utf8') : null;
    try {
      // Force env so ModelTierSelector doesn't read some other file.
      const { reloadCalibratedThresholds, getModelTierSelector } = require('../src/routing/model-tiers');
      // Write a hand-crafted calibrated file with a distinctive SIMPLE range.
      fs.mkdirSync(path.dirname(CALIBRATED_PATH), { recursive: true });
      fs.writeFileSync(CALIBRATED_PATH, JSON.stringify({
        calibratedAt: new Date().toISOString(),
        days: 7,
        sampleCount: 500,
        ranges: { SIMPLE: [0, 10], MEDIUM: [11, 40], COMPLEX: [41, 70], REASONING: [71, 100] },
        stats: {},
      }, null, 2));
      const ranges = reloadCalibratedThresholds();
      const selector = getModelTierSelector();
      assert.deepEqual(selector.ranges.SIMPLE, [0, 10]);
      // Any score ≥ 11 must now land in MEDIUM+ per the reloaded ranges.
      assert.equal(selector.getTier(11), 'MEDIUM');
      assert.equal(selector.getTier(5), 'SIMPLE');
    } finally {
      if (backup === null) {
        try { fs.unlinkSync(CALIBRATED_PATH); } catch { /* fine */ }
      } else {
        fs.writeFileSync(CALIBRATED_PATH, backup);
      }
    }
  });

test('malformed calibrated file falls back to defaults on reload',
  { skip: !_sqliteAvailable() }, () => {
    const CALIBRATED_PATH = path.join(__dirname, '../data/calibrated-thresholds.json');
    const backup = fs.existsSync(CALIBRATED_PATH) ? fs.readFileSync(CALIBRATED_PATH, 'utf8') : null;
    try {
      fs.mkdirSync(path.dirname(CALIBRATED_PATH), { recursive: true });
      fs.writeFileSync(CALIBRATED_PATH, '{ not valid json ');
      const { reloadCalibratedThresholds } = require('../src/routing/model-tiers');
      const ranges = reloadCalibratedThresholds();
      // Falls back to defaults — SIMPLE is [0, 25] in TIER_DEFINITIONS.
      assert.deepEqual(ranges.SIMPLE, [0, 25]);
    } finally {
      if (backup === null) {
        try { fs.unlinkSync(CALIBRATED_PATH); } catch { /* fine */ }
      } else {
        fs.writeFileSync(CALIBRATED_PATH, backup);
      }
    }
  });
