/**
 * OpenAI-compat ingress — tool injection is for mapped coding harnesses only.
 *
 * Until 2026-10 /v1/chat/completions and /v1/responses injected Lynkr's full
 * IDE_SAFE_TOOLS loadout into every tool-less request from a client they did
 * not recognise. That turned tool-less chats into tool-calling turns the
 * caller could not execute: Cursor chat mode, goose's summarizer
 * side-requests, Terminus, plain curl — and OpenMausBot, whose openai-compat
 * driver omits the `tools` key entirely for a bot without tools, so the
 * "empty tools array" opt-out from #59 never applied. #120 removed the same
 * class of injection on the provider side; this closes the ingress side.
 *
 * Rules under test, end-to-end through the real Express app with the
 * orchestrator mocked (same harness as tenant-policy-ingress-parity.test.js):
 *   1. unrecognised tool-less client → forwarded tool-less, no profile;
 *   2. a client with a CLIENT_TOOL_MAPPINGS entry (codex) → still injected,
 *      filtered to the mapped names (and renamed on /v1/responses);
 *   3. explicit opt-outs (tool_choice "none", empty tools array) still hold
 *      for a mapped client;
 *   4. a client profile with `injectTools: false` (openmausbot) is honoured
 *      via header or tool fingerprint, and its own tools pass through intact.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

process.env.DATABRICKS_API_KEY = process.env.DATABRICKS_API_KEY || 'test-key';
process.env.DATABRICKS_API_BASE = process.env.DATABRICKS_API_BASE || 'http://test.com';
process.env.LOG_FILE_ENABLED = 'false';

const { IDE_SAFE_TOOLS } = require('../src/clients/standard-tools');
const IDE_SAFE_NAMES = new Set(IDE_SAFE_TOOLS.map((t) => t.name));

// OpenMausBot 0.1.110 openai-compat loadout, as the app sends it (OpenAI shape).
const OPENMAUSBOT_TOOLS = [
  'ask_user',
  'agents_tool_result_read', 'agents_list_room_targets', 'agents_coordinate_bots',
  'agents_assignment_status', 'agents_list_bots', 'agents_list_rooms',
  'agents_select_computer', 'agents_list_threads', 'agents_close_thread',
  'agents_start_thread', 'agents_attach_file', 'agents_post_to_room',
  'agents_request_credential', 'agents_request_sign_in', 'agents_fill_login',
  'agents_memory_update', 'agents_memory_log', 'agents_session_search',
  'agents_session_read', 'agents_list_routines', 'agents_propose_routine',
  'agents_propose_routine_action', 'agents_propose_profile', 'agents_propose_model',
  'agents_propose_team_memory', 'agents_add_mcp_server',
].map((name) => ({
  type: 'function',
  function: { name, description: name, parameters: { type: 'object', properties: {} } },
}));

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

/** Boot the app with a recording orchestrator, POST once, return the payload the orchestrator saw. */
async function capture(t, urlPath, body, headers) {
  const payloads = [];
  mockOrchestrator(payloads);
  const server = await startTestApp();
  t.after(() => server.close());
  const { port } = server.address();
  const res = await postJson(port, urlPath, body, headers);
  assert.equal(res.status, 200, res.body);
  assert.equal(payloads.length, 1, `expected exactly one orchestrator call, got ${payloads.length}`);
  return payloads[0];
}

const names = (payload) => (payload.tools || []).map((x) => x.name);
const CHAT_BODY = { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] };
const RESPONSES_BODY = { model: 'gpt-4o-mini', input: 'hi' };

// --- 1. unrecognised clients are forwarded tool-less --------------------------

test('unrecognised tool-less client on /v1/chat/completions → no tools injected, no profile', async (t) => {
  const payload = await capture(t, '/v1/chat/completions', CHAT_BODY);
  assert.deepEqual(names(payload), [], `nothing may be injected for an unmapped client; got ${JSON.stringify(names(payload))}`);
  assert.equal(payload._clientProfile, undefined, 'no tools, no headers → nothing to fingerprint');
});

test('unrecognised tool-less client on /v1/responses → no tools injected', async (t) => {
  const payload = await capture(t, '/v1/responses', RESPONSES_BODY);
  assert.deepEqual(names(payload), []);
});

