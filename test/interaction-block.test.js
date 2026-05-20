const assert = require('assert');
const { describe, it } = require('node:test');

const {
  buildInteractionBlock,
  estimateSavingsPercent,
  modeFor,
  routeLabel,
} = require('../src/routing/interaction');

describe('estimateSavingsPercent', () => {
  it('SIMPLE local maxes at 100', () => {
    assert.strictEqual(estimateSavingsPercent('SIMPLE', 'ollama'), 100);
  });

  it('SIMPLE cloud is 70', () => {
    assert.strictEqual(estimateSavingsPercent('SIMPLE', 'databricks'), 70);
  });

  it('MEDIUM cloud is 45', () => {
    assert.strictEqual(estimateSavingsPercent('MEDIUM', 'databricks'), 45);
  });

  it('COMPLEX is 10', () => {
    assert.strictEqual(estimateSavingsPercent('COMPLEX', 'databricks'), 10);
  });

  it('REASONING is 0', () => {
    assert.strictEqual(estimateSavingsPercent('REASONING', 'databricks'), 0);
  });

  it('returns 0 for missing tier', () => {
    assert.strictEqual(estimateSavingsPercent(null, 'ollama'), 0);
  });
});

describe('modeFor', () => {
  it('identifies risk-forced routing', () => {
    assert.strictEqual(modeFor({ method: 'risk' }), 'risk_forced_tier');
  });

  it('identifies agentic routing', () => {
    assert.strictEqual(modeFor({ method: 'agentic' }), 'agentic_workflow');
  });

  it('identifies force_local pattern', () => {
    assert.strictEqual(
      modeFor({ method: 'force', reason: 'force_local_pattern' }),
      'force_local'
    );
  });

  it('falls back to tier_routed', () => {
    assert.strictEqual(modeFor({ method: 'tier_config' }), 'tier_routed');
  });
});

describe('routeLabel', () => {
  it('formats a complete decision', () => {
    const label = routeLabel({
      tier: 'COMPLEX',
      provider: 'databricks',
      model: 'claude-opus-4-7',
      risk: { level: 'high' },
      score: 78,
    });
    assert.match(label, /\[Lynkr\]/);
    assert.match(label, /tier=COMPLEX/);
    assert.match(label, /provider=databricks/);
    assert.match(label, /risk=high/);
    assert.match(label, /score=78/);
  });

  it('omits missing fields', () => {
    const label = routeLabel({ provider: 'ollama' });
    assert.strictEqual(label, '[Lynkr] provider=ollama');
  });
});

describe('buildInteractionBlock', () => {
  it('returns null on missing decision', () => {
    assert.strictEqual(buildInteractionBlock(null), null);
    assert.strictEqual(buildInteractionBlock(undefined), null);
  });

  it('produces a complete block for a high-risk decision', () => {
    const block = buildInteractionBlock({
      provider: 'databricks',
      tier: 'COMPLEX',
      model: 'claude-opus-4-7',
      method: 'risk',
      reason: 'high_risk_forced_tier',
      score: 78,
      risk: { level: 'high', pathHits: ['auth'], instructionHits: ['authentication'] },
    });
    assert.strictEqual(block.tool, 'lynkr.route');
    assert.strictEqual(block.mode, 'risk_forced_tier');
    assert.strictEqual(block.tier, 'COMPLEX');
    assert.strictEqual(block.risk, 'high');
    assert.ok(block.risk_hits.includes('auth'));
    assert.ok(block.risk_hits.includes('authentication'));
    assert.strictEqual(block.estimated_savings_percent, 10);
    assert.match(block.headline, /protected domain/);
  });

  it('produces a block for a SIMPLE local decision', () => {
    const block = buildInteractionBlock({
      provider: 'ollama',
      tier: 'SIMPLE',
      method: 'tier_config',
      reason: 'low complexity',
      score: 5,
      risk: { level: 'low' },
    });
    assert.strictEqual(block.tier, 'SIMPLE');
    assert.strictEqual(block.provider, 'ollama');
    assert.strictEqual(block.estimated_savings_percent, 100);
  });

  it('dedupes risk_hits across path + instruction lists', () => {
    const block = buildInteractionBlock({
      provider: 'databricks',
      tier: 'COMPLEX',
      method: 'risk',
      risk: {
        level: 'high',
        pathHits: ['billing', 'payment'],
        instructionHits: ['billing', 'payment'],
      },
    });
    // 'billing' and 'payment' must each appear exactly once.
    assert.strictEqual(block.risk_hits.filter(h => h === 'billing').length, 1);
    assert.strictEqual(block.risk_hits.filter(h => h === 'payment').length, 1);
  });
});
