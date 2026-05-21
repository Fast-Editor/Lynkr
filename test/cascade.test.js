const test = require('node:test');
const assert = require('node:assert/strict');
const cascade = require('../src/routing/cascade');

test('shouldCascade respects feature flag', () => {
  delete process.env.LYNKR_CASCADE_ENABLED;
  assert.equal(cascade.shouldCascade({ tier: 'COMPLEX' }), false);
  process.env.LYNKR_CASCADE_ENABLED = 'true';
  assert.equal(cascade.shouldCascade({ tier: 'COMPLEX', streaming: false, hasTools: false }), true);
  delete process.env.LYNKR_CASCADE_ENABLED;
});

test('shouldCascade refuses streaming + tools', () => {
  process.env.LYNKR_CASCADE_ENABLED = 'true';
  assert.equal(cascade.shouldCascade({ tier: 'COMPLEX', streaming: true }), false);
  assert.equal(cascade.shouldCascade({ tier: 'COMPLEX', hasTools: true }), false);
  delete process.env.LYNKR_CASCADE_ENABLED;
});

test('shouldCascade skips SIMPLE and REASONING', () => {
  process.env.LYNKR_CASCADE_ENABLED = 'true';
  assert.equal(cascade.shouldCascade({ tier: 'SIMPLE' }), false);
  assert.equal(cascade.shouldCascade({ tier: 'REASONING' }), false);
  delete process.env.LYNKR_CASCADE_ENABLED;
});

test('cascade.run accepts high-confidence small response', async () => {
  const small = { content: [{ type: 'text', text: 'The capital of France is Paris.' }] };
  const big = { content: [{ type: 'text', text: 'should not run' }] };
  let bigCalled = false;
  const result = await cascade.run({
    payload: { messages: [{ role: 'user', content: 'capital of France?' }] },
    smallModel: { provider: 'anthropic', model: 'claude-haiku' },
    bigModel: { provider: 'anthropic', model: 'claude-opus' },
    invoke: async (provider, model) => {
      if (model === 'claude-haiku') return small;
      bigCalled = true;
      return big;
    },
    taskType: 'factoid',
    threshold: 0.7,
  });
  assert.equal(result.usedModel.model, 'claude-haiku');
  assert.equal(bigCalled, false);
  assert.equal(result.cascadeStats.accepted, true);
});

test('cascade.run escalates on uncertain small response', async () => {
  const small = { content: [{ type: 'text', text: "I don't know, I'm not sure about that." }] };
  const big = { content: [{ type: 'text', text: 'Definitive answer.' }] };
  const result = await cascade.run({
    payload: { messages: [{ role: 'user', content: 'something hard' }] },
    smallModel: { provider: 'anthropic', model: 'claude-haiku' },
    bigModel: { provider: 'anthropic', model: 'claude-opus' },
    invoke: async (provider, model) => {
      if (model === 'claude-haiku') return small;
      return big;
    },
    taskType: 'reasoning',
    threshold: 0.7,
  });
  assert.equal(result.usedModel.model, 'claude-opus');
  assert.equal(result.cascadeStats.accepted, false);
});
