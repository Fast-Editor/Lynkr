import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateText } from 'ai';
import { createLynkr, lynkr } from '../dist/index.js';

function mockFetch(captured) {
  return async (input, init) => {
    captured.url = String(input);
    captured.headers = new Headers(init?.headers);
    captured.body = JSON.parse(init.body);
    return new Response(
      JSON.stringify({
        id: 'chatcmpl-test',
        object: 'chat.completion',
        created: 0,
        model: captured.body.model,
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'Hello from Lynkr' },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 4, total_tokens: 5 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };
}

test('default provider instance targets localhost:8081', () => {
  const model = lynkr('auto');
  assert.equal(model.provider, 'lynkr.chat');
  assert.equal(model.modelId, 'auto');
});

test('generateText round-trips through the default base URL', async () => {
  const captured = {};
  const provider = createLynkr({ fetch: mockFetch(captured) });
  const result = await generateText({
    model: provider('auto'),
    prompt: 'Say hello.',
  });
  assert.equal(result.text, 'Hello from Lynkr');
  assert.equal(captured.url, 'http://localhost:8081/v1/chat/completions');
  assert.equal(captured.body.model, 'auto');
});

test('custom baseURL, apiKey, and headers are forwarded', async () => {
  const captured = {};
  const provider = createLynkr({
    baseURL: 'https://lynkr.example.com/v1',
    apiKey: 'test-key',
    headers: { 'x-lynkr-session': 'abc' },
    fetch: mockFetch(captured),
  });
  await generateText({ model: provider('claude-sonnet-5'), prompt: 'hi' });
  assert.equal(captured.url, 'https://lynkr.example.com/v1/chat/completions');
  assert.equal(captured.headers.get('authorization'), 'Bearer test-key');
  assert.equal(captured.headers.get('x-lynkr-session'), 'abc');
  assert.equal(captured.body.model, 'claude-sonnet-5');
});
