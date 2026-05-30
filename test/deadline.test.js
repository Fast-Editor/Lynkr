const test = require('node:test');
const assert = require('node:assert/strict');
const { getDeadlineMs, chooseFastest, fits } = require('../src/routing/deadline');
const { getLatencyTracker } = require('../src/routing/latency-tracker');

test('getDeadlineMs reads header', () => {
  assert.equal(getDeadlineMs({ headers: { 'lynkr-deadline-ms': '5000' } }), 5000);
  assert.equal(getDeadlineMs({ headers: {} }), null);
  assert.equal(getDeadlineMs({ headers: { 'lynkr-deadline-ms': 'not-a-number' } }), null);
});

test('fits returns true when latency unknown', () => {
  assert.equal(fits('newprovider', 'newmodel', 5000), true);
});

test('chooseFastest picks model with lowest P95 within deadline', () => {
  const tracker = getLatencyTracker();
  for (let i = 0; i < 20; i++) {
    tracker.record('p1', 'fast-model', 500);
    tracker.record('p1', 'slow-model', 8000);
  }
  const chosen = chooseFastest(
    [{ provider: 'p1', model: 'fast-model' }, { provider: 'p1', model: 'slow-model' }],
    3000
  );
  assert.equal(chosen.model, 'fast-model');
});

test('chooseFastest returns null when no candidate fits', () => {
  const tracker = getLatencyTracker();
  for (let i = 0; i < 20; i++) {
    tracker.record('p2', 'too-slow', 10000);
  }
  const chosen = chooseFastest([{ provider: 'p2', model: 'too-slow' }], 1000);
  assert.equal(chosen, null);
});
