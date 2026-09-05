/**
 * `lynkr opencode` — per-tier context windows in opencode's provider config.
 *
 * Contract:
 *   - each configured tier gets a model entry carrying ITS tier model's real
 *     window (honest per-model compaction budgets client-side)
 *   - "lynkr-auto" is floored at the MINIMUM across tiers (safe for whatever
 *     content routing picks)
 *   - unresolvable windows floor conservatively, never guess upward
 *   - merging preserves every existing key in the user's opencode.json
 *   - the virtual ids resolve to tier pins server-side (model-slots), so the
 *     window each entry advertises is the window that actually serves it
 */

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.DATABRICKS_API_KEY = process.env.DATABRICKS_API_KEY || 'test-key';
process.env.DATABRICKS_API_BASE = process.env.DATABRICKS_API_BASE || 'http://test.com';
process.env.LOG_FILE_ENABLED = 'false';

const { buildLynkrProvider, mergeOpencodeConfig, FALLBACK_WINDOW } = require('../bin/opencode-setup');
const { resolveTierForModelId, VIRTUAL_TIER_IDS, MODEL_SLOTS } = require('../src/routing/model-slots');

const SAMPLE = {
  tiers: {
    SIMPLE: { provider: 'ollama', model: 'qwen3', contextWindow: 128000 },
    COMPLEX: { provider: 'azure-openai', model: 'gpt-5.6-sol', contextWindow: 200000 },
    REASONING: { provider: 'databricks', model: 'databricks-claude-opus-4-6', contextWindow: 1000000 },
  },
  minWindow: 128000,
};

test('per-tier entries carry their own real windows; auto carries the minimum', () => {
  const p = buildLynkrProvider(SAMPLE, { baseURL: 'http://localhost:8081', apiKey: 'k' });
  assert.equal(p.models['lynkr-auto'].limit.context, 128000);
  assert.equal(p.models['lynkr-simple'].limit.context, 128000);
  assert.equal(p.models['lynkr-complex'].limit.context, 200000);
  assert.equal(p.models['lynkr-reasoning'].limit.context, 1000000);
  assert.ok(!('lynkr-medium' in p.models), 'unconfigured tiers get no entry');
  assert.equal(p.options.baseURL, 'http://localhost:8081/v1');
});

test('unresolvable tier window floors to the minimum, never guesses upward', () => {
  const withUnknown = {
    tiers: {
      SIMPLE: { provider: 'ollama', model: 'mystery-local', contextWindow: null },
      REASONING: { provider: 'databricks', model: 'databricks-claude-opus-4-6', contextWindow: 1000000 },
    },
    minWindow: 1000000, // only resolvable window
  };
  const p = buildLynkrProvider(withUnknown, { baseURL: 'http://x', apiKey: 'k' });
  assert.equal(p.models['lynkr-simple'].limit.context, 1000000, 'floors to known min');
  const nothingKnown = { tiers: { SIMPLE: { provider: 'o', model: 'm', contextWindow: null } }, minWindow: null };
  const p2 = buildLynkrProvider(nothingKnown, { baseURL: 'http://x', apiKey: 'k' });
  assert.equal(p2.models['lynkr-auto'].limit.context, FALLBACK_WINDOW);
});

test('merge preserves every existing key and other providers', () => {
  const existing = {
    theme: 'dark',
    provider: {
      anthropic: { npm: '@ai-sdk/anthropic', options: { apiKey: 'user-key' } },
      lynkr: { stale: 'old-block' },
    },
    keybinds: { leader: 'space' },
  };
  const merged = mergeOpencodeConfig(existing, { npm: 'x', models: {} });
  assert.equal(merged.theme, 'dark');
  assert.deepEqual(merged.keybinds, { leader: 'space' });
  assert.equal(merged.provider.anthropic.options.apiKey, 'user-key');
  assert.deepEqual(merged.provider.lynkr, { npm: 'x', models: {} }, 'lynkr block fully replaced');
});

test('virtual ids pin their tiers server-side; auto and unknowns do not pin', () => {
  assert.equal(resolveTierForModelId('lynkr-simple'), 'SIMPLE');
  assert.equal(resolveTierForModelId('lynkr-medium'), 'MEDIUM');
  assert.equal(resolveTierForModelId('lynkr-complex'), 'COMPLEX');
  assert.equal(resolveTierForModelId('lynkr-reasoning'), 'REASONING');
  assert.equal(resolveTierForModelId('LYNKR-REASONING'), 'REASONING', 'case-insensitive');
  assert.equal(resolveTierForModelId('lynkr-auto'), null, 'auto = no pin');
  assert.equal(resolveTierForModelId('some-random-model'), null);
});

test('Claude Desktop slot ids keep resolving exactly as before (no regression)', () => {
  for (const slot of MODEL_SLOTS) {
    assert.equal(resolveTierForModelId(slot.id), slot.tier || null);
  }
  // The Desktop-advertised list must not contain the virtual ids — Desktop
  // validates against real Claude names and would break.
  const desktopIds = new Set(MODEL_SLOTS.map((s) => s.id));
  for (const virtualId of Object.keys(VIRTUAL_TIER_IDS)) {
    assert.ok(!desktopIds.has(virtualId), `${virtualId} must not leak into the Desktop model list`);
  }
});
