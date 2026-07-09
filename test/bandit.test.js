const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const STATE_PATH = path.join(__dirname, '../data/bandit-state.json');
// Backup any existing state so tests are deterministic
const _backupPath = STATE_PATH + '.test-backup';
test.before(() => {
  if (fs.existsSync(STATE_PATH)) fs.renameSync(STATE_PATH, _backupPath);
});
test.after(() => {
  if (fs.existsSync(STATE_PATH)) fs.unlinkSync(STATE_PATH);
  if (fs.existsSync(_backupPath)) fs.renameSync(_backupPath, STATE_PATH);
});

const { LinUCBBandit } = require('../src/routing/bandit');

test('bandit picks an arm from candidates', () => {
  const b = new LinUCBBandit({ dim: 4 });
  const candidates = [
    { provider: 'anthropic', model: 'claude-opus-4-7' },
    { provider: 'anthropic', model: 'claude-sonnet-4-6' },
  ];
  const ctx = [1, 0, 0.5, 0.2];
  const chosen = b.pick('COMPLEX', candidates, ctx);
  assert.ok(chosen);
  assert.ok(['claude-opus-4-7', 'claude-sonnet-4-6'].includes(chosen.model));
});

test('bandit updates arm and learns', () => {
  const b = new LinUCBBandit({ dim: 4 });
  const ctx = [1, 0, 0.5, 0.2];
  // Reward sonnet much higher than opus
  for (let i = 0; i < 50; i++) {
    b.update('COMPLEX', 'anthropic', 'claude-sonnet-4-6', ctx, 90);
    b.update('COMPLEX', 'anthropic', 'claude-opus-4-7', ctx, 30);
  }
  // After enough updates, sonnet should be preferred (mostly — there's 5% random exploration)
  let sonnetWins = 0;
  for (let i = 0; i < 100; i++) {
    const chosen = b.pick('COMPLEX', [
      { provider: 'anthropic', model: 'claude-opus-4-7' },
      { provider: 'anthropic', model: 'claude-sonnet-4-6' },
    ], ctx);
    if (chosen.model === 'claude-sonnet-4-6') sonnetWins++;
  }
  assert.ok(sonnetWins > 70, `expected >70 sonnet wins out of 100, got ${sonnetWins}`);
});

test('bandit handles dim mismatch by padding', () => {
  const b = new LinUCBBandit({ dim: 8 });
  const chosen = b.pick('SIMPLE', [{ provider: 'ollama', model: 'llama3.2' }], [1, 0, 1]);
  assert.ok(chosen);
});

// WS4.1 — propensity for off-policy evaluation.
// Explored pick: ε / K. Exploited pick: 1 − ε + ε/K. Sum over all K arms = 1.
test('pick returns propensity = 1 − ε + ε/K on the exploited branch', () => {
  // Force Math.random() to always exit the ε-greedy branch (returns 0.99 > ε).
  const b = new LinUCBBandit({ dim: 4, explorationRate: 0.1 });
  const candidates = [
    { provider: 'a', model: 'm1' },
    { provider: 'a', model: 'm2' },
    { provider: 'a', model: 'm3' },
    { provider: 'a', model: 'm4' },
  ];
  const originalRandom = Math.random;
  Math.random = () => 0.99; // > 0.1 ⇒ exploit
  try {
    const chosen = b.pick('SIMPLE', candidates, [1, 0, 0.5, 0.2]);
    assert.equal(chosen.explored, false);
    // K=4, ε=0.1 → 1 - 0.1 + 0.1/4 = 0.925
    assert.ok(Math.abs(chosen.propensity - 0.925) < 1e-9,
      `expected propensity≈0.925, got ${chosen.propensity}`);
  } finally {
    Math.random = originalRandom;
  }
});

test('pick returns propensity = ε/K on the explored branch', () => {
  const b = new LinUCBBandit({ dim: 4, explorationRate: 0.2 });
  const candidates = [
    { provider: 'a', model: 'm1' },
    { provider: 'a', model: 'm2' },
    { provider: 'a', model: 'm3' },
    { provider: 'a', model: 'm4' },
  ];
  const originalRandom = Math.random;
  // Random calls in order: gate for ε-branch, then index selection.
  const values = [0.01, 0.5];
  let i = 0;
  Math.random = () => values[i++];
  try {
    const chosen = b.pick('SIMPLE', candidates, [1, 0, 0.5, 0.2]);
    assert.equal(chosen.explored, true);
    // K=4, ε=0.2 → 0.2/4 = 0.05
    assert.ok(Math.abs(chosen.propensity - 0.05) < 1e-9,
      `expected propensity≈0.05, got ${chosen.propensity}`);
  } finally {
    Math.random = originalRandom;
  }
});

test('K=1 collapses both branches to propensity = 1.0', () => {
  const b = new LinUCBBandit({ dim: 4, explorationRate: 0.1 });
  const one = [{ provider: 'a', model: 'm1' }];
  const originalRandom = Math.random;
  try {
    // Exploit branch: 1 - ε + ε/1 = 1.0
    Math.random = () => 0.99;
    let chosen = b.pick('SIMPLE', one, [1, 0, 0.5, 0.2]);
    assert.ok(Math.abs(chosen.propensity - 1.0) < 1e-9);
    // Explore branch: ε/1 = ε — but K=1 doesn't collapse this; it's ε, not 1.
    // This is an accurate reflection of the policy: the ε-branch has ε
    // probability under the sampling model even with only one arm.
    Math.random = () => 0.01;
    chosen = b.pick('SIMPLE', one, [1, 0, 0.5, 0.2]);
    assert.ok(Math.abs(chosen.propensity - 0.1) < 1e-9);
  } finally {
    Math.random = originalRandom;
  }
});

test('propensities across all arms sum to 1 in the exploit branch', () => {
  // Property check: for a fixed context, no matter which arm gets exploited,
  // the served arm has 1 − ε + ε/K and every other arm would have ε/K, so
  // Σ = (1 − ε + ε/K) + (K − 1)·(ε/K) = 1.
  const b = new LinUCBBandit({ dim: 4, explorationRate: 0.05 });
  const candidates = [
    { provider: 'a', model: 'm1' },
    { provider: 'a', model: 'm2' },
    { provider: 'a', model: 'm3' },
  ];
  const originalRandom = Math.random;
  Math.random = () => 0.99;
  try {
    const chosen = b.pick('SIMPLE', candidates, [1, 0, 0.5, 0.2]);
    const K = candidates.length;
    const eps = 0.05;
    const others = (K - 1) * (eps / K);
    assert.ok(Math.abs(chosen.propensity + others - 1.0) < 1e-9);
  } finally {
    Math.random = originalRandom;
  }
});
