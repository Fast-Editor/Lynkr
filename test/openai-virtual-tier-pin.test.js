/**
 * Lynkr virtual tier ids on the OpenAI-compatible endpoints.
 *
 * `lynkr-simple` … `lynkr-reasoning` (src/routing/model-slots.js
 * VIRTUAL_TIER_IDS) pin their tier on /v1/messages, and the docs promise
 * they "work from any client". The OpenAI-shaped handlers never go through
 * router.js's pin code, though — they only knew Codex's (model, effort)
 * mapping — so a Codex CLI / Cline / Continue user who set
 * `model = "lynkr-reasoning"` got plain content scoring instead of the tier
 * they asked for.
 *
 * Rules under test:
 *   1. resolveOpenAIRequestPin(): virtual ids pin their tier (case-
 *      insensitive) and outrank the effort mapping; `lynkr-auto` is an
 *      explicit "no pin" that also suppresses the effort mapping; everything
 *      else keeps resolving exactly as resolveTierForOpenAIModel() did.
 *   2. End-to-end through the real Express app (orchestrator mocked, same
 *      harness as openai-ingress-tool-injection.test.js): both
 *      /v1/chat/completions and /v1/responses hand the orchestrator a payload
 *      forced onto the pinned tier's configured provider/model.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

process.env.DATABRICKS_API_KEY = process.env.DATABRICKS_API_KEY || 'test-key';
process.env.DATABRICKS_API_BASE = process.env.DATABRICKS_API_BASE || 'http://test.com';
process.env.LOG_FILE_ENABLED = 'false';
// Distinct provider:model per tier so every assertion identifies the tier.
process.env.TIER_SIMPLE = 'ollama:qwen2.5-coder:7b';
process.env.TIER_MEDIUM = 'openai:gpt-4o-mini';
process.env.TIER_COMPLEX = 'openai:gpt-4o';
process.env.TIER_REASONING = 'openrouter:anthropic/claude-opus-4.1';

const {
  resolveOpenAIRequestPin,
  resolveTierForOpenAIModel,
} = require('../src/routing/openai-model-slots');
const { VIRTUAL_TIER_IDS } = require('../src/routing/model-slots');

const TIER_TARGETS = {
  SIMPLE: { provider: 'ollama', model: 'qwen2.5-coder:7b' },
  MEDIUM: { provider: 'openai', model: 'gpt-4o-mini' },
  COMPLEX: { provider: 'openai', model: 'gpt-4o' },
  REASONING: { provider: 'openrouter', model: 'anthropic/claude-opus-4.1' },
};

// --- 1. resolver ----------------------------------------------------------------

test('every virtual tier id pins its tier with the model_id_pin method', () => {
  for (const [id, tier] of Object.entries(VIRTUAL_TIER_IDS)) {
    if (!tier) continue;
    assert.deepEqual(resolveOpenAIRequestPin(id, null), { tier, method: 'model_id_pin' }, id);
  }
});

test('virtual tier ids match case-insensitively, like resolveTierForModelId', () => {
  assert.deepEqual(resolveOpenAIRequestPin('Lynkr-Reasoning', null), { tier: 'REASONING', method: 'model_id_pin' });
  assert.deepEqual(resolveOpenAIRequestPin('LYNKR-SIMPLE', 'high'), { tier: 'SIMPLE', method: 'model_id_pin' });
});

test('a virtual tier id outranks the reasoning-effort mapping', () => {
  // Codex attaches an effort to every request; the named tier must win.
  assert.deepEqual(resolveOpenAIRequestPin('lynkr-simple', 'high'), { tier: 'SIMPLE', method: 'model_id_pin' });
  assert.deepEqual(resolveOpenAIRequestPin('lynkr-reasoning', 'minimal'), { tier: 'REASONING', method: 'model_id_pin' });
});

test('lynkr-auto is an explicit no-pin and suppresses the effort mapping', () => {
  for (const effort of [null, 'minimal', 'low', 'medium', 'high']) {
    assert.equal(resolveOpenAIRequestPin('lynkr-auto', effort), null, `effort=${effort}`);
  }
});

test('non-virtual ids keep the (model, effort) mapping, labelled openai_model_effort_pin', () => {
  const cases = [
    ['gpt-5.6-sol', 'low'],
    ['gpt-5.6-sol', 'high'],
    ['gpt-5.6-mini', null],
    ['gpt-4o-nano', 'high'],
  ];
  for (const [model, effort] of cases) {
    const tier = resolveTierForOpenAIModel(model, effort);
    assert.ok(tier, `${model}/${effort} should pin via the effort mapping`);
    assert.deepEqual(resolveOpenAIRequestPin(model, effort), { tier, method: 'openai_model_effort_pin' });
  }
});

test('unrecognised or missing input resolves to no pin', () => {
  assert.equal(resolveOpenAIRequestPin('gpt-5.6-sol', null), null);
  assert.equal(resolveOpenAIRequestPin('gpt-5.6-sol', 'turbo'), null);
  assert.equal(resolveOpenAIRequestPin('lynkr-ultra', null), null, 'only the known virtual ids pin');
  assert.equal(resolveOpenAIRequestPin(undefined, undefined), null);
  assert.equal(resolveOpenAIRequestPin(null, null), null);
  assert.equal(resolveOpenAIRequestPin(42, null), null);
});

// --- 2. end-to-end through the real app -----------------------------------------

function mockOrchestrator(record) {
  const modulePath = require.resolve('../src/orchestrator');
  delete require.cache[modulePath];
  require.cache[modulePath] = {
    id: modulePath,
    filename: modulePath,
    loaded: true,
    exports: {
      async processMessage(args) {
        record.push(args.payload);
        return {
          body: {
            id: 'msg_test',
            model: 'test-model',
            content: [{ type: 'text', text: 'ok' }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 1, output_tokens: 1 },
          },
        };
      },
    },
  };
}

function startTestApp() {
  delete require.cache[require.resolve('../src/server')];
  delete require.cache[require.resolve('../src/api/router')];
  delete require.cache[require.resolve('../src/api/openai-router')];
  const { createApp } = require('../src/server');
  const app = createApp();
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function postJson(port, urlPath, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: urlPath,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
        },
      },
      (res) => {
        let chunks = '';
        res.on('data', (c) => (chunks += c));
        res.on('end', () => resolve({ status: res.statusCode, body: chunks }));
      }
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

/** Boot the app with a recording orchestrator, POST once, return the payload the orchestrator saw. */
async function capture(t, urlPath, body) {
  const payloads = [];
  mockOrchestrator(payloads);
  const server = await startTestApp();
  t.after(() => server.close());
  const { port } = server.address();
  const res = await postJson(port, urlPath, body);
  assert.equal(res.status, 200, res.body);
  assert.equal(payloads.length, 1, `expected exactly one orchestrator call, got ${payloads.length}`);
  return payloads[0];
}

