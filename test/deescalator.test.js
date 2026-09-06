/**
 * WS2.3 — de-escalator unit tests.
 *
 * The evidence rule: for a given (tier, request_type) that the router is
 * about to serve, demote to the tier below iff the lower tier has served
 * ≥ MIN_SAMPLES requests of this request_type at avg_quality ≥ MIN_QUALITY
 * and error_rate < MAX_ERROR_RATE inside the window.
 *
 * These tests inject a fake telemetry query so we exercise the rule without
 * needing better-sqlite3 or a real DB — that isolation matters because the
 * live-wire behavior is separately covered by scenario-level tests.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { suggestDemotion, _clearCache } = require('../src/routing/deescalator');

function fakeQuery(rows) {
  return () => rows;
}

test.beforeEach(() => {
  _clearCache();
});

test('demotes when lower tier has >=30 rows, avg_quality >=70, error <5%', () => {
  const rows = [
    { tier: 'MEDIUM', request_type: 'code_gen', count: 42, avg_quality: 82, error_rate: 0.01 },
  ];
  const result = suggestDemotion({
    tier: 'COMPLEX',
    requestType: 'code_gen',
    deps: { getQualityByTierAndType: fakeQuery(rows) },
  });
  assert.equal(result, 'MEDIUM');
});

test('does not demote with only 29 samples', () => {
  const rows = [
    { tier: 'MEDIUM', request_type: 'code_gen', count: 29, avg_quality: 82, error_rate: 0.01 },
  ];
  const result = suggestDemotion({
    tier: 'COMPLEX',
    requestType: 'code_gen',
    deps: { getQualityByTierAndType: fakeQuery(rows) },
  });
  assert.equal(result, null);
});

test('does not demote with avg quality 60', () => {
  const rows = [
    { tier: 'MEDIUM', request_type: 'code_gen', count: 50, avg_quality: 60, error_rate: 0.01 },
  ];
  const result = suggestDemotion({
    tier: 'COMPLEX',
    requestType: 'code_gen',
    deps: { getQualityByTierAndType: fakeQuery(rows) },
  });
  assert.equal(result, null);
});

test('does not demote when error rate >=5%', () => {
  const rows = [
    { tier: 'MEDIUM', request_type: 'code_gen', count: 50, avg_quality: 82, error_rate: 0.06 },
  ];
  const result = suggestDemotion({
    tier: 'COMPLEX',
    requestType: 'code_gen',
    deps: { getQualityByTierAndType: fakeQuery(rows) },
  });
  assert.equal(result, null);
});

test('SIMPLE has no lower tier — never demoted', () => {
  const rows = [
    { tier: 'SIMPLE', request_type: 'code_gen', count: 100, avg_quality: 90, error_rate: 0 },
  ];
  const result = suggestDemotion({
    tier: 'SIMPLE',
    requestType: 'code_gen',
    deps: { getQualityByTierAndType: fakeQuery(rows) },
  });
  assert.equal(result, null);
});

test('demotes across tier order: REASONING → COMPLEX', () => {
  const rows = [
    { tier: 'COMPLEX', request_type: 'reasoning', count: 40, avg_quality: 78, error_rate: 0.02 },
  ];
  const result = suggestDemotion({
    tier: 'REASONING',
    requestType: 'reasoning',
    deps: { getQualityByTierAndType: fakeQuery(rows) },
  });
  assert.equal(result, 'COMPLEX');
});

test('missing request_type returns null (cannot form the cohort)', () => {
  const result = suggestDemotion({
    tier: 'COMPLEX',
    requestType: null,
    deps: { getQualityByTierAndType: fakeQuery([]) },
  });
  assert.equal(result, null);
});

test('unrelated request_type in rows does NOT trigger demotion', () => {
  const rows = [
    { tier: 'MEDIUM', request_type: 'chat', count: 100, avg_quality: 95, error_rate: 0 },
  ];
  const result = suggestDemotion({
    tier: 'COMPLEX',
    requestType: 'code_gen',
    deps: { getQualityByTierAndType: fakeQuery(rows) },
  });
  assert.equal(result, null);
});

test('cached decision is reused within TTL', () => {
  let calls = 0;
  const query = () => {
    calls++;
    return [
      { tier: 'MEDIUM', request_type: 'code_gen', count: 50, avg_quality: 82, error_rate: 0 },
    ];
  };
  const args = {
    tier: 'COMPLEX',
    requestType: 'code_gen',
    deps: { getQualityByTierAndType: query, now: () => 1000 },
  };
  const a = suggestDemotion(args);
  const b = suggestDemotion(args);
  assert.equal(a, 'MEDIUM');
  assert.equal(b, 'MEDIUM');
  assert.equal(calls, 1); // second call hit cache
});

test('cache invalidated after TTL', () => {
  let calls = 0;
  const query = () => {
    calls++;
    return [
      { tier: 'MEDIUM', request_type: 'code_gen', count: 50, avg_quality: 82, error_rate: 0 },
    ];
  };
  const t0 = 1_000;
  const t1 = t0 + 61_000; // > 60s TTL
  suggestDemotion({
    tier: 'COMPLEX',
    requestType: 'code_gen',
    deps: { getQualityByTierAndType: query, now: () => t0 },
  });
  suggestDemotion({
    tier: 'COMPLEX',
    requestType: 'code_gen',
    deps: { getQualityByTierAndType: query, now: () => t1 },
  });
  assert.equal(calls, 2);
});

// --- Percentage holdout (ROUTING-NOTES §4.10.4) ---------------------------

const { isHeldOut } = require('../src/routing/deescalator');

test('holdout: null session key is never held out', () => {
  process.env.LYNKR_DEESCALATION_HOLDOUT_PCT = '50';
  assert.equal(isHeldOut(null), false);
  assert.equal(isHeldOut(undefined), false);
  delete process.env.LYNKR_DEESCALATION_HOLDOUT_PCT;
});

test('holdout: 0 pct disables the holdout entirely', () => {
  process.env.LYNKR_DEESCALATION_HOLDOUT_PCT = '0';
  for (let i = 0; i < 50; i++) {
    assert.equal(isHeldOut(`session-${i}`), false);
  }
  delete process.env.LYNKR_DEESCALATION_HOLDOUT_PCT;
});

test('holdout: 100 pct holds every session out', () => {
  process.env.LYNKR_DEESCALATION_HOLDOUT_PCT = '100';
  for (let i = 0; i < 50; i++) {
    assert.equal(isHeldOut(`session-${i}`), true);
  }
  delete process.env.LYNKR_DEESCALATION_HOLDOUT_PCT;
});

test('holdout: deterministic — same session key always lands on the same side', () => {
  process.env.LYNKR_DEESCALATION_HOLDOUT_PCT = '30';
  for (let i = 0; i < 20; i++) {
    const key = `fp-abc${i}`;
    const first = isHeldOut(key);
    for (let j = 0; j < 5; j++) {
      assert.equal(isHeldOut(key), first, `session ${key} flip-flopped`);
    }
  }
  delete process.env.LYNKR_DEESCALATION_HOLDOUT_PCT;
});

test('holdout: observed rate roughly tracks the configured percentage', () => {
  process.env.LYNKR_DEESCALATION_HOLDOUT_PCT = '20';
  let held = 0;
  const N = 2000;
  for (let i = 0; i < N; i++) {
    if (isHeldOut(`fp-${i}-${i * 7919}`)) held++;
  }
  const rate = held / N;
  assert.ok(rate > 0.15 && rate < 0.25, `expected ~0.20 holdout rate, got ${rate}`);
  delete process.env.LYNKR_DEESCALATION_HOLDOUT_PCT;
});

test('holdout: default (env unset) is 10 pct, and invalid values clamp sanely', () => {
  delete process.env.LYNKR_DEESCALATION_HOLDOUT_PCT;
  let held = 0;
  const N = 2000;
  for (let i = 0; i < N; i++) {
    if (isHeldOut(`fp-${i}-${i * 104729}`)) held++;
  }
  const rate = held / N;
  assert.ok(rate > 0.06 && rate < 0.14, `expected ~0.10 default holdout rate, got ${rate}`);

  process.env.LYNKR_DEESCALATION_HOLDOUT_PCT = '250';
  assert.equal(isHeldOut('any-session'), true, '>100 clamps to 100');
  process.env.LYNKR_DEESCALATION_HOLDOUT_PCT = '-5';
  assert.equal(isHeldOut('any-session'), false, 'negative clamps to 0');
  delete process.env.LYNKR_DEESCALATION_HOLDOUT_PCT;
});
