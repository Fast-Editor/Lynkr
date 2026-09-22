const assert = require('assert');
const { describe, it, beforeEach } = require('node:test');

// Regression tests for issues #114 (tool injection / tool_choice override)
// and #115 (attachment conversion). All assert on what goes UPSTREAM:
// capabilities must never widen and content must never silently vanish.
const { toolsDeclined, forwardToolChoice } = require('../src/clients/databricks');
const { sanitizePayload } = require('../src/orchestrator/index');
const openrouterUtils = require('../src/clients/openrouter-utils');

describe('issue #114: toolsDeclined / forwardToolChoice', () => {
  it('detects declined choice in string and object forms', () => {
    assert.strictEqual(toolsDeclined({ tool_choice: 'none' }), true);
    assert.strictEqual(toolsDeclined({ tool_choice: 'NONE' }), true);
    assert.strictEqual(toolsDeclined({ tool_choice: { type: 'none' } }), true);
    assert.strictEqual(toolsDeclined({ tool_choice: 'auto' }), false);
    assert.strictEqual(toolsDeclined({}), false);
    assert.strictEqual(toolsDeclined(null), false);
  });

  it('forwards none verbatim, keeps auto default otherwise', () => {
    assert.strictEqual(forwardToolChoice({ tool_choice: 'none' }), 'none');
    assert.strictEqual(forwardToolChoice({ tool_choice: 'auto' }), 'auto');
    assert.strictEqual(forwardToolChoice({}), 'auto');
    assert.strictEqual(forwardToolChoice({ tool_choice: { type: 'function', function: { name: 'x' } } }), 'auto');
  });
});

describe('issue #114: azure-anthropic substitution becomes an error', () => {
  const base = () => ({
    _forceProvider: 'azure-anthropic',
    model: 'claude-opus-4-5',
    messages: [{ role: 'user', content: 'hi' }],
  });

  it('rejects unlisted declared tools naming them (400)', () => {
    const payload = { ...base(), tools: [{ name: 'tool_a', input_schema: { type: 'object' } }] };
    assert.throws(
      () => sanitizePayload(payload),
      (err) => {
        assert.strictEqual(err.statusCode, 400);
        assert.ok(err.message.includes('tool_a'), err.message);
        return true;
      }
    );
  });

  it('honors declined choice: no tools, choice none, no substitution', () => {
    const payload = { ...base(), tools: [], tool_choice: 'none' };
    const clean = sanitizePayload(payload);
    assert.ok(!clean.tools || clean.tools.length === 0);
    assert.strictEqual(clean.tool_choice, 'none');
  });

  it('passes listed tools through (WebSearch survives)', () => {
    const payload = {
      ...base(),
      tools: [{ name: 'WebSearch', input_schema: { type: 'object' } }],
    };
    const clean = sanitizePayload(payload);
    assert.strictEqual(clean.tools.length, 1);
    assert.strictEqual(clean.tools[0].name, 'WebSearch');
  });
});

describe('issue #115: attachment conversion', () => {
  it('image blocks (url + base64) convert to image_url parts', () => {
    const out = openrouterUtils.convertAnthropicMessagesToOpenRouter([
      { role: 'user', content: [{ type: 'image', source: { type: 'url', url: 'https://example.com/cat.png' } }] },
    ]);
    assert.strictEqual(out[0].content[0].type, 'image_url');
    const out2 = openrouterUtils.convertAnthropicMessagesToOpenRouter([
      { role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBOR' } }] },
    ]);
    assert.ok(out2[0].content[0].image_url.url.startsWith('data:image/png;base64,'));
  });

  it('document-only message errors naming the block instead of emptying', () => {
    assert.throws(
      () => openrouterUtils.convertAnthropicMessagesToOpenRouter([
        { role: 'user', content: [{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'JVBER' } }] },
      ]),
      (err) => {
        assert.strictEqual(err.statusCode, 400);
        assert.ok(err.message.includes('document'), err.message);
        return true;
      }
    );
  });

  it('thinking-only assistant messages do not trip the document guard', () => {
    const out = openrouterUtils.convertAnthropicMessagesToOpenRouter([
      { role: 'assistant', content: [{ type: 'thinking', thinking: 'hmm' }] },
    ]);
    assert.ok(out.length === 1);
  });
});
