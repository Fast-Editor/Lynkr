const assert = require('assert');
const os = require('os');
const path = require('path');
const { describe, it, beforeEach } = require('node:test');

require('../src/routing/telemetry')._setDbPathForTests(
  path.join(os.tmpdir(), `lynkr-telemetry-jev-${process.pid}.db`)
);

const jev = require('../src/routing/jev-router');
const telemetry = require('../src/routing/telemetry');
const { scoreIntent, buildCentroids } = require('../src/routing/intent-score');

// --- fixtures (mirrors test/intent-score.test.js style) --------------------
const FIXTURES = {
  'hi': [1, 0.05, 0.02, 0, 0],
  'give me a plan to refactor this code': [0.05, 0.95, 0.28, 0.03, 0.08],
  'design a horizontally scalable architecture': [0.02, 0.25, 1, 0, 0.15],
  'prove this lock-free queue is correct': [0.01, 0.15, 0.35, 0, 1],
};
const fakeEmbed = async (text) => FIXTURES[(text || '').toLowerCase().trim()] || null;
const ANCHORS = {
  trivial: ['hi'],
  substantive: ['give me a plan to refactor this code'],
  heavyweight: ['design a horizontally scalable architecture'],
  frontier: ['prove this lock-free queue is correct'],
};
let n = 0;
const jevFetch = (tier, confidence, risky = 0.1) => async () => {
  n++;
  return {
    ok: true,
    json: async () => ({
      model: 'jev-1.13.0',
      answers: {
        tier: { type: 'choice', choice: tier, probabilities: { [tier]: 0.97 }, confidence },
        risky: { type: 'noul', noul: risky },
      },
    }),
  };
};

describe('jevFloorTarget', () => {
  it('holds at the stronger of legacy pick and Jev verdict', () => {
    assert.strictEqual(
      jev.jevFloorTarget({ selectedTier: 'SIMPLE', legacyTier: 'MEDIUM', jevTier: 'COMPLEX', jevConfidence: 0.97 }),
      'COMPLEX'
    );
    assert.strictEqual(
      jev.jevFloorTarget({ selectedTier: 'SIMPLE', legacyTier: 'REASONING', jevTier: 'MEDIUM', jevConfidence: 0.9 }),
      'REASONING'
    );
  });

  it('no floor when selected already covers, confidence low, or tiers unknown', () => {
    assert.strictEqual(jev.jevFloorTarget({ selectedTier: 'COMPLEX', legacyTier: 'MEDIUM', jevTier: 'COMPLEX', jevConfidence: 0.97 }), null);
    assert.strictEqual(jev.jevFloorTarget({ selectedTier: 'SIMPLE', legacyTier: 'MEDIUM', jevTier: 'COMPLEX', jevConfidence: 0.5 }), null);
    assert.strictEqual(jev.jevFloorTarget({ selectedTier: 'SIMPLE', legacyTier: 'MEDIUM', jevTier: 'GALAXY', jevConfidence: 0.99 }), null);
    assert.strictEqual(jev.jevFloorTarget({}), null);
  });
});

describe('jevRiskLift', () => {
  it('lifts one band on high risk, SIMPLE and MEDIUM only', () => {
    assert.strictEqual(jev.jevRiskLift({ tier: 'SIMPLE', risky: 0.9 }), 'MEDIUM');
    assert.strictEqual(jev.jevRiskLift({ tier: 'MEDIUM', risky: 0.9 }), 'COMPLEX');
    assert.strictEqual(jev.jevRiskLift({ tier: 'COMPLEX', risky: 0.99 }), null);
  });

  it('never clears keyword risk, never fires low', () => {
    assert.strictEqual(jev.jevRiskLift({ tier: 'SIMPLE', risky: 0.9, riskLevel: 'high' }), null);
    assert.strictEqual(jev.jevRiskLift({ tier: 'SIMPLE', risky: 0.3 }), null);
    assert.strictEqual(jev.jevRiskLift({ tier: 'SIMPLE', risky: null }), null);
  });
});

