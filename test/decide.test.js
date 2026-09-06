/**
 * Contract tests for src/routing/decide.js — the extracted decision core.
 *
 * These pin the module's own behavior (context-vector layout, candidate
 * eligibility, propensity collapse rule) independently of routing/index.js,
 * because the off-policy evaluator will import these functions directly to
 * replay logged decisions — a silent contract drift here would corrupt
 * counterfactual estimates without failing any routing test.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.DATABRICKS_API_KEY = process.env.DATABRICKS_API_KEY || 'test-key';
process.env.DATABRICKS_API_BASE = process.env.DATABRICKS_API_BASE || 'http://test.com';
process.env.LOG_FILE_ENABLED = 'false';

const { TASK_TYPES, buildContextVector, decide, stampPropensity } = require('../src/routing/decide');

test('context vector is 12-dim: 6 scalar features + 6-way task one-hot', () => {
  const ctx = buildContextVector({
    analysis: { score: 50, breakdown: { tokenCount: 100, taskType: { reason: 'code_gen' } } },
    payload: { tools: [{}] },
    options: { streaming: true },
    risk: { level: 'medium' },
    agenticResult: { isAgentic: true },
  });
  assert.equal(ctx.length, 6 + TASK_TYPES.length);
  assert.equal(ctx[0], 0.5);                                // score/100
  assert.equal(ctx[1], Math.log(101) / 15);                 // log(tokens+1)/15
  assert.equal(ctx[2], 1);                                  // has tools
  assert.equal(ctx[3], 1);                                  // streaming
  assert.equal(ctx[4], 0.5);                                // medium risk
  assert.equal(ctx[5], 1);                                  // agentic
  assert.deepEqual(ctx.slice(6), [1, 0, 0, 0, 0, 0]);       // code_gen one-hot
});

test('context vector defaults: empty inputs produce the "other" task one-hot', () => {
  const ctx = buildContextVector({ analysis: {} });
  assert.equal(ctx[0], 0);
  assert.equal(ctx[4], 0); // no risk info → 0
  // 'other' is index 5 in TASK_TYPES
  assert.deepEqual(ctx.slice(6), [0, 0, 0, 0, 0, 1]);
});

test('decide returns null when there is nothing to adjudicate', () => {
  const ctx = buildContextVector({ analysis: { score: 10 } });
  assert.equal(decide('SIMPLE', [], ctx), null);
  assert.equal(decide('SIMPLE', [{ provider: 'ollama', model: 'qwen' }], ctx), null);
  assert.equal(decide('SIMPLE', null, ctx), null);
});

test('decide returns a pick carrying propensity, candidates, and context', () => {
  const ctx = buildContextVector({ analysis: { score: 10 } });
  const candidates = [
    { provider: 'ollama', model: 'qwen' },
    { provider: 'databricks', model: 'claude-sonnet' },
  ];
  const result = decide('SIMPLE', candidates, ctx);
  assert.ok(result, 'expected a pick with 2 candidates');
  assert.ok(candidates.some(c => c.model === result.model), 'pick must be one of the candidates');
  assert.ok(result.propensity > 0 && result.propensity <= 1, `propensity in (0,1], got ${result.propensity}`);
  assert.deepEqual(result.candidates, candidates);
  assert.deepEqual(result.context, ctx);
});

test('stampPropensity: served model in bandit candidate set keeps bandit propensity + context', () => {
  const decision = {};
  const banditResult = {
    propensity: 0.9625,
    candidates: [
      { provider: 'ollama', model: 'qwen' },
      { provider: 'databricks', model: 'claude-sonnet' },
    ],
    context: [0.1, 0.2],
  };
  stampPropensity(decision, { provider: 'databricks', model: 'claude-sonnet' }, banditResult);
  assert.equal(decision.propensity, 0.9625);
  assert.equal(decision.candidates.length, 2);
  assert.deepEqual(decision._banditContext, [0.1, 0.2]);
});

test('stampPropensity: downstream override swapping the served model collapses to 1.0', () => {
  const decision = {};
  const banditResult = {
    propensity: 0.9625,
    candidates: [{ provider: 'ollama', model: 'qwen' }],
    context: [0.1],
  };
  // Tenant/deadline override served something the bandit never considered.
  stampPropensity(decision, { provider: 'azure', model: 'gpt-4o' }, banditResult);
  assert.equal(decision.propensity, 1.0);
  assert.deepEqual(decision.candidates, [{ provider: 'azure', model: 'gpt-4o' }]);
  assert.equal(decision._banditContext, null);
});

test('stampPropensity: bandit never ran (null result) collapses to 1.0', () => {
  const decision = {};
  stampPropensity(decision, { provider: 'ollama', model: 'qwen' }, null);
  assert.equal(decision.propensity, 1.0);
  assert.deepEqual(decision.candidates, [{ provider: 'ollama', model: 'qwen' }]);
  assert.equal(decision._banditContext, null);
});

test('TASK_TYPES order is frozen — bandit arms were trained against these indices', () => {
  // Reordering or inserting entries silently corrupts every persisted arm's
  // learned weights (feature indices 6..11 shift). Append-only, with a
  // bandit-state migration. This test makes that drift loud.
  assert.deepEqual(TASK_TYPES, ['code_gen', 'summarization', 'reasoning', 'factoid', 'chat', 'other']);
});
