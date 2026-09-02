/**
 * Off-policy evaluation estimators (ROUTING-NOTES §3 + §4.10.3).
 *
 * Synthetic ground-truth experiments: construct logged data from a known
 * behavior policy over arms with known true rewards, then verify each
 * estimator recovers the true value of a target policy. The doubly-robust
 * property itself is tested directly: corrupt the logged propensities and
 * confirm DR (with a correct reward model) still recovers truth while IPS
 * does not.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.DATABRICKS_API_KEY = process.env.DATABRICKS_API_KEY || 'test-key';
process.env.DATABRICKS_API_BASE = process.env.DATABRICKS_API_BASE || 'http://test.com';
process.env.LOG_FILE_ENABLED = 'false';

const { evaluatePolicy, policies } = require('../src/routing/ope');

// Two arms with known true rewards (quality points, 0-100 scale in logs).
const ARM_A = { provider: 'ollama', model: 'qwen' };       // true reward 80
const ARM_B = { provider: 'azure', model: 'gpt-4o' };      // true reward 40
const TRUE_REWARD = { 'ollama:qwen': 80, 'azure:gpt-4o': 40 };
const CANDIDATES = [ARM_A, ARM_B];
const CTX = [0.5, 0.2, 1, 0, 0, 1, 1, 0, 0, 0, 0, 0];

/**
 * Deterministic logged dataset: the behavior policy served A on exactly
 * pA-fraction of rows and B on the rest, propensities logged accordingly,
 * rewards exactly at the true means (noise-free so estimates are exact).
 */
function makeLogs({ n, pA, loggedPropensityA = pA, withContext = true }) {
  const rows = [];
  const nA = Math.round(n * pA);
  for (let i = 0; i < n; i++) {
    const servedA = i < nA;
    const served = servedA ? ARM_A : ARM_B;
    rows.push({
      tier: 'MEDIUM',
      provider: served.provider,
      model: served.model,
      quality_score: TRUE_REWARD[`${served.provider}:${served.model}`],
      propensity: servedA ? loggedPropensityA : 1 - loggedPropensityA,
      candidates: JSON.stringify(CANDIDATES),
      context: withContext ? JSON.stringify(CTX) : null,
    });
  }
  return rows;
}

/** A reward model that knows the truth exactly (context-independent). */
const perfectBandit = {
  estimateReward: (tier, provider, model) =>
    (TRUE_REWARD[`${provider}:${model}`] ?? null) === null
      ? null
      : TRUE_REWARD[`${provider}:${model}`] / 100,
};

/** A reward model that knows nothing. */
const ignorantBandit = { estimateReward: () => null };

const alwaysA = ({ candidates }) => {
  const probs = new Map();
  candidates.forEach((c) => probs.set(`${c.provider}:${c.model}`, c.model === ARM_A.model ? 1 : 0));
  return { probs };
};

test('IPS/SNIPS recover the target policy value from correctly-logged propensities', () => {
  const rows = makeLogs({ n: 1000, pA: 0.7 });
  const r = evaluatePolicy(rows, alwaysA, { bandit: ignorantBandit });
  // True value of always-A = 0.8. Deterministic construction → exact.
  assert.ok(Math.abs(r.ips - 0.8) < 1e-9, `IPS ${r.ips} != 0.8`);
  assert.ok(Math.abs(r.snips - 0.8) < 1e-9, `SNIPS ${r.snips} != 0.8`);
  assert.equal(r.usable, 1000);
  // Logged policy served a 0.7/0.3 mix → logged mean = 0.7·0.8 + 0.3·0.4 = 0.68.
  assert.ok(Math.abs(r.loggedMeanReward - 0.68) < 1e-9);
});

test('DR and WDR agree with IPS when both propensities and model are correct', () => {
  const rows = makeLogs({ n: 1000, pA: 0.7 });
  const r = evaluatePolicy(rows, alwaysA, { bandit: perfectBandit });
  assert.ok(Math.abs(r.dr - 0.8) < 1e-9, `DR ${r.dr} != 0.8`);
  assert.ok(Math.abs(r.wdr - 0.8) < 1e-9, `WDR ${r.wdr} != 0.8`);
  assert.equal(r.drRows, 1000);
});

