const test = require('node:test');
const assert = require('node:assert/strict');

const vision = require('../src/routing/vision');
const { convertAnthropicMessagesToOpenRouter } = require('../src/clients/openrouter-utils');
const tokenizer = require('../src/routing/tokenizer');

test('payloadNeedsVision covers all image shapes', () => {
  const base64 = 'a'.repeat(2000);
  // Anthropic base64
  assert.equal(vision.payloadNeedsVision({ messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: base64 } }] }] }), true);
  // Anthropic URL source
  assert.equal(vision.payloadNeedsVision({ messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'url', url: 'https://x/y.png' } }] }] }), true);
  // OpenAI image_url
  assert.equal(vision.payloadNeedsVision({ messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://x/y.png' } }] }] }), true);
  // OpenAI data URL
  assert.equal(vision.payloadNeedsVision({ messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: `data:image/png;base64,${base64}` } }] }] }), true);
  // Document with embedded base64
  assert.equal(vision.payloadNeedsVision({ messages: [{ role: 'user', content: [{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } }] }] }), true);
  // Nested tool_result screenshot
  assert.equal(vision.payloadNeedsVision({ messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: base64 } }] }] }] }), true);
  // Gemini inlineData
  assert.equal(vision.payloadNeedsVision({ messages: [{ role: 'user', content: [{ inlineData: { mimeType: 'image/png', data: base64 } }] }] }), true);
  // String data URL
  assert.equal(vision.payloadNeedsVision({ messages: [{ role: 'user', content: `see data:image/png;base64,${base64}` }] }), true);
  // Plain text: false
  assert.equal(vision.payloadNeedsVision({ messages: [{ role: 'user', content: 'hello' }] }), false);
  assert.equal(vision.payloadNeedsVision({ messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }] }), false);
});

test('countVisionImages counts nested screenshots', () => {
  const base64 = 'a'.repeat(100);
  const payload = { messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }, { type: 'image', source: { type: 'base64', data: base64 } }, { type: 'tool_result', tool_use_id: 't', content: [{ type: 'image', source: { type: 'base64', data: base64 } }] }] }] };
  assert.equal(vision.countVisionImages(payload), 2);
});

test('openrouter converter preserves images as image_url parts', () => {
  const base64 = 'a'.repeat(100);
  const input = [{ role: 'user', content: [{ type: 'text', text: 'what?' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: base64 } }] }];
  const out = convertAnthropicMessagesToOpenRouter(input);
  assert.equal(out.length, 1);
  assert.ok(Array.isArray(out[0].content), 'content should stay array when images present');
  const img = out[0].content.find((p) => p.type === 'image_url');
  assert.ok(img, 'expected image_url part');
  assert.ok(img.image_url.url.includes(base64));
});

test('openrouter converter extracts nested tool_result screenshots', () => {
  const base64 = 'b'.repeat(100);
  const input = [
    { role: 'assistant', content: [{ type: 'tool_use', id: 'call_1', name: 'screenshot', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: [{ type: 'text', text: 'shot' }, { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: base64 } }] }] },
  ];
  const out = convertAnthropicMessagesToOpenRouter(input);
  const toolMsg = out.find((m) => m.role === 'tool');
  assert.ok(toolMsg, 'tool message preserved adjacent to tool_calls');
  const userImg = out.find((m) => m.role === 'user' && Array.isArray(m.content) && m.content.some((p) => p.type === 'image_url'));
  assert.ok(userImg, 'screenshot re-attached as following user image_url');
});

test('openrouter empty-content guard preserves array content', () => {
  const base64 = 'c'.repeat(50);
  const input = [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: base64 } }] }];
  const out = convertAnthropicMessagesToOpenRouter(input);
  assert.ok(Array.isArray(out[0].content), 'image-only turn must not collapse to " "');
});

test('tokenizer charges fixed per-image cost, not base64 length', () => {
  const small = { messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', data: 'a'.repeat(100) } }] }] };
  const huge = { messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', data: 'a'.repeat(1000000) } }] }] };
  const tSmall = tokenizer.countPayloadTokens(small, 'gpt-4o');
  const tHuge = tokenizer.countPayloadTokens(huge, 'gpt-4o');
  assert.equal(tSmall, tHuge, 'base64 bytes must not inflate token count');
  assert.ok(tSmall >= 1500 && tSmall < 5000, `expected ~1500/img, got ${tSmall}`);
  const two = { messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', data: 'x' } }, { type: 'image', source: { type: 'base64', data: 'y' } }] }] };
  const tTwo = tokenizer.countPayloadTokens(two, 'gpt-4o');
  assert.ok(tTwo > tSmall, `two images (${tTwo}) should cost more than one (${tSmall})`);
  assert.ok(tTwo < 10000, `two images should still be bounded, got ${tTwo}`);
});

test('visionContextHash differs per image', () => {
  const a = { messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', data: 'a'.repeat(500) } }] }] };
  const b = { messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', data: 'b'.repeat(500) } }] }] };
  const ha = vision.visionContextHash(a);
  const hb = vision.visionContextHash(b);
  assert.ok(ha && hb && ha !== hb, 'different images must hash differently');
  assert.equal(vision.visionContextHash({ messages: [{ role: 'user', content: 'hi' }] }), null);
});

test('redactVisionBytes strips base64 but keeps structure', () => {
  const base64 = 'z'.repeat(2000);
  const redacted = vision.redactVisionBytes([{ type: 'image', source: { type: 'base64', data: base64 } }]);
  assert.ok(!JSON.stringify(redacted).includes(base64), 'raw bytes must not survive redaction');
  assert.ok(JSON.stringify(redacted).includes('REDACTED_IMAGE'));
  const urlRedacted = vision.redactVisionBytes(`prefix data:image/png;base64,${base64} suffix`);
  assert.ok(!urlRedacted.includes(base64));
});

test('providerSupportsVision gates transportless providers', () => {
  // Transportless providers never support vision regardless of model flag
  assert.equal(vision.providerSupportsVision('llamacpp', 'gpt-4o'), false);
  assert.equal(vision.providerSupportsVision('lmstudio', 'gpt-4o'), false);
  assert.equal(vision.providerSupportsVision('codex', 'gpt-4o'), false);
  assert.equal(vision.providerSupportsVision('openai', null), false);
});