describe('jevTierOverride', () => {
  it('overrides either direction at confidence, with midpoint score', () => {
    assert.deepStrictEqual(
      jev.jevTierOverride({ baseTier: 'SIMPLE', jevTier: 'COMPLEX', jevConfidence: 0.97 }),
      { tier: 'COMPLEX', score: 63 }
    );
    assert.deepStrictEqual(
      jev.jevTierOverride({ baseTier: 'COMPLEX', jevTier: 'SIMPLE', jevConfidence: 0.95 }),
      { tier: 'SIMPLE', score: 10 }
    );
  });

  it('abstains on agreement, low confidence, or unknown tiers', () => {
    assert.strictEqual(jev.jevTierOverride({ baseTier: 'MEDIUM', jevTier: 'MEDIUM', jevConfidence: 0.99 }), null);
    assert.strictEqual(jev.jevTierOverride({ baseTier: 'SIMPLE', jevTier: 'COMPLEX', jevConfidence: 0.5 }), null);
    assert.strictEqual(jev.jevTierOverride({ baseTier: 'SIMPLE', jevTier: 'GALAXY', jevConfidence: 0.99 }), null);
    assert.strictEqual(jev.jevTierOverride({}), null);
  });
});

describe('telemetry.jevFields', () => {
  it('maps decision.jev and analysis.jev shapes, null-safe otherwise', () => {
    const full = telemetry.jevFields({ jev: { tier: 'COMPLEX', confidence: 0.97, probabilities: { COMPLEX: 1 }, model: 'jev-1.13.0', criteriaHash: 'abc123' } });
    assert.strictEqual(full.jev_verdict, 'COMPLEX');
    assert.strictEqual(full.jev_confidence, 0.97);
    assert.strictEqual(full.criteria_hash, 'abc123');
    const nested = telemetry.jevFields({ analysis: { jev: { tier: 'SIMPLE', confidence: 1 } } });
    assert.strictEqual(nested.jev_verdict, 'SIMPLE');
    const empty = telemetry.jevFields({ tier: 'SIMPLE' });
    assert.strictEqual(empty.jev_verdict, null);
    assert.strictEqual(telemetry.jevFields(null).jev_model, null);
  });

  it('record() persists jev columns', () => {
    telemetry.record({
      request_id: 'jev-test-' + Date.now(), provider: 'test', model: 'm',
      routing_method: 'test', tier: 'MEDIUM',
      jev_verdict: 'COMPLEX', jev_confidence: 0.97,
      jev_probabilities: { COMPLEX: 0.97 }, jev_model: 'jev-1.13.0', criteria_hash: 'abc123',
    });
  });
});

describe('scoreIntent with Jev second opinion', () => {
  beforeEach(() => jev._clearCache());

  it('Jev verdict flows into classifierTier + jev extras', async () => {
    const centroids = await buildCentroids(ANCHORS, fakeEmbed);
    const r = await scoreIntent(
      { messages: [{ role: 'user', content: 'give me a plan to refactor this code' }] },
      { centroids, embedFn: fakeEmbed, jevFetchFn: jevFetch('COMPLEX', 0.97) }
    );
    assert.strictEqual(r.classifierTier, 'COMPLEX');
    assert.strictEqual(r.classifierConfidence, 0.97);
    assert.strictEqual(r.jev.tier, 'COMPLEX');
    assert.strictEqual(r.jev.model, 'jev-1.13.0');
    assert.strictEqual(r.jev.criteriaHash, jev.CRITERIA_HASH);
    assert.strictEqual(n >= 1, true);
  });

  it('high-confidence Jev COMPLEX on SIMPLE anchor caps one band up (existing guardrail)', async () => {
    const centroids = await buildCentroids(ANCHORS, fakeEmbed);
    const r = await scoreIntent(
      { messages: [{ role: 'user', content: 'hi' }] },
      { centroids, embedFn: fakeEmbed, jevFetchFn: jevFetch('COMPLEX', 0.97) }
    );
    // anchor SIMPLE(10) + Jev COMPLEX@0.97 → up_capped MEDIUM midpoint, not a catapult
    assert.strictEqual(r.score, 35);
    assert.strictEqual(r.jev.tier, 'COMPLEX');
  });

  it('Jev failure degrades to anchor-only (fail-soft)', async () => {
    const centroids = await buildCentroids(ANCHORS, fakeEmbed);
    const failing = async () => { throw new Error('down'); };
    const r = await scoreIntent(
      { messages: [{ role: 'user', content: 'give me a plan to refactor this code' }] },
      { centroids, embedFn: fakeEmbed, jevFetchFn: failing }
    );
    assert.strictEqual(r.jev, null);
    assert.strictEqual(r.classifierTier, null);
    assert.ok(Number.isFinite(r.score));
  });
});
