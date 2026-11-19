/**
 * OpenAI-compat ingress — the client's output-token cap reaches the
 * orchestrator, and an unset cap gets the same default as /v1/messages.
 *
 * Before this, convertOpenAIToAnthropic read only the deprecated `max_tokens`
 * and convertResponsesToChat read a `max_tokens` field the Responses API does
 * not have, both falling back to a hard-coded 4096. So:
 *   - `max_completion_tokens` (what current OpenAI SDKs send) was ignored;
 *   - the Responses API's `max_output_tokens` was ignored;
 *   - a client that set no cap (Codex never does) was silently held to 4096
 *     output tokens, while /v1/messages callers got the orchestrator's 16384.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

process.env.DATABRICKS_API_KEY = process.env.DATABRICKS_API_KEY || 'test-key';
process.env.DATABRICKS_API_BASE = process.env.DATABRICKS_API_BASE || 'http://test.com';
process.env.LOG_FILE_ENABLED = 'false';

const { convertOpenAIToAnthropic, resolveMaxOutputTokens } = require('../src/clients/openai-format');
const { convertResponsesToChat } = require('../src/clients/responses-format');

const CHAT_BODY = { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] };
const RESPONSES_BODY = { model: 'gpt-4o-mini', input: 'hi' };

// --- converters --------------------------------------------------------------

test('resolveMaxOutputTokens returns the first positive integer', () => {
  assert.equal(resolveMaxOutputTokens(2048, 1024), 2048);
  assert.equal(resolveMaxOutputTokens(undefined, 1024), 1024);
  assert.equal(resolveMaxOutputTokens(null, 0, -5, 1.5, '4000', 512), 512);
  assert.equal(resolveMaxOutputTokens(undefined, null), undefined);
  assert.equal(resolveMaxOutputTokens(), undefined);
});

test('chat: max_completion_tokens is honoured', () => {
  const out = convertOpenAIToAnthropic({ ...CHAT_BODY, max_completion_tokens: 12000 });
  assert.equal(out.max_tokens, 12000);
});

test('chat: max_completion_tokens wins over the deprecated max_tokens', () => {
  const out = convertOpenAIToAnthropic({ ...CHAT_BODY, max_completion_tokens: 12000, max_tokens: 100 });
  assert.equal(out.max_tokens, 12000);
});

test('chat: legacy max_tokens alone is still honoured', () => {
  const out = convertOpenAIToAnthropic({ ...CHAT_BODY, max_tokens: 1000 });
  assert.equal(out.max_tokens, 1000);
});

test('chat: no cap set → max_tokens left unset (no hard-coded 4096)', () => {
  const out = convertOpenAIToAnthropic(CHAT_BODY);
  assert.ok(!('max_tokens' in out), `expected no max_tokens, got ${out.max_tokens}`);
});

test('chat: an invalid cap is ignored rather than forwarded', () => {
  const out = convertOpenAIToAnthropic({ ...CHAT_BODY, max_completion_tokens: 0, max_tokens: -1 });
  assert.ok(!('max_tokens' in out));
});

test('responses: max_output_tokens becomes the chat max_tokens', () => {
  const chat = convertResponsesToChat({ ...RESPONSES_BODY, max_output_tokens: 20000 });
  assert.equal(chat.max_tokens, 20000);
  assert.equal(convertOpenAIToAnthropic(chat).max_tokens, 20000);
});

test('responses: max_output_tokens wins over a legacy max_tokens', () => {
  const chat = convertResponsesToChat({ ...RESPONSES_BODY, max_output_tokens: 20000, max_tokens: 50 });
  assert.equal(chat.max_tokens, 20000);
});

test('responses: legacy max_tokens alone is still honoured', () => {
  const chat = convertResponsesToChat({ ...RESPONSES_BODY, max_tokens: 3000 });
  assert.equal(chat.max_tokens, 3000);
});

test('responses: no cap set → max_tokens left unset through both conversions', () => {
  const chat = convertResponsesToChat(RESPONSES_BODY);
  assert.equal(chat.max_tokens, undefined);
  assert.ok(!('max_tokens' in convertOpenAIToAnthropic(chat)));
});

// --- end to end through the Express app ---------------------------------------
// Same harness as openai-ingress-tool-injection.test.js: the orchestrator is
// mocked and records the payload; the default itself is applied by the real
// sanitizePayload, checked last.

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
    const server = app.listen(0, () => resolve(server));
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
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
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

async function capture(t, urlPath, body) {
  const payloads = [];
  mockOrchestrator(payloads);
  const server = await startTestApp();
  t.after(() => server.close());
  const res = await postJson(server.address().port, urlPath, body);
  assert.equal(res.status, 200, res.body);
  assert.equal(payloads.length, 1);
  return payloads[0];
}

test('/v1/chat/completions forwards max_completion_tokens to the orchestrator', async (t) => {
  const payload = await capture(t, '/v1/chat/completions', { ...CHAT_BODY, max_completion_tokens: 12000 });
  assert.equal(payload.max_tokens, 12000);
});

test('/v1/chat/completions without a cap forwards none', async (t) => {
  const payload = await capture(t, '/v1/chat/completions', CHAT_BODY);
  assert.equal(payload.max_tokens, undefined);
});

test('/v1/responses forwards max_output_tokens to the orchestrator', async (t) => {
  const payload = await capture(t, '/v1/responses', { ...RESPONSES_BODY, max_output_tokens: 20000 });
  assert.equal(payload.max_tokens, 20000);
});

test('/v1/responses without a cap forwards none', async (t) => {
  const payload = await capture(t, '/v1/responses', RESPONSES_BODY);
  assert.equal(payload.max_tokens, undefined);
});

test('the orchestrator default applies when an OpenAI client sets no cap', () => {
  const modulePath = require.resolve('../src/orchestrator');
  delete require.cache[modulePath];
  const { sanitizePayload } = require('../src/orchestrator');
  const clean = sanitizePayload(convertOpenAIToAnthropic(convertResponsesToChat(RESPONSES_BODY)));
  assert.equal(clean.max_tokens, 16384);
});
