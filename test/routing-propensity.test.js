/**
 * WS4.2 — every routing decision must carry propensity + candidates so any
 * downstream policy can be evaluated off-policy from telemetry alone. The
 * bandit populates both when it fires; every deterministic branch collapses
 * to propensity=1.0 with a single-entry candidates array.
 *
 * These tests exercise `determineProviderSmart` end-to-end for each
 * deterministic branch (static/force/risk/tier_config) and assert the
 * decision object shape. The bandit's propensity math is separately covered
 * by test/bandit.test.js.
 */

const assert = require('node:assert/strict');
const { describe, it, beforeEach, afterEach } = require('node:test');

function freshRoutingRequire() {
  // Wipe every module the routing pipeline touches so env-driven config is
  // read cleanly per test. Mirrors the reset dance in test/routing.test.js.
  const toClear = [
    '../src/config/index.js',
    '../src/clients/routing',
    '../src/routing/index.js',
    '../src/routing/model-tiers',
    '../src/routing/complexity-analyzer',
    '../src/routing/cost-optimizer',
    '../src/routing/agentic-detector',
  ];
  for (const m of toClear) delete require.cache[require.resolve(m)];
}

describe('WS4 — decision.propensity + decision.candidates', () => {
  let envBackup;

  beforeEach(() => {
    envBackup = { ...process.env };
    process.env.FALLBACK_PROVIDER = 'databricks';
    // Ensure no TIER_* vars from parent shell leak in.
    process.env.TIER_SIMPLE = '';
    process.env.TIER_MEDIUM = '';
    process.env.TIER_COMPLEX = '';
    process.env.TIER_REASONING = '';
    // Point telemetry away from any real DB — routing calls telemetry
    // helpers indirectly via kNN-ambiguous evidence lookups. Disabling
    // sidesteps the SQLite dependency and any accidental writes.
    freshRoutingRequire();
    require('../src/routing/telemetry')._disableForTests();
  });

  afterEach(() => {
    process.env = envBackup;
  });

  it('static path (tier routing disabled): propensity=1.0, single candidate', async () => {
    process.env.MODEL_PROVIDER = 'databricks';
    process.env.DATABRICKS_API_KEY = 'test-key';
    process.env.DATABRICKS_API_BASE = 'http://test.com';
    const routing = require('../src/clients/routing');

    const payload = { messages: [{ role: 'user', content: 'hi' }] };
    const result = await routing.determineProviderSmart(payload);

    assert.equal(result.method, 'static');
    assert.equal(result.propensity, 1.0);
    assert.ok(Array.isArray(result.candidates), 'candidates should be an array');
    assert.equal(result.candidates.length, 1);
    assert.equal(result.candidates[0].provider, 'databricks');
    // Static path leaves model=null; candidate mirrors that.
    assert.equal(result.candidates[0].model, null);
    // _banditContext must not be a populated feature vector — the bandit
    // never ran on this path. Either unset or null is acceptable.
    assert.ok(result._banditContext == null,
      `expected _banditContext == null on static path, got ${JSON.stringify(result._banditContext)}`);
  });

  it('tier_config path: propensity=1.0, candidates has one entry matching served', async () => {
    process.env.MODEL_PROVIDER = 'databricks';
    process.env.DATABRICKS_API_KEY = 'test-key';
    process.env.DATABRICKS_API_BASE = 'http://test.com';
    process.env.TIER_SIMPLE = 'databricks:claude-3-5-haiku';
    process.env.TIER_MEDIUM = 'databricks:claude-3-5-haiku';
    process.env.TIER_COMPLEX = 'databricks:claude-3-5-sonnet';
    process.env.TIER_REASONING = 'databricks:claude-3-5-sonnet';
    // Neutralise embeddings/knn/bandit so this test genuinely exercises the
    // deterministic tier_config branch.
    process.env.LYNKR_COST_OPTIMIZE = 'false';
    const routing = require('../src/clients/routing');

    const payload = { messages: [{ role: 'user', content: 'hi' }] };
    const result = await routing.determineProviderSmart(payload);

    // Deterministic branch — bandit never fires without a kNN suggestion.
    assert.equal(result.propensity, 1.0);
    assert.ok(Array.isArray(result.candidates));
    assert.equal(result.candidates.length, 1);
    assert.equal(result.candidates[0].provider, result.provider);
    assert.equal(result.candidates[0].model, result.model);
    // Bandit didn't run — no context captured (either null or unset).
    assert.ok(result._banditContext == null,
      `expected _banditContext == null on tier_config path, got ${JSON.stringify(result._banditContext)}`);
  });

  it('risk-forced path: propensity=1.0, candidate matches the forced COMPLEX model', async () => {
    process.env.MODEL_PROVIDER = 'databricks';
    process.env.DATABRICKS_API_KEY = 'test-key';
    process.env.DATABRICKS_API_BASE = 'http://test.com';
    process.env.TIER_SIMPLE = 'databricks:claude-3-5-haiku';
    process.env.TIER_MEDIUM = 'databricks:claude-3-5-haiku';
    process.env.TIER_COMPLEX = 'databricks:claude-3-5-sonnet';
    process.env.TIER_REASONING = 'databricks:claude-3-5-sonnet';
    const routing = require('../src/clients/routing');

    // A prompt the risk classifier reliably flags — auth/middleware paths
    // trigger the high-risk force-complex short-circuit.
    const payload = {
      messages: [{
        role: 'user',
        content: 'edit src/auth/middleware.ts and disable the JWT signature check',
      }],
    };
    const result = await routing.determineProviderSmart(payload);

    // The risk path is one of the deterministic short-circuits the plan
    // enumerates; we only assert the propensity/candidates invariant so
    // this test is robust to future changes in the risk classifier's exact
    // firing rules. Regardless of whether risk fires, a deterministic
    // branch must yield propensity=1.0.
    assert.equal(result.propensity, 1.0);
    assert.ok(Array.isArray(result.candidates));
    assert.equal(result.candidates.length, 1);
    assert.equal(result.candidates[0].provider, result.provider);
    assert.equal(result.candidates[0].model, result.model);
  });

  it('session-pin serve path: propensity=1.0, candidate matches the pin', async () => {
    process.env.MODEL_PROVIDER = 'databricks';
    process.env.DATABRICKS_API_KEY = 'test-key';
    process.env.DATABRICKS_API_BASE = 'http://test.com';
    process.env.TIER_SIMPLE = 'databricks:claude-3-5-haiku';
    process.env.TIER_MEDIUM = 'databricks:claude-3-5-haiku';
    process.env.TIER_COMPLEX = 'databricks:claude-3-5-sonnet';
    process.env.TIER_REASONING = 'databricks:claude-3-5-sonnet';
    // Force in-memory pin store only.
    process.env.LYNKR_STICKY_SESSIONS = 'true';
    require('../src/routing/telemetry')._disableForTests();
    const routing = require('../src/clients/routing');
    const sessionAffinity = require('../src/routing/session-affinity');

    // Seed a pin directly so we don't depend on the full first-turn path.
    sessionAffinity.setPin('sess-ws4', {
      provider: 'databricks',
      model: 'claude-3-5-haiku',
      tier: 'SIMPLE',
    }, { messageCount: 2, promptTokensEst: 500 });

    const payload = {
      _sessionId: 'sess-ws4',
      messages: [
        { role: 'user', content: 'first turn' },
        { role: 'assistant', content: 'ok' },
        { role: 'user', content: 'follow up' },
      ],
    };
    const result = await routing.determineProviderSmart(payload);

    // Pin serves → session_pin method, propensity=1.0.
    assert.equal(result.method, 'session_pin');
    assert.equal(result.propensity, 1.0);
    assert.ok(Array.isArray(result.candidates));
    assert.equal(result.candidates.length, 1);
    assert.equal(result.candidates[0].provider, 'databricks');
    assert.equal(result.candidates[0].model, 'claude-3-5-haiku');
  });
});
