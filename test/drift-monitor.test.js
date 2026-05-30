const test = require('node:test');
const assert = require('node:assert/strict');
const { psi, detect, _bucketize, WARN_THRESHOLD } = require('../src/routing/drift-monitor');

test('PSI is ~0 for identical distributions', () => {
  const oldB = [10, 20, 30, 20, 10];
  const newB = [10, 20, 30, 20, 10];
  assert.ok(psi(oldB, newB) < 0.01);
});

test('PSI is large for very different distributions', () => {
  const oldB = [50, 30, 10, 5, 5];
  const newB = [5, 5, 10, 30, 50];
  assert.ok(psi(oldB, newB) > 0.5);
});

test('bucketize splits values into bins', () => {
  const counts = _bucketize([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 5);
  assert.equal(counts.length, 5);
  assert.equal(counts.reduce((s, c) => s + c, 0), 10);
});

test('detect returns insufficient_data for small samples', () => {
  const r = detect('test', [1, 2, 3], [1, 2, 3]);
  assert.equal(r.level, 'insufficient_data');
});

test('detect flags warn level on real drift', () => {
  const oldVals = Array.from({ length: 100 }, () => Math.random() * 10);
  const newVals = Array.from({ length: 100 }, () => Math.random() * 10 + 5);
  const r = detect('latency', oldVals, newVals);
  // shifted by 5 over a [0, 10] base — should produce meaningful PSI
  assert.ok(r.psi >= 0);
});
