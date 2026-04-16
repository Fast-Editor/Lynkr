/**
 * Tests for Large Payload Passthrough — Smart Payload Cloning
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  estimateContentSize,
  hasLargeMedia,
  clonePayloadSmart,
  isHeavyMediaBlock,
} = require('../src/utils/payload');

// ── estimateContentSize ─────────────────────────────────────────────

describe('estimateContentSize', () => {
  it('returns 0 for null/empty payload', () => {
    assert.equal(estimateContentSize(null), 0);
    assert.equal(estimateContentSize({}), 0);
    assert.equal(estimateContentSize({ messages: [] }), 0);
  });

  it('counts string message content', () => {
    const size = estimateContentSize({
      messages: [{ role: 'user', content: 'hello world' }],
    });
    assert.equal(size, 11);
  });

  it('counts text blocks', () => {
    const size = estimateContentSize({
      messages: [{
        role: 'user',
        content: [{ type: 'text', text: 'hello' }, { type: 'text', text: 'world' }],
      }],
    });
    assert.equal(size, 10);
  });

  it('counts Anthropic base64 image data', () => {
    const data = 'x'.repeat(1000);
    const size = estimateContentSize({
      messages: [{
        role: 'user',
        content: [{ type: 'image', source: { type: 'base64', data } }],
      }],
    });
    assert.equal(size, 1000);
  });

  it('counts OpenAI inline base64 image_url data', () => {
    const url = 'data:image/png;base64,' + 'x'.repeat(500);
    const size = estimateContentSize({
      messages: [{
        role: 'user',
        content: [{ type: 'image_url', image_url: { url } }],
      }],
    });
    assert.equal(size, 522); // 'data:image/png;base64,' (22 chars) + 500
  });

  it('counts mixed content', () => {
    const data = 'x'.repeat(2000);
    const size = estimateContentSize({
      messages: [
        { role: 'user', content: 'short text' },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'hello' },
            { type: 'image', source: { type: 'base64', data } },
          ],
        },
      ],
    });
    assert.equal(size, 10 + 5 + 2000);
  });
});

// ── hasLargeMedia ───────────────────────────────────────────────────

describe('hasLargeMedia', () => {
  it('returns false for null/empty', () => {
    assert.equal(hasLargeMedia(null), false);
    assert.equal(hasLargeMedia({}), false);
  });

  it('returns false for text-only payload', () => {
    assert.equal(hasLargeMedia({
      messages: [{ role: 'user', content: 'hello' }],
    }), false);
  });

  it('returns false for small images', () => {
    assert.equal(hasLargeMedia({
      messages: [{
        role: 'user',
        content: [{ type: 'image', source: { type: 'base64', data: 'small' } }],
      }],
    }, 1_048_576), false);
  });

  it('returns true for large base64 image', () => {
    const data = 'x'.repeat(2_000_000);
    assert.equal(hasLargeMedia({
      messages: [{
        role: 'user',
        content: [{ type: 'image', source: { type: 'base64', data } }],
      }],
    }, 1_048_576), true);
  });

  it('respects custom threshold', () => {
    const data = 'x'.repeat(500);
    assert.equal(hasLargeMedia({
      messages: [{
        role: 'user',
        content: [{ type: 'image', source: { type: 'base64', data } }],
      }],
    }, 100), true);
  });
});

// ── isHeavyMediaBlock ───────────────────────────────────────────────

describe('isHeavyMediaBlock', () => {
  it('returns false for null/text/tool_result', () => {
    assert.equal(isHeavyMediaBlock(null), false);
    assert.equal(isHeavyMediaBlock({ type: 'text', text: 'hi' }), false);
    assert.equal(isHeavyMediaBlock({ type: 'tool_result', content: 'ok' }), false);
    assert.equal(isHeavyMediaBlock({ type: 'tool_use', name: 'Read' }), false);
  });

  it('returns true for image/audio/video blocks', () => {
    assert.equal(isHeavyMediaBlock({ type: 'image' }), true);
    assert.equal(isHeavyMediaBlock({ type: 'audio' }), true);
    assert.equal(isHeavyMediaBlock({ type: 'video' }), true);
    assert.equal(isHeavyMediaBlock({ type: 'image_url' }), true);
  });

  it('returns true for base64 source blocks', () => {
    assert.equal(isHeavyMediaBlock({ type: 'custom', source: { type: 'base64' } }), true);
  });
});

// ── clonePayloadSmart ───────────────────────────────────────────────

describe('clonePayloadSmart', () => {
  it('returns empty object for null', () => {
    assert.deepEqual(clonePayloadSmart(null), {});
  });

  it('deep clones text-only payload correctly', () => {
    const payload = {
      model: 'claude-3',
      messages: [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi there' },
      ],
      tools: [{ name: 'Read', description: 'Read file' }],
    };

    const clone = clonePayloadSmart(payload, { willFlatten: false });

    // Values match
    assert.deepEqual(clone.messages, payload.messages);
    assert.deepEqual(clone.tools, payload.tools);

    // But are different objects
    assert.notEqual(clone, payload);
    assert.notEqual(clone.messages, payload.messages);
  });

  it('with willFlatten=true, skips image blocks', () => {
    const bigData = 'x'.repeat(5000);
    const payload = {
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'describe this' },
          { type: 'image', source: { type: 'base64', data: bigData, media_type: 'image/png' } },
        ],
      }],
    };

    const clone = clonePayloadSmart(payload, { willFlatten: true });

    // Text block preserved
    assert.equal(clone.messages[0].content[0].type, 'text');
    assert.equal(clone.messages[0].content[0].text, 'describe this');

    // Image block replaced with lightweight placeholder
    assert.equal(clone.messages[0].content[1].type, 'image');
    assert.equal(clone.messages[0].content[1]._skipped, true);
    assert.equal(clone.messages[0].content[1].source, undefined); // No heavy data
  });

  it('with willFlatten=false, preserves all content blocks', () => {
    const payload = {
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'describe' },
          { type: 'image', source: { type: 'base64', data: 'abc123' } },
        ],
      }],
    };

    const clone = clonePayloadSmart(payload, { willFlatten: false });
    assert.equal(clone.messages[0].content[1].source.data, 'abc123');
  });

  it('deep clones tools array', () => {
    const payload = {
      messages: [],
      tools: [{ name: 'Read', input_schema: { type: 'object' } }],
    };

    const clone = clonePayloadSmart(payload, { willFlatten: true });
    assert.deepEqual(clone.tools, payload.tools);
    assert.notEqual(clone.tools, payload.tools);
  });

  it('handles string content messages', () => {
    const payload = {
      messages: [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'world' },
      ],
    };

    const clone = clonePayloadSmart(payload, { willFlatten: true });
    assert.equal(clone.messages[0].content, 'hello');
    assert.equal(clone.messages[1].content, 'world');
  });

  it('preserves tool_result blocks with willFlatten=true', () => {
    const payload = {
      messages: [{
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'abc', content: 'file contents here' },
        ],
      }],
    };

    const clone = clonePayloadSmart(payload, { willFlatten: true });
    assert.equal(clone.messages[0].content[0].type, 'tool_result');
    assert.equal(clone.messages[0].content[0].content, 'file contents here');
  });

  it('handles system prompt as string', () => {
    const payload = { messages: [], system: 'You are a helpful assistant' };
    const clone = clonePayloadSmart(payload, { willFlatten: true });
    assert.equal(clone.system, 'You are a helpful assistant');
  });

  it('deep clones system prompt as array', () => {
    const payload = {
      messages: [],
      system: [{ type: 'text', text: 'prompt' }],
    };
    const clone = clonePayloadSmart(payload, { willFlatten: true });
    assert.deepEqual(clone.system, payload.system);
    assert.notEqual(clone.system, payload.system);
  });
});

// ── flattenBlocks compatibility ─────────────────────────────────────

describe('flattenBlocks compatibility', () => {
  // Reproduce the flattenBlocks function from orchestrator to verify
  // that our _skipped placeholders produce empty strings
  function flattenBlocks(blocks) {
    if (!Array.isArray(blocks)) return String(blocks ?? '');
    return blocks
      .map((block) => {
        if (!block) return '';
        if (typeof block === 'string') return block;
        if (block.type === 'text' && typeof block.text === 'string') return block.text;
        if (block.type === 'tool_result') {
          const payload = block?.content ?? '';
          return typeof payload === 'string' ? payload : JSON.stringify(payload);
        }
        if (block.input_text) return block.input_text;
        return '';
      })
      .join('');
  }

  it('_skipped image placeholder produces empty string in flattenBlocks', () => {
    const result = flattenBlocks([
      { type: 'text', text: 'hello' },
      { type: 'image', _skipped: true },
    ]);
    assert.equal(result, 'hello');
  });

  it('_skipped audio placeholder produces empty string', () => {
    const result = flattenBlocks([
      { type: 'audio', _skipped: true },
    ]);
    assert.equal(result, '');
  });

  it('preserves text and tool_result alongside _skipped blocks', () => {
    const result = flattenBlocks([
      { type: 'text', text: 'describe ' },
      { type: 'image', _skipped: true },
      { type: 'tool_result', content: 'result' },
    ]);
    assert.equal(result, 'describe result');
  });
});
