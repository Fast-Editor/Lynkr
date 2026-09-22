const assert = require('assert');
const { describe, it, beforeEach } = require('node:test');

const ledger = require('../src/routing/quota-ledger');

// Deterministic resolver: haiku 1+5, sonnet 2+10, opus 5+25.
const resolveFn = (_provider, model) => {
  const table = {
    haiku: { inputPerM: 1, outputPerM: 5 },
    sonnet: { inputPerM: 2, outputPerM: 10 },
    opus: { inputPerM: 5, outputPerM: 25 },
  };
  return table[model] || null;
};

describe('quota-ledger model weights', () => {
  it('weights track price ratios against the Haiku baseline', () => {
    assert.strictEqual(ledger.modelWeight('haiku', resolveFn), 1);
    assert.strictEqual(ledger.modelWeight('sonnet', resolveFn), 2);
    assert.strictEqual(ledger.modelWeight('opus', resolveFn), 5);
  });

  it('fails to middle for unknown/unpriced models and errors', () => {
    assert.strictEqual(ledger.modelWeight('mystery-9z', resolveFn), 2);
    assert.strictEqual(ledger.modelWeight(null, resolveFn), 2);
    assert.strictEqual(ledger.modelWeight('haiku', () => { throw new Error('econ down'); }), 2);
  });
});

describe('quota-ledger burn windows', () => {
  beforeEach(() => ledger._reset());

  it('idle sessions read zero pressure', () => {
    assert.strictEqual(ledger.pressure('nope'), 0);
  });

  it('ignores empty usage and missing sessions', () => {
    ledger.record(null, { model: 'opus', inputTokens: 99999, outputTokens: 99999 }, resolveFn);
    ledger.record('s', {}, resolveFn);
    assert.strictEqual(ledger.pressure('s'), 0);
  });

  it('accumulates burn and saturates at 1', () => {
    // 10 sustained 10k-token Opus turns: 10 × 10 × 5 = 500 units = full.
    for (let i = 0; i < 10; i++) {
      ledger.record('hot', { model: 'opus', inputTokens: 9000, outputTokens: 1000 }, resolveFn);
    }
    assert.strictEqual(ledger._windowBurn('hot'), 500);
    assert.strictEqual(ledger.pressure('hot'), 1);
    // More turns stay capped, window slides (still 10 turns).
    ledger.record('hot', { model: 'opus', inputTokens: 9000, outputTokens: 1000 }, resolveFn);
    assert.strictEqual(ledger.pressure('hot'), 1);
  });

  it('a lone upgrade barely registers', () => {
    for (let i = 0; i < 9; i++) {
      ledger.record('mixed', { model: 'haiku', inputTokens: 900, outputTokens: 100 }, resolveFn);
    }
    ledger.record('mixed', { model: 'opus', inputTokens: 9000, outputTokens: 1000 }, resolveFn);
    const p = ledger.pressure('mixed');
    assert.ok(p > 0 && p < 0.15, `expected faint pressure, got ${p}`);
  });

  it('sliding window forgets old peaks', () => {
    for (let i = 0; i < 10; i++) {
      ledger.record('cool', { model: 'opus', inputTokens: 9000, outputTokens: 1000 }, resolveFn);
    }
    assert.strictEqual(ledger.pressure('cool'), 1);
    for (let i = 0; i < 10; i++) {
      ledger.record('cool', { model: 'haiku', inputTokens: 900, outputTokens: 100 }, resolveFn);
    }
    assert.ok(ledger.pressure('cool') < 0.05, `expected cooldown, got ${ledger.pressure('cool')}`);
  });
});
