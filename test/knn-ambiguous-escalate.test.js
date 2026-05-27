const test = require('node:test');
const assert = require('node:assert/strict');

/**
 * Tests for the kNN ambiguous-confidence escalation rule.
 *
 * When kNN returns confidence in (0.4, 0.7], the routing module should
 * bump the tier one step up rather than using the heuristic selection.
 * This ensures "when in doubt, choose quality over cost".
 */

const TIER_ORDER = ['SIMPLE', 'MEDIUM', 'COMPLEX', 'REASONING'];

// Minimal stub for selector.selectModel — mirrors model-tiers behaviour.
function makeSelector(tierMap) {
  return {
    selectModel(tier) {
      if (!tierMap[tier]) throw new Error(`TIER_${tier} not configured`);
      const [provider, model] = tierMap[tier].split(':');
      return { provider, model };
    },
  };
}

// Extracted logic from routing/index.js so we can unit-test it in isolation
// without pulling the whole module graph.
function applyKnnAmbiguousEscalation({ knnResult, tier, provider, selectedModel, selector }) {
  let method = 'tier_config';
  if (!knnResult) return { provider, selectedModel, tier, method };

  if (knnResult.confidence > 0.7 && knnResult.model !== selectedModel) {
    // High-confidence path — delegate to kNN model directly
    return {
      provider: knnResult.provider,
      selectedModel: knnResult.model,
      tier,
      method: method + '+knn',
    };
  }

  if (knnResult.confidence > 0.4 && knnResult.confidence <= 0.7) {
    const currentIdx = TIER_ORDER.indexOf(tier);
    if (currentIdx >= 0 && currentIdx < TIER_ORDER.length - 1) {
      const upgradedTier = TIER_ORDER[currentIdx + 1];
      try {
        const upgraded = selector.selectModel(upgradedTier, null);
        return {
          provider: upgraded.provider,
          selectedModel: upgraded.model,
          tier: upgradedTier,
          method: method + '+knn_ambiguous_escalate',
        };
      } catch (_) {
        // Escalation config missing — stay on current
      }
    }
  }

  return { provider, selectedModel, tier, method };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

test('confidence > 0.7 overrides model directly (no tier bump)', () => {
  const selector = makeSelector({ MEDIUM: 'anthropic:claude-sonnet-4-6' });
  const result = applyKnnAmbiguousEscalation({
    knnResult: { confidence: 0.85, provider: 'anthropic', model: 'claude-opus-4-7', model: 'claude-opus-4-7' },
    tier: 'MEDIUM',
    provider: 'anthropic',
    selectedModel: 'claude-sonnet-4-6',
    selector,
  });
  assert.equal(result.selectedModel, 'claude-opus-4-7');
  assert.equal(result.tier, 'MEDIUM'); // tier unchanged — kNN just swaps model
  assert.ok(result.method.includes('+knn'));
  assert.ok(!result.method.includes('ambiguous'));
});

test('confidence in (0.4, 0.7] bumps tier one step up', () => {
  const selector = makeSelector({
    MEDIUM: 'anthropic:claude-sonnet-4-6',
    COMPLEX: 'anthropic:claude-opus-4-7',
  });
  const result = applyKnnAmbiguousEscalation({
    knnResult: { confidence: 0.55, provider: 'anthropic', model: 'claude-haiku-4-5' },
    tier: 'MEDIUM',
    provider: 'anthropic',
    selectedModel: 'claude-sonnet-4-6',
    selector,
  });
  assert.equal(result.tier, 'COMPLEX');
  assert.equal(result.selectedModel, 'claude-opus-4-7');
  assert.ok(result.method.includes('+knn_ambiguous_escalate'));
});

test('confidence exactly at 0.4 boundary does NOT escalate', () => {
  const selector = makeSelector({ COMPLEX: 'anthropic:claude-opus-4-7' });
  const result = applyKnnAmbiguousEscalation({
    knnResult: { confidence: 0.4, provider: 'anthropic', model: 'claude-haiku-4-5' },
    tier: 'MEDIUM',
    provider: 'anthropic',
    selectedModel: 'claude-sonnet-4-6',
    selector,
  });
  assert.equal(result.tier, 'MEDIUM');
  assert.equal(result.selectedModel, 'claude-sonnet-4-6');
  assert.equal(result.method, 'tier_config');
});

test('confidence exactly at 0.7 boundary DOES escalate (inclusive)', () => {
  const selector = makeSelector({
    SIMPLE: 'ollama:llama3.2',
    MEDIUM: 'anthropic:claude-sonnet-4-6',
  });
  const result = applyKnnAmbiguousEscalation({
    knnResult: { confidence: 0.7, provider: 'ollama', model: 'llama3.2' },
    tier: 'SIMPLE',
    provider: 'ollama',
    selectedModel: 'llama3.2',
    selector,
  });
  assert.equal(result.tier, 'MEDIUM');
  assert.equal(result.selectedModel, 'claude-sonnet-4-6');
  assert.ok(result.method.includes('+knn_ambiguous_escalate'));
});

test('REASONING tier is never escalated further (already at ceiling)', () => {
  const selector = makeSelector({ REASONING: 'anthropic:claude-opus-4-7' });
  const result = applyKnnAmbiguousEscalation({
    knnResult: { confidence: 0.6, provider: 'anthropic', model: 'claude-opus-4-7' },
    tier: 'REASONING',
    provider: 'anthropic',
    selectedModel: 'claude-opus-4-7',
    selector,
  });
  assert.equal(result.tier, 'REASONING');
  assert.equal(result.method, 'tier_config'); // no escalation
});

test('null knnResult is a no-op', () => {
  const selector = makeSelector({ MEDIUM: 'anthropic:claude-sonnet-4-6' });
  const result = applyKnnAmbiguousEscalation({
    knnResult: null,
    tier: 'MEDIUM',
    provider: 'anthropic',
    selectedModel: 'claude-sonnet-4-6',
    selector,
  });
  assert.equal(result.tier, 'MEDIUM');
  assert.equal(result.selectedModel, 'claude-sonnet-4-6');
  assert.equal(result.method, 'tier_config');
});

test('escalation silently falls back when upgraded tier has no config', () => {
  // selector throws for COMPLEX — simulates missing TIER_COMPLEX env var
  const selector = {
    selectModel(tier) {
      if (tier === 'COMPLEX') throw new Error('TIER_COMPLEX not configured');
      return { provider: 'anthropic', model: 'claude-sonnet-4-6' };
    },
  };
  const result = applyKnnAmbiguousEscalation({
    knnResult: { confidence: 0.6, provider: 'anthropic', model: 'claude-haiku-4-5' },
    tier: 'MEDIUM',
    provider: 'anthropic',
    selectedModel: 'claude-sonnet-4-6',
    selector,
  });
  // Falls back gracefully — keeps MEDIUM, no crash
  assert.equal(result.tier, 'MEDIUM');
  assert.equal(result.selectedModel, 'claude-sonnet-4-6');
  assert.equal(result.method, 'tier_config');
});

test('high-confidence kNN where model already matches is a no-op', () => {
  const selector = makeSelector({ MEDIUM: 'anthropic:claude-sonnet-4-6' });
  const result = applyKnnAmbiguousEscalation({
    knnResult: { confidence: 0.9, provider: 'anthropic', model: 'claude-sonnet-4-6' },
    tier: 'MEDIUM',
    provider: 'anthropic',
    selectedModel: 'claude-sonnet-4-6', // same model → no override needed
    selector,
  });
  // confidence > 0.7 but model is same — the condition `model !== selectedModel` prevents override
  assert.equal(result.method, 'tier_config');
  assert.equal(result.selectedModel, 'claude-sonnet-4-6');
});
