// Anti-drift tests for the two structural fixes born from the 2026-07-30
// module audit:
//
//  1. Provider dispatch registry (src/clients/databricks.js) — the initial
//     and fallback dispatch paths used to be duplicated if/else chains that
//     drifted: the fallback chain was missing ollama, bedrock, lmstudio and
//     codex, so a fallback to any of them silently dialed databricks (a
//     deliberate dead number under tier routing). Both paths now share
//     PROVIDER_INVOKERS; this test pins the registry to the provider enum
//     so they can never drift again.
//
//  2. buildDecision factory (src/routing/index.js) — routing decisions used
//     to be hand-assembled at 11 sites, which drifted (the non-tier agentic
//     branch omitted `model`; only session_pin carried the full telemetry
//     field set). The factory guarantees the reward-pipeline contract:
//     `propensity` and `candidates` are ALWAYS present.

const { test } = require('node:test');
const assert = require('node:assert');

process.env.DATABRICKS_API_KEY = process.env.DATABRICKS_API_KEY || 'test-key';
process.env.DATABRICKS_API_BASE = process.env.DATABRICKS_API_BASE || 'http://test.com';
process.env.LOG_FILE_ENABLED = 'false';

test('PROVIDER_INVOKERS covers every supported provider except databricks', () => {
  const { PROVIDER_INVOKERS } = require('../src/clients/databricks');

  // Mirror of SUPPORTED_MODEL_PROVIDERS in src/config/index.js. Kept as a
  // literal so that adding a provider to the config enum without wiring an
  // invoker fails HERE with a named provider, not in production with a
  // silent databricks dial.
  const SUPPORTED = [
    'azure-anthropic', 'ollama', 'openrouter', 'edenai', 'azure-openai',
    'openai', 'atlas', 'llamacpp', 'lmstudio', 'bedrock', 'zai', 'vertex', 'moonshot',
  ];

  const missing = SUPPORTED.filter((p) => typeof PROVIDER_INVOKERS[p] !== 'function');
  assert.deepStrictEqual(
    missing,
    [],
    `Providers in SUPPORTED_MODEL_PROVIDERS with no registered invoker: ${missing.join(', ')}`
  );
});

test('PROVIDER_INVOKERS includes the four providers the old fallback chain dropped', () => {
  const { PROVIDER_INVOKERS } = require('../src/clients/databricks');
  for (const p of ['ollama', 'bedrock', 'lmstudio', 'codex']) {
    assert.strictEqual(
      typeof PROVIDER_INVOKERS[p],
      'function',
      `${p} must have an invoker (it was missing from the pre-registry fallback chain)`
    );
  }
});

test('buildDecision always carries the reward-pipeline contract fields', () => {
  const { buildDecision } = require('../src/routing');

  const d = buildDecision({ provider: 'zai', method: 'force', reason: 'test' });

  // WS4.2 contract: off-policy evaluation requires these on EVERY decision.
  assert.strictEqual(typeof d.propensity, 'number');
  assert.ok(Array.isArray(d.candidates) && d.candidates.length >= 1);
  assert.deepStrictEqual(d.candidates[0], { provider: 'zai', model: null });

  // Telemetry-consumed fields must exist (null, not undefined).
  for (const key of ['model', 'tier', 'score', 'risk', 'analysis', 'agenticResult',
    'base_tier', 'escalation_source', 'switch_reason']) {
    assert.ok(key in d, `decision missing key: ${key}`);
  }
  assert.deepStrictEqual(d.escalations, []);
  assert.strictEqual(d.pinned, false);
});

test('buildDecision caller fields override defaults, extras pass through', () => {
  const { buildDecision } = require('../src/routing');

  const d = buildDecision({
    provider: 'ollama',
    model: 'ornith',
    method: 'agentic',
    reason: 'autonomous_workflow',
    score: 100,
    propensity: 0.25,
    candidates: [{ provider: 'ollama', model: 'ornith' }, { provider: 'zai', model: 'glm-5.2' }],
    _queryEmbedding: [0.1, 0.2],
  });

  assert.strictEqual(d.propensity, 0.25);
  assert.strictEqual(d.candidates.length, 2);
  assert.strictEqual(d.model, 'ornith');
  assert.deepStrictEqual(d._queryEmbedding, [0.1, 0.2]);
});

test('buildDecision derives analysis.requestType (WS2.3 telemetry repair)', () => {
  const { buildDecision } = require('../src/routing');

  // The telemetry record sites read analysis.requestType; before this fix
  // nothing set it and every routing_telemetry row recorded request_type
  // NULL, starving the evidence-based deescalator. Derivation must match
  // the deescalator's: breakdown.taskType.reason ?? taskType.
  const fromBreakdown = buildDecision({
    provider: 'ollama',
    method: 'tier_config',
    analysis: { score: 63, breakdown: { taskType: { reason: 'code_generation', score: 40 } } },
  });
  assert.strictEqual(fromBreakdown.analysis.requestType, 'code_generation');

  const fromTaskType = buildDecision({
    provider: 'ollama',
    method: 'tier_config',
    analysis: { score: 20, taskType: 'conversational' },
  });
  assert.strictEqual(fromTaskType.analysis.requestType, 'conversational');

  // Pre-set requestType is preserved, not overwritten.
  const preset = buildDecision({
    provider: 'ollama',
    method: 'tier_config',
    analysis: { requestType: 'already_set', breakdown: { taskType: { reason: 'other' } } },
  });
  assert.strictEqual(preset.analysis.requestType, 'already_set');

  // No analysis / no task-type signal → no crash, no fabricated value.
  assert.strictEqual(buildDecision({ provider: 'ollama', method: 'x' }).analysis, null);
  const bare = buildDecision({ provider: 'ollama', method: 'x', analysis: { score: 5 } });
  assert.ok(!('requestType' in bare.analysis) || bare.analysis.requestType == null);
});
