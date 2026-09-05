/**
 * Pin-aware, model-derived token budget (computeModelTokenBudget).
 *
 * Contract:
 *   1. known requested model → budget = its real window × 0.85
 *   2. virtual/unknown name + session pin → the PIN's model window (the pin
 *      is the only thing that knows what's actually serving behind
 *      "lynkr-auto")
 *   3. no pin → conservative floor (min across configured tiers) or the
 *      180k fallback — never a guess above what routing could serve
 *   4. TOKEN_BUDGET_MAX is an OPT-IN clamp: applied only when explicitly
 *      set; absent → a 1M model really gets an 850k budget
 */

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.DATABRICKS_API_KEY = process.env.DATABRICKS_API_KEY || 'test-key';
process.env.DATABRICKS_API_BASE = process.env.DATABRICKS_API_BASE || 'http://test.com';
process.env.LOG_FILE_ENABLED = 'false';

const { computeModelTokenBudget } = require('../src/orchestrator');
const sessionAffinity = require('../src/routing/session-affinity');

// dotenv (via config) may have loaded a TOKEN_BUDGET_MAX from a local .env —
// the function reads the env at call time, so clearing per-test is reliable.
test.beforeEach(() => {
  delete process.env.TOKEN_BUDGET_MAX;
});

test('known model, no cap set: budget is the real window × 0.85 (1M model → 850k)', () => {
  const b = computeModelTokenBudget('databricks-claude-opus-4-6'); // context: 1,000,000
  assert.equal(b.modelContextWindow, 1000000);
  assert.equal(b.effectiveMax, 850000);
  assert.equal(b.effectiveWarning, Math.floor(850000 * 0.65));
  assert.equal(b.source, 'requested-model');
});

test('known 200k model: budget 170k', () => {
  const b = computeModelTokenBudget('databricks-claude-sonnet-4-5'); // context: 200,000
  assert.equal(b.effectiveMax, 170000);
  assert.equal(b.source, 'requested-model');
});

test('TOKEN_BUDGET_MAX explicitly set: clamps the auto budget', () => {
  process.env.TOKEN_BUDGET_MAX = '180000';
  const b = computeModelTokenBudget('databricks-claude-opus-4-6');
  assert.equal(b.modelContextWindow, 1000000, 'window still reported truthfully');
  assert.equal(b.effectiveMax, 180000, 'explicit cap wins');
});

test('virtual name with a session pin resolves the PIN model\'s window', () => {
  const sessionId = `fp-test-budget-${Date.now()}`;
  sessionAffinity.setPin(sessionId, {
    provider: 'databricks',
    model: 'databricks-claude-opus-4-6',
    tier: 'REASONING',
    score: 80,
  });
  const b = computeModelTokenBudget('lynkr-auto-unknown-virtual', sessionId);
  assert.equal(b.modelContextWindow, 1000000);
  assert.equal(b.effectiveMax, 850000);
  assert.equal(b.source, 'session-pin');
  sessionAffinity.removePin(sessionId);
});

test('virtual name without a pin falls to the conservative floor, never above', () => {
  const b = computeModelTokenBudget('lynkr-auto-unknown-virtual', null);
  assert.ok(['min-tier', 'default'].includes(b.source), `expected floor source, got ${b.source}`);
  assert.ok(b.modelContextWindow > 0);
  assert.equal(b.effectiveMax, Math.floor(b.modelContextWindow * 0.85));
  assert.ok(b.effectiveMax <= 850000, 'floor must never exceed a big-model budget');
});

test('invalid explicit cap (0 / garbage) is ignored, auto budget applies', () => {
  process.env.TOKEN_BUDGET_MAX = '0';
  assert.equal(computeModelTokenBudget('databricks-claude-sonnet-4-5').effectiveMax, 170000);
  process.env.TOKEN_BUDGET_MAX = 'not-a-number';
  assert.equal(computeModelTokenBudget('databricks-claude-sonnet-4-5').effectiveMax, 170000);
});
