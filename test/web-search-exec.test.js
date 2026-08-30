/**
 * web-search-exec — narrowly-scoped server-side web_search/web_fetch
 * execution for clients client-profiles.js doesn't recognize.
 */
const assert = require('node:assert/strict');
const { describe, it, beforeEach, afterEach } = require('node:test');
const {
  isAutoResolvable,
  canAutoResolveAll,
  searchWeb,
  fetchUrl,
  autoResolve,
} = require('../src/tools/web-search-exec');

describe('isAutoResolvable / canAutoResolveAll', () => {
  it('recognizes web_search and web_fetch names, case-insensitively', () => {
    assert.equal(isAutoResolvable('web_search'), true);
    assert.equal(isAutoResolvable('WebSearch'), true);
    assert.equal(isAutoResolvable('web_fetch'), true);
    assert.equal(isAutoResolvable('WebFetch'), true);
  });

  it('rejects arbitrary tool names', () => {
    assert.equal(isAutoResolvable('Bash'), false);
    assert.equal(isAutoResolvable('Read'), false);
    assert.equal(isAutoResolvable(undefined), false);
  });

  it('resolves an all-web-tool batch', () => {
    assert.equal(canAutoResolveAll([{ name: 'WebSearch' }, { function: { name: 'web_fetch' } }]), true);
  });

  it('refuses a mixed batch — never partially resolves', () => {
    assert.equal(canAutoResolveAll([{ name: 'web_search' }, { name: 'Bash' }]), false);
  });

  it('refuses an empty batch', () => {
    assert.equal(canAutoResolveAll([]), false);
  });
});

describe('searchWeb / fetchUrl (fetch mocked — no live SearXNG dependency)', () => {
  let originalFetch;
  beforeEach(() => { originalFetch = global.fetch; });
  afterEach(() => { global.fetch = originalFetch; });

  it('searchWeb returns normalized results on success', async () => {
    global.fetch = async (url) => {
      assert.ok(String(url).includes('format=json'));
      return {
        ok: true,
        status: 200,
        json: async () => ({
          results: [
            { title: 'A', url: 'https://a.example', content: 'snippet a' },
            { title: 'B', url: 'https://b.example', content: 'snippet b' },
          ],
        }),
      };
    };
    const result = await searchWeb('test query');
    assert.equal(result.results.length, 2);
    assert.equal(result.results[0].title, 'A');
    assert.equal(result.error, undefined);
  });

  it('searchWeb reports an error (not a throw) on non-ok response', async () => {
    global.fetch = async () => ({ ok: false, status: 503 });
    const result = await searchWeb('test query');
    assert.ok(result.error);
    assert.ok(result.error.includes('503'));
  });

  it('searchWeb reports an error on network failure without throwing', async () => {
    global.fetch = async () => { throw new Error('ECONNREFUSED'); };
    const result = await searchWeb('test query');
    assert.ok(result.error.includes('ECONNREFUSED'));
  });

  it('fetchUrl returns truncated content within the configured preview max', async () => {
    global.fetch = async () => ({
      ok: true,
      status: 200,
      text: async () => 'x'.repeat(50000),
    });
    const result = await fetchUrl('https://example.com/big-page');
    assert.equal(result.status, 200);
    assert.ok(result.content.length <= 50000);
    assert.equal(result.truncated, true);
  });

  it('fetchUrl with no url returns an error, not a throw', async () => {
    const result = await fetchUrl('');
    assert.ok(result.error);
  });
});

describe('autoResolve — message shape mirrors a real client round-trip', () => {
  let originalFetch;
  beforeEach(() => {
    originalFetch = global.fetch;
    global.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ results: [{ title: 'T', url: 'https://x.example', content: 'c' }] }),
    });
  });
  afterEach(() => { global.fetch = originalFetch; });

  it('appends one assistant tool_use turn and one user tool_result turn', async () => {
    const messages = [{ role: 'user', content: 'search for something' }];
    const toolCalls = [{ id: 'call_1', function: { name: 'web_search', arguments: '{"query":"something"}' } }];
    await autoResolve(toolCalls, messages);

    assert.equal(messages.length, 3);
    const [, assistantTurn, userTurn] = messages;
    assert.equal(assistantTurn.role, 'assistant');
    assert.equal(assistantTurn.content[0].type, 'tool_use');
    assert.equal(assistantTurn.content[0].id, 'call_1');
    assert.equal(assistantTurn.content[0].name, 'web_search');

    assert.equal(userTurn.role, 'user');
    assert.equal(userTurn.content[0].type, 'tool_result');
    assert.equal(userTurn.content[0].tool_use_id, 'call_1');
    const parsed = JSON.parse(userTurn.content[0].content);
    assert.equal(parsed.results[0].title, 'T');
  });

  it('handles multiple calls in one batch, each getting its own tool_result', async () => {
    const messages = [];
    const toolCalls = [
      { id: 'call_a', name: 'web_search', input: { query: 'a' } },
      { id: 'call_b', name: 'web_search', input: { query: 'b' } },
    ];
    await autoResolve(toolCalls, messages);
    const [assistantTurn, userTurn] = messages;
    assert.equal(assistantTurn.content.length, 2);
    assert.equal(userTurn.content.length, 2);
    assert.equal(userTurn.content[0].tool_use_id, 'call_a');
    assert.equal(userTurn.content[1].tool_use_id, 'call_b');
  });

  it('tolerates unparseable arguments without throwing', async () => {
    const messages = [];
    const toolCalls = [{ id: 'call_1', function: { name: 'web_search', arguments: 'not json' } }];
    await assert.doesNotReject(() => autoResolve(toolCalls, messages));
    assert.equal(messages.length, 2);
  });
});
