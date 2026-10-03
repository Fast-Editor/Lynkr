const test = require('node:test');
const assert = require('node:assert');

process.env.LYNKR_KNN_DIR = process.env.LYNKR_KNN_DIR || '/tmp/lynkr-test-knn';

const sf = require('../src/routing/shortfall');
const tlm = require('../src/routing/telemetry');

const tierProfiles = {
  SIMPLE: { reasoning: 0.2, codegen: 0.3, debugging: 0.2, tool_use: 0.3 },
  MEDIUM: { reasoning: 0.45, codegen: 0.55, debugging: 0.45, tool_use: 0.55 },
  COMPLEX: { reasoning: 0.7, codegen: 0.75, debugging: 0.7, tool_use: 0.7 },
  REASONING: { reasoning: 0.9, codegen: 0.9, debugging: 0.9, tool_use: 0.9 },
};
const flat = { reasoning: 0.15, codegen: 0.15, debugging: 0.15, tool_use: 0.1 };

test('anchorRequirement interpolates between tier profiles', () => {
  assert.deepStrictEqual(sf.anchorRequirement(10, tierProfiles), tierProfiles.SIMPLE);
  assert.deepStrictEqual(sf.anchorRequirement(88, tierProfiles), tierProfiles.REASONING);
  const mid = sf.anchorRequirement(49, tierProfiles); // halfway MEDIUM(35)→COMPLEX(63)
  assert.ok(Math.abs(mid.reasoning - 0.575) < 1e-9);
  assert.strictEqual(sf.anchorRequirement(null, tierProfiles), null);
  assert.strictEqual(sf.anchorRequirement('x', tierProfiles), null);
});

test('jevRequirement is the probability-weighted tier profile', () => {
  const v = sf.jevRequirement({ probabilities: { MEDIUM: 0.5, COMPLEX: 0.5 } }, tierProfiles);
  assert.ok(Math.abs(v.reasoning - 0.575) < 1e-9);
  // tier+confidence form (no probabilities) is accepted
  const w = sf.jevRequirement({ tier: 'COMPLEX', confidence: 0.8 }, tierProfiles);
  assert.deepStrictEqual(w, tierProfiles.COMPLEX);
  assert.strictEqual(sf.jevRequirement(null, tierProfiles), null);
  assert.strictEqual(sf.jevRequirement({ probabilities: { NOPE: 1 } }, tierProfiles), null);
});

test('liftRequirement takes the per-head max and never lowers', () => {
  const { req, lift } = sf.liftRequirement(flat, { anchorScore: 63, jev: { probabilities: { COMPLEX: 1 } } }, tierProfiles);
  assert.deepStrictEqual(req, tierProfiles.COMPLEX);
  assert.ok(lift.applied.includes('anchor'));
  // a structural head above the semantic level is kept
  const high = { ...flat, tool_use: 0.95 };
  const r2 = sf.liftRequirement(high, { anchorScore: 63 }, tierProfiles).req;
  assert.strictEqual(r2.tool_use, 0.95);
  // no signals → unchanged
  const r3 = sf.liftRequirement(flat, {}, tierProfiles);
  assert.deepStrictEqual(r3.req, flat);
  assert.deepStrictEqual(r3.lift.applied, []);
});

test('liftRequirement makes the cheapest model stop covering a semantically hard ask', () => {
  const candidates = [
    { provider: 'p', model: 'cheap', tier: 'MEDIUM', cost: 1 },
    { provider: 'p', model: 'strong', tier: 'COMPLEX', cost: 10 },
  ];
  sf._setProfilesForTests({ tierProfiles, modelOverrides: {}, tau: 0.24 });
  const before = sf.selectByShortfall(flat, candidates);
  assert.strictEqual(before.selected.model, 'cheap');
  // A confident REASONING-grade verdict lifts the requirement to 0.9: the
  // MEDIUM-profiled cheap model now falls 0.35–0.45 short on every head
  // (> tau 0.24) while the COMPLEX-profiled strong model is within tau.
  const { req } = sf.liftRequirement(flat, { jev: { probabilities: { REASONING: 1 } } }, tierProfiles);
  const after = sf.selectByShortfall(req, candidates);
  assert.strictEqual(after.selected.model, 'strong');
  sf._resetProfilesCache();
});

test('telemetry.jevFields reads the window-path _jev verdict', () => {
  const j = { tier: 'COMPLEX', confidence: 0.84, probabilities: { COMPLEX: 0.88, MEDIUM: 0.12 }, model: 'jev-1.13.0', criteriaHash: 'abc' };
  const f = tlm.jevFields({ _jev: j });
  assert.strictEqual(f.jev_verdict, 'COMPLEX');
  assert.strictEqual(f.jev_confidence, 0.84);
  assert.strictEqual(f.jev_model, 'jev-1.13.0');
  assert.strictEqual(tlm.jevFields({}).jev_verdict, null);
});
