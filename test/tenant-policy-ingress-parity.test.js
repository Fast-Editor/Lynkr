/**
 * Regression test for issue #100: tenant policy was only applied to the
 * Anthropic /v1/messages ingress, silently exempting the OpenAI-compatible
 * ingress (/v1/chat/completions, /v1/responses) from per-tenant routing
 * overrides.
 *
 * Two layers, matching the two places the bug lived:
 *   1. Wiring — tenantMiddleware must be mounted on every AGENT_ENDPOINT in
 *      src/server.js, not just /v1/messages.
 *   2. Threading — every orchestrator.processMessage() call site in
 *      src/api/openai-router.js must forward res.locals.tenantPolicy, the
 *      same way src/api/router.js already does for /v1/messages.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const http = require('http');

process.env.DATABRICKS_API_KEY = process.env.DATABRICKS_API_KEY || 'test-key';
process.env.DATABRICKS_API_BASE = process.env.DATABRICKS_API_BASE || 'http://test.com';
process.env.LOG_FILE_ENABLED = 'false';

const TENANTS_DIR = path.join(__dirname, '../data/tenants');
const TEST_TENANT_FILE = path.join(TENANTS_DIR, 'ingress-parity-co.json');

test.before(() => {
  fs.mkdirSync(TENANTS_DIR, { recursive: true });
  fs.writeFileSync(TEST_TENANT_FILE, JSON.stringify({
    blockedModels: ['claude-opus-4-7'],
  }));
});

test.after(() => {
  if (fs.existsSync(TEST_TENANT_FILE)) fs.unlinkSync(TEST_TENANT_FILE);
});

// Note: this deliberately doesn't assert on Express's internal router stack
// (app._router.stack) to check middleware wiring directly — that structure
// isn't part of Express's public API and is brittle across versions. The
// behavioral test below exercises the real request path end-to-end instead,
// which covers both halves of the fix (the middleware wiring in server.js
// AND the options-threading in openai-router.js) through actual HTTP calls.

// --- Threading + wiring, exercised behaviorally --------------------------

function mockOrchestrator(record) {
  const modulePath = require.resolve('../src/orchestrator');
  delete require.cache[modulePath];
  require.cache[modulePath] = {
    id: modulePath,
    filename: modulePath,
    loaded: true,
    exports: {
      async processMessage(args) {
        record.push(args.options);
        return {
          body: {
            id: 'msg_test',
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

function postJson(port, urlPath, body, headers = {}) {
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
          ...headers,
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

test('the same tenant header produces the same tenantPolicy on /v1/messages and /v1/chat/completions', async (t) => {
  const calls = [];
  mockOrchestrator(calls);
  const server = await startTestApp();
  t.after(() => server.close());
  const { port } = server.address();

  await postJson(
    port,
    '/v1/messages',
    { model: 'claude-sonnet-4-5', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] },
    { 'LYNKR-Tenant-Id': 'ingress-parity-co' }
  );

  await postJson(
    port,
    '/v1/chat/completions',
    { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] },
    { 'LYNKR-Tenant-Id': 'ingress-parity-co' }
  );

  assert.equal(calls.length, 2, `expected 2 orchestrator calls, got ${calls.length}`);
  const [messagesOptions, chatCompletionsOptions] = calls;

  assert.ok(messagesOptions.tenantPolicy, '/v1/messages should have received a tenantPolicy (control — already worked pre-fix)');
  assert.ok(
    chatCompletionsOptions.tenantPolicy,
    '/v1/chat/completions must receive the same tenantPolicy as /v1/messages (issue #100)'
  );
  assert.ok(
    chatCompletionsOptions.tenantPolicy.blockedModels.has('claude-opus-4-7'),
    'the OpenAI-compat path must see the same blockedModels the tenant configured'
  );
});
