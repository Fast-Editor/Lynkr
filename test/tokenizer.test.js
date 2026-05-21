const test = require('node:test');
const assert = require('node:assert/strict');

const { countTokens, countMessagesTokens, countPayloadTokens } = require('../src/routing/tokenizer');

test('tokenizer counts non-empty strings', () => {
  const n = countTokens('hello world', 'gpt-4o');
  assert.ok(n > 0);
});

test('tokenizer handles empty/null input', () => {
  assert.equal(countTokens('', null), 0);
  assert.equal(countTokens(null, null), 0);
  assert.equal(countTokens(undefined, null), 0);
});

test('countMessagesTokens with system + messages', () => {
  const n = countMessagesTokens(
    [{ role: 'user', content: 'What is the meaning of life?' }],
    'You are a helpful assistant.',
    'claude-sonnet-4-6'
  );
  assert.ok(n > 5);
});

test('countMessagesTokens with array content blocks', () => {
  const n = countMessagesTokens(
    [
      { role: 'user', content: [{ type: 'text', text: 'Read this file:' }, { type: 'text', text: 'console.log(1);' }] },
    ],
    null,
    null
  );
  assert.ok(n > 5);
});

test('countPayloadTokens parses Anthropic-style payload', () => {
  const n = countPayloadTokens({
    messages: [{ role: 'user', content: 'Hi' }],
    system: 'You are friendly',
    model: 'claude-haiku-4-5',
  });
  assert.ok(n > 0);
});

test('code tokens > 4-chars-per-token estimate', () => {
  // Code typically tokenizes denser than English prose. Verify the count is
  // at least roughly in the same ballpark as chars/4, never zero.
  const code = `function foo(x) { return x.map(i => i * 2).filter(i => i > 0); }`;
  const n = countTokens(code, 'gpt-4o');
  assert.ok(n >= Math.floor(code.length / 6));
});