function assertPinned(payload, tier, method) {
  assert.equal(payload._tierName, tier);
  assert.equal(payload._forceProvider, TIER_TARGETS[tier].provider);
  assert.equal(payload._tierModel, TIER_TARGETS[tier].model);
  assert.equal(payload._forcedMethod, method);
}

function assertUnpinned(payload) {
  assert.equal(payload._forceProvider, undefined, 'no pin → content routing decides');
  assert.equal(payload._tierName, undefined);
  assert.equal(payload._forcedMethod, undefined);
}

const chat = (model, extra = {}) => ({ model, messages: [{ role: 'user', content: 'hi' }], ...extra });
const responses = (model, extra = {}) => ({ model, input: 'hi', ...extra });

test('/v1/chat/completions: model "lynkr-reasoning" pins the REASONING tier', async (t) => {
  const payload = await capture(t, '/v1/chat/completions', chat('lynkr-reasoning'));
  assertPinned(payload, 'REASONING', 'model_id_pin');
});

test('/v1/chat/completions: model "lynkr-simple" outranks reasoning_effort "high"', async (t) => {
  const payload = await capture(t, '/v1/chat/completions', chat('lynkr-simple', { reasoning_effort: 'high' }));
  assertPinned(payload, 'SIMPLE', 'model_id_pin');
});

test('/v1/responses: model "lynkr-medium" with reasoning.effort "high" pins MEDIUM', async (t) => {
  const payload = await capture(t, '/v1/responses', responses('lynkr-medium', { reasoning: { effort: 'high' } }));
  assertPinned(payload, 'MEDIUM', 'model_id_pin');
});

test('/v1/responses: model "lynkr-auto" with reasoning.effort "high" stays unpinned', async (t) => {
  const payload = await capture(t, '/v1/responses', responses('lynkr-auto', { reasoning: { effort: 'high' } }));
  assertUnpinned(payload);
});

test('/v1/chat/completions: model "lynkr-auto" stays unpinned', async (t) => {
  const payload = await capture(t, '/v1/chat/completions', chat('lynkr-auto'));
  assertUnpinned(payload);
});

test('/v1/responses: the Codex (model, effort) pin is unchanged for real model ids', async (t) => {
  const payload = await capture(t, '/v1/responses', responses('gpt-5.6-sol', { reasoning: { effort: 'high' } }));
  assertPinned(payload, 'REASONING', 'openai_model_effort_pin');
});

test('/v1/chat/completions: a real model id without effort stays unpinned', async (t) => {
  const payload = await capture(t, '/v1/chat/completions', chat('gpt-4o'));
  assertUnpinned(payload);
});
