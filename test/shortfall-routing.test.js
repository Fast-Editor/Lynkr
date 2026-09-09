const assert = require('assert');
const { describe, it, beforeEach, afterEach } = require('node:test');

describe('shortfall routing integration', () => {
  let originalEnv;

  beforeEach(() => {
    for (const m of [
      '../src/config/index.js',
      '../src/clients/routing',
      '../src/routing/index.js',
      '../src/routing/model-tiers',
      '../src/routing/shortfall',
      '../src/routing/capabilities',
    ]) {
      try { delete require.cache[require.resolve(m)]; } catch { /* not loaded */ }
    }
    originalEnv = { ...process.env };
    process.env.FALLBACK_PROVIDER = 'databricks';
    process.env.DATABRICKS_API_KEY = 'test-key';
    process.env.DATABRICKS_API_BASE = 'http://test.com';
    process.env.TIER_SIMPLE = 'openai:cheap-small';
    process.env.TIER_MEDIUM = 'openai:mid-model';
    process.env.TIER_COMPLEX = 'azure-openai:big-model';
    process.env.TIER_REASONING = 'azure-openai:big-model';
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  // NOTE: force-path greetings ("hi") return before tier selection by design
  // (force-local dominates shortfall) — use non-force asks so both paths run.
  // NOTE 2: risk-high asks (auth/database/security) also return early via the
  // risk guard, which dominates shortfall by design — keep HARD risk-free.
  const TRIVIAL = 'Explain what a hash map is in one paragraph.';
  const HARD = 'Rewrite the entire data-visualization layer across a dozen files: redesign the chart architecture, untangle the tangled async rendering pipeline, then implement the new dashboard module with step-by-step tradeoffs analysis and write the integration tests.';

  it('shadow-computes without changing the legacy decision when disabled', async () => {
    const routing = require('../src/clients/routing');
    // Pin disabled via injection (hermetic — never depends on the operator's
    // local config file, which may have enabled:true).
    require('../src/routing/shortfall')._setProfilesForTests({ enabled: false });
    const result = await routing.determineProviderSmart({ messages: [{ role: 'user', content: TRIVIAL }] });
    assert.ok(result.provider, 'expected a provider');
    assert.ok(!String(result.method || '').includes('shortfall'), `method=${result.method}`);
    assert.ok(result.shortfall && typeof result.shortfall === 'object', 'expected shadow shortfall info');
    assert.ok(result.shortfall.req, 'expected requirement vector');
  });

  it('serves the shortfall pick with +shortfall method when enabled', async () => {
    const routing = require('../src/clients/routing');
    // Toggle via config injection (no env vars) — same instance routing uses.
    require('../src/routing/shortfall')._setProfilesForTests({ enabled: true });
    const result = await routing.determineProviderSmart({ messages: [{ role: 'user', content: TRIVIAL }] });
    assert.ok(result.shortfall && typeof result.shortfall === 'object');
    // Trivial ask: legacy SIMPLE (cheap-small) already covers → agree, no suffix.
    // A hard multi-file refactor ask should escalate to the big model with suffix.
    const hard = await routing.determineProviderSmart({
      messages: [{ role: 'user', content: HARD }],
    });
    assert.ok(hard.shortfall, 'expected shortfall info on hard request');
    // Wiring contract (direction-agnostic: tier profiles are hand-seeded until
    // calibrated on telemetry): when shortfall disagrees with legacy, the
    // served model must be the shortfall pick and the method must say so.
    if (hard.shortfall.agreed === false) {
      assert.ok(String(hard.method).includes('shortfall'), `method=${hard.method}`);
      assert.strictEqual(hard.model, hard.shortfall.selected.model);
    } else {
      assert.ok(!String(hard.method).includes('shortfall'), `method=${hard.method}`);
    }
  });

  it('resolves one family identically across providers (z.ai/Baidu/local)', async () => {
    // Same weights (glm-5.2) served three ways must route identically:
    // provider decides cost/invocation only, family decides capability.
    for (const simple of ['baidu:glm-5.2', 'zai:glm-5.2', 'ollama:glm-5.2']) {
      process.env.TIER_SIMPLE = simple;
      for (const m of [
        '../src/config/index.js',
        '../src/clients/routing',
        '../src/routing/index.js',
        '../src/routing/model-tiers',
        '../src/routing/shortfall',
        '../src/routing/capabilities',
      ]) {
        try { delete require.cache[require.resolve(m)]; } catch { /* not loaded */ }
      }
      const routing = require('../src/clients/routing');
      require('../src/routing/shortfall')._setProfilesForTests({ enabled: true });
      const result = await routing.determineProviderSmart({ messages: [{ role: 'user', content: TRIVIAL }] });
      assert.strictEqual(result.model, 'glm-5.2', `simple=${simple}`);
      assert.strictEqual(result.shortfall?.selected?.source, 'seed:shipped', `simple=${simple}`);
    }
  });
});
