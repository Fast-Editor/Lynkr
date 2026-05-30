const test = require('node:test');
const assert = require('node:assert/strict');

/**
 * Tests for the vision routing guard.
 *
 * When a payload contains image content blocks and the selected model lacks
 * vision support, routing should upgrade to the cheapest vision-capable model
 * at or above the current tier.
 */

// ── Helpers ──────────────────────────────────────────────────────────────────

function imagePayload() {
  return {
    messages: [
      { role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abc' } }, { type: 'text', text: 'What is this?' }] },
    ],
  };
}

function textPayload() {
  return {
    messages: [
      { role: 'user', content: 'Hello world' },
    ],
  };
}

function imageUrlPayload() {
  return {
    messages: [
      { role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://example.com/img.png' } }] },
    ],
  };
}

// Extracted pure function mirroring _payloadHasImages in routing/index.js
function payloadHasImages(payload) {
  const messages = payload?.messages;
  if (!Array.isArray(messages)) return false;
  return messages.some(msg => {
    const content = msg?.content;
    if (!Array.isArray(content)) return false;
    return content.some(block => block?.type === 'image' || block?.type === 'image_url');
  });
}

// Minimal stub for selector.findVisionCapable — returns first vision-capable
// entry from a hard-coded tier map, or null when tier has no vision model.
function makeSelector(visionMap) {
  return {
    findVisionCapable(preferredTier) {
      const tierOrder = preferredTier
        ? [preferredTier, 'COMPLEX', 'REASONING', 'MEDIUM', 'SIMPLE']
        : ['COMPLEX', 'REASONING', 'MEDIUM', 'SIMPLE'];
      const seen = new Set();
      for (const t of tierOrder) {
        if (seen.has(t)) continue;
        seen.add(t);
        if (visionMap[t]) return { ...visionMap[t], tier: t };
      }
      return null;
    },
  };
}

// Minimal registry stub
function makeRegistry(visionByModel) {
  return {
    getCost(model) { return visionByModel[model] ?? { vision: false }; },
  };
}

// Core logic extracted for unit testing in isolation
function applyVisionGuard({ payload, provider, selectedModel, tier, method, selector, registry }) {
  if (!payloadHasImages(payload)) return { provider, selectedModel, tier, method };
  const modelInfo = registry.getCost(selectedModel);
  if (modelInfo?.vision) return { provider, selectedModel, tier, method };

  const visionModel = selector.findVisionCapable(tier);
  if (!visionModel) return { provider, selectedModel, tier, method, warn: true };

  return {
    provider: visionModel.provider,
    selectedModel: visionModel.model,
    tier: visionModel.tier !== tier ? visionModel.tier : tier,
    method: method + '+vision_guard',
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test('text-only payload is a no-op', () => {
  const selector = makeSelector({ MEDIUM: { provider: 'anthropic', model: 'claude-sonnet-4-6' } });
  const registry = makeRegistry({ 'llama3.2': { vision: false } });
  const result = applyVisionGuard({
    payload: textPayload(),
    provider: 'ollama', selectedModel: 'llama3.2', tier: 'SIMPLE', method: 'tier_config',
    selector, registry,
  });
  assert.equal(result.selectedModel, 'llama3.2');
  assert.equal(result.method, 'tier_config');
});

test('image payload with vision-capable model is a no-op', () => {
  const selector = makeSelector({});
  const registry = makeRegistry({ 'claude-sonnet-4-6': { vision: true } });
  const result = applyVisionGuard({
    payload: imagePayload(),
    provider: 'anthropic', selectedModel: 'claude-sonnet-4-6', tier: 'MEDIUM', method: 'tier_config',
    selector, registry,
  });
  assert.equal(result.selectedModel, 'claude-sonnet-4-6');
  assert.equal(result.method, 'tier_config');
});

test('image payload with non-vision model upgrades to vision-capable model at same tier', () => {
  const selector = makeSelector({ MEDIUM: { provider: 'anthropic', model: 'claude-sonnet-4-6' } });
  const registry = makeRegistry({ 'llama3.2': { vision: false }, 'claude-sonnet-4-6': { vision: true } });
  const result = applyVisionGuard({
    payload: imagePayload(),
    provider: 'ollama', selectedModel: 'llama3.2', tier: 'MEDIUM', method: 'tier_config',
    selector, registry,
  });
  assert.equal(result.selectedModel, 'claude-sonnet-4-6');
  assert.equal(result.provider, 'anthropic');
  assert.ok(result.method.includes('+vision_guard'));
});

test('image_url block type is also detected', () => {
  const selector = makeSelector({ SIMPLE: { provider: 'anthropic', model: 'claude-haiku-4-5' } });
  const registry = makeRegistry({ 'llama3.2': { vision: false }, 'claude-haiku-4-5': { vision: true } });
  const result = applyVisionGuard({
    payload: imageUrlPayload(),
    provider: 'ollama', selectedModel: 'llama3.2', tier: 'SIMPLE', method: 'tier_config',
    selector, registry,
  });
  assert.ok(result.method.includes('+vision_guard'));
  assert.equal(result.selectedModel, 'claude-haiku-4-5');
});

test('upgrades tier when only higher tier has vision model', () => {
  const selector = makeSelector({ COMPLEX: { provider: 'anthropic', model: 'claude-opus-4-7' } });
  const registry = makeRegistry({ 'llama3.2': { vision: false }, 'claude-opus-4-7': { vision: true } });
  const result = applyVisionGuard({
    payload: imagePayload(),
    provider: 'ollama', selectedModel: 'llama3.2', tier: 'MEDIUM', method: 'tier_config',
    selector, registry,
  });
  assert.equal(result.tier, 'COMPLEX');
  assert.equal(result.selectedModel, 'claude-opus-4-7');
  assert.ok(result.method.includes('+vision_guard'));
});

test('no vision model available — method unchanged, warn flag set', () => {
  const selector = makeSelector({});
  const registry = makeRegistry({ 'llama3.2': { vision: false } });
  const result = applyVisionGuard({
    payload: imagePayload(),
    provider: 'ollama', selectedModel: 'llama3.2', tier: 'SIMPLE', method: 'tier_config',
    selector, registry,
  });
  assert.equal(result.selectedModel, 'llama3.2');
  assert.equal(result.method, 'tier_config');
  assert.equal(result.warn, true);
});

test('method tag stacks correctly with prior escalations', () => {
  const selector = makeSelector({ MEDIUM: { provider: 'anthropic', model: 'claude-sonnet-4-6' } });
  const registry = makeRegistry({ 'llama3.2': { vision: false }, 'claude-sonnet-4-6': { vision: true } });
  const result = applyVisionGuard({
    payload: imagePayload(),
    provider: 'ollama', selectedModel: 'llama3.2', tier: 'MEDIUM',
    method: 'tier_config+context_escalated',
    selector, registry,
  });
  assert.equal(result.method, 'tier_config+context_escalated+vision_guard');
});

test('null payload does not throw', () => {
  const selector = makeSelector({});
  const registry = makeRegistry({});
  const result = applyVisionGuard({
    payload: null,
    provider: 'anthropic', selectedModel: 'claude-sonnet-4-6', tier: 'MEDIUM', method: 'tier_config',
    selector, registry,
  });
  assert.equal(result.selectedModel, 'claude-sonnet-4-6');
  assert.equal(result.method, 'tier_config');
});
