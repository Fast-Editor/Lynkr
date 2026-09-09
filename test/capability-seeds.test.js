const assert = require('assert');
const { describe, it, beforeEach, afterEach } = require('node:test');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { cleanName } = require('../src/routing/capability-seeds/swebench');
const { loadBenchmarksDir } = require('../src/routing/capability-seeds/benchmarks-dir');
const { mapEntryToFamily, scoresToCaps, scoreToCap } = require('../src/routing/capability-seeds/normalize');
const registry = require('../src/routing/capability-seeds/registry');
const shortfall = require('../src/routing/shortfall');

const KNOWN = ['claude-opus-4.5', 'gpt-5.2', 'qwen3-coder-480b', 'kimi-k2.5', 'devstral-small', 'gemini-2.5-flash', 'gpt-5*'];

describe('leaderboard cleaning and family mapping', () => {
  it('cleans scaffold, date and effort qualifiers', () => {
    assert.strictEqual(cleanName('Claude 4.5 Opus (high) · mini-SWE-agent · 2026-02-17'), 'claude 4.5 opus');
    assert.strictEqual(cleanName('GPT 5.2 · mini-SWE-agent · 2025-12-11'), 'gpt 5.2');
  });

  it('maps entries to families order-insensitively', () => {
    assert.strictEqual(mapEntryToFamily('claude 4.5 opus', KNOWN).family, 'claude-opus-4.5');
    assert.strictEqual(mapEntryToFamily('gpt 5.2', KNOWN).family, 'gpt-5.2');
    assert.strictEqual(mapEntryToFamily('qwen3-coder 480b-a35b instruct', KNOWN).family, 'qwen3-coder-480b');
    assert.strictEqual(mapEntryToFamily('kimi k2.5', KNOWN).family, 'kimi-k2.5');
  });

  it('refuses weak matches instead of seeding silently', () => {
    // "4" must not match "4.5" backwards; size tokens must match exactly.
    assert.strictEqual(mapEntryToFamily('claude 4 opus', ['claude-opus-4.5']).family, null);
    assert.strictEqual(mapEntryToFamily('qwen3-coder 32b', ['qwen3-coder-480b']).family, null);
    assert.strictEqual(mapEntryToFamily('completely unknown model 9000', KNOWN).family, null);
  });

  it('loads drop-in benchmark dirs and skips bad files', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-'));
    fs.writeFileSync(path.join(dir, 'good.json'), JSON.stringify({ source: 's', results: { 'A B': 10 } }));
    fs.writeFileSync(path.join(dir, 'bad.json'), JSON.stringify({ nope: true }));
    fs.writeFileSync(path.join(dir, 'ignore.txt'), 'x');
    const { files } = loadBenchmarksDir(dir);
    assert.strictEqual(files.length, 2);
    assert.ok(files.some((f) => f.status === 'ok' && f.entries.length === 1));
    assert.ok(files.some((f) => f.status === 'skipped'));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('missing benchmarks dir is not an error', () => {
    assert.deepStrictEqual(loadBenchmarksDir(path.join(os.tmpdir(), 'no-such-dir-xyz')).files, []);
  });
});

describe('score normalization', () => {
  it('anchors flagship territory near the ceiling', () => {
    assert.ok(scoreToCap(0.8) >= 0.85);
    assert.ok(scoreToCap(0) === 0.15);
  });

  it('blends present sources and needs at least one', () => {
    const caps = scoresToCaps({ swe: 0.74 });
    assert.ok(caps && caps.reasoning > 0.6 && caps.reasoning < 0.9);
    assert.strictEqual(scoresToCaps({}), null);
    assert.strictEqual(scoresToCaps(null), null);
  });

  it('applies the pessimistic haircut vs raw anchor', () => {
    assert.ok(scoresToCaps({ swe: 0.8 }).reasoning < scoreToCap(0.8));
  });
});

describe('seed registry precedence', () => {
  beforeEach(() => {
    registry._resetSeedsCache();
    shortfall._resetProfilesCache();
  });
  afterEach(() => {
    registry._resetSeedsCache();
    shortfall._resetProfilesCache();
  });

  const seed = (caps) => ({ caps });

  it('snapshot > shipped > family > tier, longest wildcard wins', () => {
    registry._setSeedsForTests({
      snapshot: { 'glm-5.2': seed({ reasoning: 0.7, codegen: 0.7, debugging: 0.7, tool_use: 0.7 }) },
      shipped: {
        'glm-5.2': seed({ reasoning: 0.1, codegen: 0.1, debugging: 0.1, tool_use: 0.1 }),
        'glm-*': seed({ reasoning: 0.5, codegen: 0.5, debugging: 0.5, tool_use: 0.5 }),
        'g*': seed({ reasoning: 0.2, codegen: 0.2, debugging: 0.2, tool_use: 0.2 }),
      },
    });
    assert.strictEqual(registry.resolveSeedCaps('glm-5.2').source, 'seed:snapshot');
    assert.strictEqual(registry.resolveSeedCaps('glm-4.7').source, 'seed:shipped');
    assert.strictEqual(registry.resolveSeedCaps('glm-4.7').caps.reasoning, 0.5);
    // shortest wildcard still matches (longest-prefix rule is exercised above)
    assert.strictEqual(registry.resolveSeedCaps('gpt-5.2').source, 'seed:shipped');
    assert.strictEqual(registry.resolveSeedCaps('totally-unknown-9z')?.source ?? null, null);
  });

  it('provider servings of one family share caps; quant takes haircut', () => {
    const a = shortfall.resolveCapabilitiesWithSource({ provider: 'zai', model: 'glm-5.2', tier: 'SIMPLE' });
    const b = shortfall.resolveCapabilitiesWithSource({ provider: 'baidu', model: 'glm-5.2', tier: 'COMPLEX' });
    const c = shortfall.resolveCapabilitiesWithSource({ provider: 'ollama', model: 'glm-5.2', tier: 'SIMPLE' });
    assert.strictEqual(a.source, 'seed:shipped');
    assert.deepStrictEqual(a.caps, b.caps);
    assert.deepStrictEqual(a.caps, c.caps);
    const q = shortfall.resolveCapabilitiesWithSource({ provider: 'ollama', model: 'glm-5.2:Q4_K_M', tier: 'SIMPLE' });
    assert.ok(q.caps.reasoning < a.caps.reasoning);
  });

  it('operator override wins verbatim over seeds, even quantized', () => {
    shortfall._setProfilesForTests({
      modelOverrides: { 'ollama:glm-5.2:q4_k_m': { reasoning: 0.9, codegen: 0.9, debugging: 0.9, tool_use: 0.9 } },
    });
    const r = shortfall.resolveCapabilitiesWithSource({ provider: 'ollama', model: 'glm-5.2:Q4_K_M', tier: 'SIMPLE' });
    assert.strictEqual(r.source, 'override');
    assert.strictEqual(r.caps.reasoning, 0.9);
  });

  it('unknown families fall back to tier caps, but muse-spark servings are seeded', () => {
    const r = shortfall.resolveCapabilitiesWithSource({ provider: 'openai', model: 'muse-spark-1.3-contributor-free', tier: 'SIMPLE' });
    // Shipped provisional seed from operator telemetry — NOT tier caps, and
    // NOT the full-1.3 flagship caps: variant servings stay separated.
    assert.strictEqual(r.source, 'seed:shipped');
    assert.ok(r.caps.reasoning < 0.5);
    const full = shortfall.resolveCapabilitiesWithSource({ provider: 'meta', model: 'muse-spark-1.3', tier: 'SIMPLE' });
    assert.strictEqual(full.source, 'seed:shipped');
    assert.ok(full.caps.reasoning > 0.8);
    const unknown = shortfall.resolveCapabilitiesWithSource({ provider: 'x', model: 'never-heard-of-it-9z', tier: 'SIMPLE' });
    assert.strictEqual(unknown.source, 'tier');
  });
});
