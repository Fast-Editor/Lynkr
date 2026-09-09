const assert = require('assert');
const { describe, it, beforeEach, afterEach } = require('node:test');
const { buildRequirementVector } = require('../src/routing/capabilities');
const shortfall = require('../src/routing/shortfall');

function dims(over = {}) {
  return {
    tokenCount: 10,
    promptComplexity: 20,
    technicalDepth: 20,
    domainSpecificity: 20,
    toolCount: 0,
    toolComplexity: 0,
    toolChainPotential: 20,
    multiStepReasoning: 20,
    codeGeneration: 20,
    analysisDepth: 20,
    conversationDepth: 10,
    priorToolUsage: 10,
    ambiguity: 40,
    ...over,
  };
}

describe('capability requirement vector', () => {
  it('maps trivial dims to low requirements on every head', () => {
    const v = buildRequirementVector({ dimensions: dims() });
    for (const h of ['reasoning', 'codegen', 'debugging', 'tool_use']) {
      assert.ok(v[h] >= 0 && v[h] <= 0.35, `${h}=${v[h]}`);
    }
  });

  it('maps code-heavy dims to high codegen, low reasoning', () => {
    const v = buildRequirementVector({
      dimensions: dims({ codeGeneration: 80, technicalDepth: 80, toolComplexity: 80 }),
    });
    assert.ok(v.codegen > 0.6, `codegen=${v.codegen}`);
    assert.ok(v.reasoning < 0.4, `reasoning=${v.reasoning}`);
  });

  it('agentic floors tool_use without lowering other heads', () => {
    const plain = buildRequirementVector({ dimensions: dims() });
    const agentic = buildRequirementVector({ dimensions: dims(), agenticResult: { isAgentic: true } });
    assert.ok(agentic.tool_use >= 0.6);
    assert.strictEqual(agentic.reasoning, plain.reasoning);
  });

  it('fails open on garbage input', () => {
    const v = buildRequirementVector({});
    assert.deepStrictEqual(Object.keys(v).sort(), ['codegen', 'debugging', 'reasoning', 'tool_use']);
  });
});

describe('shortfall matching', () => {
  let env;
  beforeEach(() => {
    env = { ...process.env };
    shortfall._resetProfilesCache();
  });
  afterEach(() => {
    process.env = env;
    shortfall._resetProfilesCache();
  });

  const cands = [
    { provider: 'openai', model: 'cheap', tier: 'SIMPLE', cost: 0.1 },
    { provider: 'openai', model: 'mid', tier: 'MEDIUM', cost: 1 },
    { provider: 'azure-openai', model: 'big', tier: 'REASONING', cost: 5 },
  ];

  it('picks cheapest covering model for a trivial request', () => {
    const req = { reasoning: 0.1, codegen: 0.1, debugging: 0.1, tool_use: 0.1 };
    const r = shortfall.selectByShortfall(req, cands, { tau: 0.24 });
    assert.strictEqual(r.selected.model, 'cheap');
  });

  it('escalates past cheap when requirements exceed its caps', () => {
    const req = { reasoning: 0.8, codegen: 0.8, debugging: 0.8, tool_use: 0.8 };
    const r = shortfall.selectByShortfall(req, cands, { tau: 0.24 });
    assert.strictEqual(r.selected.model, 'big');
  });

  it('tau gates coverage: strict tau escalates, loose tau economizes', () => {
    const req = { reasoning: 0.5, codegen: 0.5, debugging: 0.5, tool_use: 0.5 };
    const strict = shortfall.selectByShortfall(req, cands, { tau: 0.01 });
    const loose = shortfall.selectByShortfall(req, cands, { tau: 0.5 });
    assert.ok(['mid', 'big'].includes(strict.selected.model));
    assert.strictEqual(loose.selected.model, 'cheap');
  });

  it('catalog change re-routes with zero retraining (model removal)', () => {
    const req = { reasoning: 0.1, codegen: 0.1, debugging: 0.1, tool_use: 0.1 };
    const full = shortfall.selectByShortfall(req, cands, { tau: 0.24 });
    assert.strictEqual(full.selected.model, 'cheap');
    const withoutCheap = shortfall.selectByShortfall(req, cands.slice(1), { tau: 0.24 });
    assert.strictEqual(withoutCheap.selected.model, 'mid');
  });

  it('unknown cost never wins on cheapness alone', () => {
    const req = { reasoning: 0.1, codegen: 0.1, debugging: 0.1, tool_use: 0.1 };
    const rows = [
      { provider: 'x', model: 'mystery', tier: 'SIMPLE' }, // no cost
      { provider: 'openai', model: 'cheap', tier: 'SIMPLE', cost: 0.1 },
    ];
    const r = shortfall.selectByShortfall(req, rows, { tau: 0.24 });
    assert.strictEqual(r.selected.model, 'cheap');
  });

  it('cost tie breaks toward the lower covering tier (no over-provisioning)', () => {
    const req = { reasoning: 0.1, codegen: 0.1, debugging: 0.1, tool_use: 0.1 };
    const rows = [
      { provider: 'azure-openai', model: 'big', tier: 'REASONING', cost: Number.POSITIVE_INFINITY },
      { provider: 'openai', model: 'cheap', tier: 'SIMPLE', cost: Number.POSITIVE_INFINITY },
    ];
    const r = shortfall.selectByShortfall(req, rows, { tau: 0.24 });
    assert.strictEqual(r.selected.model, 'cheap');
  });

  it('fails open (null) on malformed input', () => {
    assert.strictEqual(shortfall.selectByShortfall(null, cands), null);
    assert.strictEqual(shortfall.selectByShortfall({ reasoning: 0.5 }, []), null);
  });
});
