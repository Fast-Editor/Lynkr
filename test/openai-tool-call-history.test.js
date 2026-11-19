/**
 * OpenAI-compat ingress — past assistant tool calls in the history must not
 * fail the request.
 *
 * Clients send the whole conversation back on every turn, including the tool
 * calls the model made earlier. convertOpenAIToAnthropic ran a bare
 * JSON.parse on each call's `arguments`, so one call whose arguments were an
 * empty string (a no-argument call), JSON truncated by an output-token limit,
 * or an already-parsed object turned every later request in that
 * conversation into a 500. It also wrapped array `content` on such assistant
 * messages as `{ type: "text", text: [...] }`, which upstreams reject.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

process.env.DATABRICKS_API_KEY = process.env.DATABRICKS_API_KEY || 'test-key';
process.env.DATABRICKS_API_BASE = process.env.DATABRICKS_API_BASE || 'http://test.com';
process.env.LOG_FILE_ENABLED = 'false';

const { convertOpenAIToAnthropic, parseToolCallArguments } = require('../src/clients/openai-format');

/** A chat history whose single past tool call carries `args`. */
function historyWithToolCall(args, assistantContent = null) {
  return [
    { role: 'user', content: 'list the repo' },
    {
      role: 'assistant',
      content: assistantContent,
      tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'list_files', arguments: args } }],
    },
    { role: 'tool', tool_call_id: 'call_1', content: 'README.md' },
    { role: 'user', content: 'thanks, now summarise it' },
  ];
}

const toolUse = (anthropicRequest) => anthropicRequest.messages[1].content.find((b) => b.type === 'tool_use');

// --- parseToolCallArguments ----------------------------------------------------

test('parseToolCallArguments parses a JSON object string', () => {
  assert.deepEqual(parseToolCallArguments('{"path":"src","depth":2}'), { path: 'src', depth: 2 });
});

test('parseToolCallArguments returns an already-parsed object as is', () => {
  const args = { path: 'src' };
  assert.equal(parseToolCallArguments(args), args);
});

test('parseToolCallArguments maps empty and missing arguments to {}', () => {
  for (const args of ['', '   ', undefined, null]) {
    assert.deepEqual(parseToolCallArguments(args), {}, `for ${JSON.stringify(args)}`);
  }
});

test('parseToolCallArguments maps malformed or non-object JSON to {}', () => {
  for (const args of ['{"path": "sr', 'not json', '[1,2]', '"text"', '42', 'null', [1, 2], 7]) {
    assert.deepEqual(parseToolCallArguments(args), {}, `for ${JSON.stringify(args)}`);
  }
});

// --- convertOpenAIToAnthropic --------------------------------------------------

test('a well-formed tool call still converts to a tool_use with parsed input', () => {
  const out = convertOpenAIToAnthropic({ messages: historyWithToolCall('{"path":"."}') });
  assert.deepEqual(toolUse(out), { type: 'tool_use', id: 'call_1', name: 'list_files', input: { path: '.' } });
  assert.deepEqual(out.messages[2].content, [{ type: 'tool_result', tool_use_id: 'call_1', content: 'README.md' }]);
});

test('empty-string arguments no longer throw', () => {
  const out = convertOpenAIToAnthropic({ messages: historyWithToolCall('') });
  assert.deepEqual(toolUse(out).input, {});
});

test('truncated JSON arguments no longer throw', () => {
  const out = convertOpenAIToAnthropic({ messages: historyWithToolCall('{"path": "src/cli') });
  assert.deepEqual(toolUse(out).input, {});
  assert.equal(out.messages[2].content[0].type, 'tool_result', 'the result stays linked to its tool_use');
});

test('object arguments are used directly', () => {
  const out = convertOpenAIToAnthropic({ messages: historyWithToolCall({ path: 'docs' }) });
  assert.deepEqual(toolUse(out).input, { path: 'docs' });
});

test('array content on a tool-calling assistant message keeps its text blocks', () => {
  const out = convertOpenAIToAnthropic({
    messages: historyWithToolCall('{}', [
      { type: 'text', text: 'Listing files first.' },
      { type: 'text', text: '' },
    ]),
  });
  assert.deepEqual(out.messages[1].content, [
    { type: 'text', text: 'Listing files first.' },
    { type: 'tool_use', id: 'call_1', name: 'list_files', input: {} },
  ]);
});

test('string content on a tool-calling assistant message is unchanged', () => {
  const out = convertOpenAIToAnthropic({ messages: historyWithToolCall('{}', 'Listing files first.') });
  assert.deepEqual(out.messages[1].content[0], { type: 'text', text: 'Listing files first.' });
});

test('a tool call without a function name is dropped and its result degrades to text', () => {
  const messages = historyWithToolCall('{}');
  messages[1].tool_calls = [{ id: 'call_1', type: 'function' }];
  const out = convertOpenAIToAnthropic({ messages });
  assert.equal(toolUse(out), undefined);
  assert.deepEqual(out.messages[2].content, [{ type: 'text', text: '[Tool result call_1]: README.md' }]);
});

// --- end to end through the Express app ---------------------------------------
// Same harness as openai-ingress-tool-injection.test.js: the orchestrator is
// mocked and records the payload it receives.

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

test('/v1/chat/completions accepts a history with truncated tool-call arguments', async (t) => {
  const payload = await capture(t, '/v1/chat/completions', {
    model: 'gpt-4o-mini',
    messages: historyWithToolCall('{"path": "src/cli'),
  });
  assert.deepEqual(toolUse(payload).input, {});
});

test('/v1/responses accepts a function_call with empty arguments', async (t) => {
  const payload = await capture(t, '/v1/responses', {
    model: 'gpt-4o-mini',
    input: [
      { role: 'user', content: 'list the repo' },
      { type: 'function_call', call_id: 'call_1', name: 'list_files', arguments: '' },
      { type: 'function_call_output', call_id: 'call_1', output: 'README.md' },
      { role: 'user', content: 'thanks' },
    ],
  });
  const assistant = payload.messages.find((m) => m.role === 'assistant');
  assert.deepEqual(assistant.content.find((b) => b.type === 'tool_use').input, {});
});
