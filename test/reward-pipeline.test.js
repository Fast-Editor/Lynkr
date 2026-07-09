/**
 * WS5.1 — reward pipeline: computation + persistence.
 *
 * Covers:
 *   - reward formula clamps to [0, 100] and applies λ·cost + μ·latency penalty
 *   - normaliser ranges expand as new observations arrive
 *   - state persists to disk every SAVE_EVERY observations
 *   - re-loading a fresh instance restores the ranges (so the first
 *     post-restart request doesn't get scored against a re-learned range)
 *   - missing / partial observations don't corrupt ranges (Infinity stays
 *     Infinity, negative values are ignored)
 *   - malformed state on disk falls back cleanly to defaults
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { RewardPipeline, SAVE_EVERY } = require('../src/routing/reward-pipeline');

function tmpStatePath(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lynkr-reward-'));
  return path.join(dir, `${name}.json`);
}

test('reward: clamps to [0, 100]', () => {
  const rp = new RewardPipeline({ statePath: tmpStatePath('a') });
  // First observation seeds the range; can't penalise yet ⇒ reward == quality.
  const r0 = rp.reward({ quality: 80, cost: 0.01, latency: 500 });
  assert.equal(r0, 80);
  // Extreme quality below zero clamps to 0.
  const rNeg = rp.reward({ quality: -50, cost: 0, latency: 0 });
  assert.equal(rNeg, 0);
  // Extreme quality above 100 clamps to 100.
  const rHigh = rp.reward({ quality: 200, cost: 0, latency: 0 });
  assert.equal(rHigh, 100);
});

test('reward: penalises expensive + slow outcomes', () => {
  const rp = new RewardPipeline({ statePath: tmpStatePath('b') });
  // Seed a wide cost + latency range so the penalty is meaningful.
  rp.reward({ quality: 100, cost: 0.01, latency: 100 });
  rp.reward({ quality: 100, cost: 1.0, latency: 10000 });
  // Fresh call at max cost + max latency → q(100) - λ·100 - μ·100
  //   = 100 - 30 - 10 = 60 (with defaults λ=0.3, μ=0.1).
  const worst = rp.reward({ quality: 100, cost: 1.0, latency: 10000 });
  assert.ok(Math.abs(worst - 60) < 1e-6, `expected ~60, got ${worst}`);
});

test('reward: missing observations default to zero-penalty', () => {
  const rp = new RewardPipeline({ statePath: tmpStatePath('c') });
  // No cost or latency provided; quality passes through unpenalised.
  const r = rp.reward({ quality: 75 });
  assert.equal(r, 75);
});

test('reward: negative cost/latency are ignored (range not corrupted)', () => {
  const rp = new RewardPipeline({ statePath: tmpStatePath('d') });
  rp.reward({ quality: 50, cost: -0.5, latency: -100 });
  // Both ranges should still be [Infinity, -Infinity] (unseeded).
  assert.equal(rp.costRange.min, Infinity);
  assert.equal(rp.costRange.max, -Infinity);
  assert.equal(rp.latencyRange.min, Infinity);
  assert.equal(rp.latencyRange.max, -Infinity);
});

test('reward: default quality is 50 when missing', () => {
  const rp = new RewardPipeline({ statePath: tmpStatePath('e') });
  const r = rp.reward({ cost: 0.01, latency: 100 });
  assert.equal(r, 50);
});

test('persistence: state saved after SAVE_EVERY observations, loaded on reinit', () => {
  const statePath = tmpStatePath('persist');
  const rp = new RewardPipeline({ statePath });
  for (let i = 0; i < SAVE_EVERY; i++) {
    rp.reward({ quality: 60 + i, cost: 0.001 * i, latency: 100 * i });
  }
  // File should now exist.
  assert.ok(fs.existsSync(statePath), 'state file should be written');
  const saved = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  assert.equal(saved.observations, SAVE_EVERY);
  assert.equal(saved.costRange.min, 0);
  assert.ok(saved.costRange.max > 0);

  // Reinit — a fresh instance should restore the same ranges without
  // re-learning them.
  const rp2 = new RewardPipeline({ statePath });
  assert.equal(rp2.observations, SAVE_EVERY);
  assert.equal(rp2.costRange.min, rp.costRange.min);
  assert.equal(rp2.costRange.max, rp.costRange.max);
  assert.equal(rp2.latencyRange.max, rp.latencyRange.max);
});

test('persistence: unseeded Infinity ranges round-trip as null', () => {
  const statePath = tmpStatePath('inf');
  const rp = new RewardPipeline({ statePath });
  // Force a save before any observations.
  rp._save();
  const saved = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  assert.equal(saved.costRange.min, null);
  assert.equal(saved.costRange.max, null);
  // Reload; ranges come back as Infinity/-Infinity.
  const rp2 = new RewardPipeline({ statePath });
  assert.equal(rp2.costRange.min, Infinity);
  assert.equal(rp2.costRange.max, -Infinity);
});

test('persistence: malformed state on disk does not crash init', () => {
  const statePath = tmpStatePath('bad');
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, '{not valid json{');
  const rp = new RewardPipeline({ statePath });
  // Falls back to defaults; still functional.
  assert.equal(rp.observations, 0);
  const r = rp.reward({ quality: 80 });
  assert.equal(r, 80);
});