test('Cursor-style user-agent (no tool mapping) tool-less → still no injection', async (t) => {
  // Cursor is a known routing profile but has no CLIENT_TOOL_MAPPINGS entry:
  // in chat mode it sends no tools and cannot execute any Lynkr injects.
  const payload = await capture(t, '/v1/chat/completions', CHAT_BODY, { 'user-agent': 'Cursor/1.2.3' });
  assert.deepEqual(names(payload), []);
  assert.equal(payload._clientProfile?.name, 'cursor', 'the routing profile is still attached');
});

// --- 2. mapped coding harnesses keep their injection -------------------------

test('codex (mapped) tool-less on /v1/chat/completions → injected, filtered to mapped Lynkr names', async (t) => {
  const payload = await capture(t, '/v1/chat/completions', CHAT_BODY, { 'user-agent': 'codex_cli_rs/0.142.0' });
  const injected = names(payload);
  assert.ok(injected.length > 0, 'a mapped client must still receive tools');
  assert.ok(injected.length < IDE_SAFE_TOOLS.length, 'and only the subset its mapping covers');
  for (const n of injected) assert.ok(IDE_SAFE_NAMES.has(n), `${n} is not an IDE_SAFE tool`);
});

test('codex (mapped) tool-less on /v1/responses → injected and renamed to client conventions', async (t) => {
  const payload = await capture(t, '/v1/responses', RESPONSES_BODY, { 'user-agent': 'codex_cli_rs/0.142.0' });
  const injected = names(payload);
  assert.ok(injected.length > 0, 'codex must still receive tools on the responses route');
  assert.ok(injected.includes('shell'), `codex tools must use codex names (shell, apply_patch…); got ${JSON.stringify(injected)}`);
  for (const n of injected) assert.ok(!IDE_SAFE_NAMES.has(n), `${n} should have been renamed`);
  for (const excluded of ['Task', 'WebSearch', 'WebFetch', 'TodoWrite']) {
    assert.ok(!injected.includes(excluded), `${excluded} is server-side only and must not reach codex`);
  }
});

// --- 3. explicit opt-outs still win for a mapped client ----------------------

test('codex with an explicit empty tools array → opt-out honoured (#59 preserved)', async (t) => {
  const payload = await capture(t, '/v1/chat/completions', { ...CHAT_BODY, tools: [] }, { 'user-agent': 'codex_cli_rs/0.142.0' });
  assert.deepEqual(names(payload), []);
});

test('codex with tool_choice "none" → opt-out honoured on both routes', async (t) => {
  const chat = await capture(t, '/v1/chat/completions', { ...CHAT_BODY, tool_choice: 'none' }, { 'user-agent': 'codex_cli_rs/0.142.0' });
  assert.deepEqual(names(chat), []);
  const responses = await capture(t, '/v1/responses', { ...RESPONSES_BODY, tool_choice: 'none' }, { 'user-agent': 'codex_cli_rs/0.142.0' });
  assert.deepEqual(names(responses), []);
});

// --- 4. openmausbot profile --------------------------------------------------

test('openmausbot via x-client header, no tools → nothing injected, profile attached', async (t) => {
  const payload = await capture(t, '/v1/chat/completions', CHAT_BODY, { 'x-client': 'openmausbot' });
  assert.equal(payload._clientProfile?.name, 'openmausbot');
  assert.deepEqual(names(payload), []);
});

test('openmausbot via user-agent, no tools → nothing injected, profile attached', async (t) => {
  const payload = await capture(t, '/v1/chat/completions', CHAT_BODY, { 'user-agent': 'openmausbot/0.1.110' });
  assert.equal(payload._clientProfile?.name, 'openmausbot');
  assert.deepEqual(names(payload), []);
});

test('unidentified OpenMausBot bot → recognised by tool fingerprint, tools pass through untouched', async (t) => {
  // Exactly what the app sends: no identifying headers, its own tools array.
  const payload = await capture(t, '/v1/chat/completions', { ...CHAT_BODY, tools: OPENMAUSBOT_TOOLS });
  assert.equal(payload._clientProfile?.name, 'openmausbot');
  assert.deepEqual(
    names(payload).sort(),
    OPENMAUSBOT_TOOLS.map((x) => x.function.name).sort(),
    'the bot\'s own tools must reach the orchestrator unchanged — nothing added, nothing stripped'
  );
});

test('openmausbot on /v1/responses, no tools → nothing injected', async (t) => {
  const payload = await capture(t, '/v1/responses', RESPONSES_BODY, { 'x-client': 'openmausbot' });
  assert.equal(payload._clientProfile?.name, 'openmausbot');
  assert.deepEqual(names(payload), []);
});