test('THE doubly-robust property: corrupted propensities bias IPS but not DR', () => {
  // Behavior policy truly served A 70% of the time, but the logs LIE and say
  // propensity was 0.5 for every A row (and 0.5 for B).
  const rows = makeLogs({ n: 1000, pA: 0.7, loggedPropensityA: 0.5 });

  const biased = evaluatePolicy(rows, alwaysA, { bandit: ignorantBandit });
  // IPS with wrong propensities: 0.7n rows · (1/0.5)·0.8 / n = 1.12 ≠ 0.8.
  assert.ok(Math.abs(biased.ips - 1.12) < 1e-9, `expected biased IPS 1.12, got ${biased.ips}`);

  const robust = evaluatePolicy(rows, alwaysA, { bandit: perfectBandit });
  // With a correct r̂, the residual (r − r̂) is 0 on every row, so the
  // corrupted weights multiply zero: DR = Σ π·r̂ = 0.8 exactly.
  assert.ok(Math.abs(robust.dr - 0.8) < 1e-9, `DR ${robust.dr} != 0.8 under corrupted propensities`);
  assert.ok(Math.abs(robust.wdr - 0.8) < 1e-9, `WDR ${robust.wdr} != 0.8 under corrupted propensities`);
});

test('rows without context fall back to the IPS term inside DR (no crash, coverage reported)', () => {
  const rows = makeLogs({ n: 500, pA: 0.7, withContext: false });
  const r = evaluatePolicy(rows, alwaysA, { bandit: perfectBandit });
  assert.equal(r.drRows, 0, 'no context → no DR regression coverage');
  assert.ok(Math.abs(r.dr - 0.8) < 1e-9, 'DR degenerates to IPS and still recovers truth');
});

test('unusable rows (missing propensity/quality/candidates) are skipped, not fatal', () => {
  const rows = [
    ...makeLogs({ n: 100, pA: 0.7 }),
    { provider: 'x', model: 'y' },                                // no propensity/quality
    { propensity: 0.5, quality_score: 50, candidates: 'not-json' }, // bad JSON
    null,
  ];
  const r = evaluatePolicy(rows, alwaysA, { bandit: ignorantBandit });
  assert.equal(r.usable, 100);
  assert.equal(r.n, 103);
});

test('effective sample size equals usable rows when weights are uniform', () => {
  // Uniform target over 2 candidates: w = 0.5/p, and with pA=0.5 every row
  // has identical weight → ESS = usable.
  const rows = makeLogs({ n: 400, pA: 0.5 });
  const r = evaluatePolicy(rows, policies.uniform, { bandit: ignorantBandit });
  assert.ok(Math.abs(r.effectiveSampleSize - 400) < 1e-6, `ESS ${r.effectiveSampleSize} != 400`);
});

test('propensity floor bounds a single row\'s importance weight', () => {
  const rows = [{
    tier: 'MEDIUM',
    provider: ARM_A.provider,
    model: ARM_A.model,
    quality_score: 80,
    propensity: 1e-9, // absurd logged propensity
    candidates: JSON.stringify(CANDIDATES),
    context: JSON.stringify(CTX),
  }];
  const r = evaluatePolicy(rows, alwaysA, { bandit: ignorantBandit });
  // Weight is clamped to 1/PROPENSITY_FLOOR = 1000, not 1e9.
  assert.ok(r.ips <= 0.8 * 1000 + 1e-9, `weight not floored: IPS ${r.ips}`);
});

test('reference policies produce valid distributions over the candidate set', () => {
  for (const [name, fn] of Object.entries(policies)) {
    const { probs } = fn({ tier: 'MEDIUM', context: CTX, candidates: CANDIDATES });
    let sum = 0;
    for (const c of CANDIDATES) sum += probs.get(`${c.provider}:${c.model}`) ?? 0;
    assert.ok(Math.abs(sum - 1) < 1e-9, `${name} probabilities sum to ${sum}, not 1`);
  }
});
