/**
 * Central vision detection + capability gating.
 *
 * Single source of truth for "does this payload need a vision-capable model?"
 * Covers Anthropic image blocks, OpenAI image_url parts, documents with
 * embedded images, Gemini inlineData, and nested tool_result screenshots.
 *
 * @module routing/vision
 */

const crypto = require('crypto');

const VISION_IMAGE_TOKEN_ESTIMATE = 1500;

// Providers that can never transport image bytes (no vision path, even after
// converter fixes). Everything else either forwards natively or converts.
const TRANSPORTLESS_PROVIDERS = new Set(['llamacpp', 'lmstudio', 'codex']);

/**
 * Does a single content block carry image data?
 * @param {object|string|null} block
 * @returns {boolean}
 */
function blockNeedsVision(block) {
  if (!block || typeof block !== 'object') {
    if (typeof block === 'string') {
      return block.includes('data:image');
    }
    return false;
  }
  // Anthropic native: {type:'image', source:{type:'base64'|'url', data|url}}
  if (block.type === 'image') return true;
  // OpenAI native: {type:'image_url', image_url:{url}} or {type:'input_image'}
  if (block.type === 'image_url' || block.type === 'input_image') return true;
  if (block.image_url?.url) return true;
  // Gemini: {inlineData:{mimeType,data}} / {inline_data:{...}} / {fileData}
  if (block.inlineData?.data || block.inline_data?.data || block.fileData) return true;
  // Anthropic document that embeds an image (PDF with scans)
  if (block.type === 'document' && block.source?.data) return true;
  // Generic base64 source marker
  if (block.source?.type === 'base64' && block.source?.data) return true;
  if (typeof block.source?.data === 'string' && block.source.data.length > 100) {
    // Heuristic: large opaque source payloads are media, not text
    if (block.type !== 'text') return true;
  }
  // data: URL embedded in url/text fields
  if (typeof block.url === 'string' && block.url.startsWith('data:image')) return true;
  if (typeof block.text === 'string' && block.text.includes('data:image')) return true;
  // Nested tool_result content: {type:'tool_result', content:[{type:'image'...}]}
  if (block.type === 'tool_result' && block.content) {
    return contentNeedsVision(block.content);
  }
  return false;
}

/**
 * Does message content (string | array | object) contain image data?
 * @param {*} content
 * @returns {boolean}
 */
function contentNeedsVision(content) {
  if (!content) return false;
  if (typeof content === 'string') return content.includes('data:image');
  if (Array.isArray(content)) return content.some(blockNeedsVision);
  if (typeof content === 'object') return blockNeedsVision(content);
  return false;
}

/**
 * Does the full request payload need a vision-capable model?
 * Scans messages + system for any image signal.
 * @param {object} payload
 * @returns {boolean}
 */
function payloadNeedsVision(payload) {
  if (!payload || typeof payload !== 'object') return false;
  const messages = payload.messages;
  if (Array.isArray(messages)) {
    for (const msg of messages) {
      if (!msg) continue;
      if (contentNeedsVision(msg.content)) return true;
      // OpenAI tool_calls with image args (rare) — stringify check, cheap
      if (Array.isArray(msg.tool_calls)) {
        for (const tc of msg.tool_calls) {
          try {
            const args = typeof tc?.function?.arguments === 'string'
              ? tc.function.arguments
              : JSON.stringify(tc?.function?.arguments ?? '');
            if (args && args.includes('data:image')) return true;
          } catch { /* ignore */ }
        }
      }
    }
  }
  if (payload.system && contentNeedsVision(payload.system)) return true;
  if (payload.input && contentNeedsVision(payload.input)) return true;
  return false;
}

/**
 * Count image blocks in a payload (for token budgets + logging).
 * @param {object} payload
 * @returns {number}
 */
function countVisionImages(payload) {
  if (!payload || !Array.isArray(payload.messages)) return 0;
  let count = 0;
  const walk = (content) => {
    if (!content) return;
    if (typeof content === 'string') {
      // Count data: URLs in strings (rough)
      const matches = content.match(/data:image/g);
      if (matches) count += matches.length;
      return;
    }
    if (Array.isArray(content)) {
      for (const b of content) {
        if (!b || typeof b !== 'object') continue;
        if (b.type === 'image' || b.type === 'image_url' || b.type === 'input_image' || b.image_url?.url || b.inlineData?.data || b.inline_data?.data) {
          count += 1;
        } else if (b.type === 'tool_result' && b.content) {
          walk(b.content);
        }
      }
      return;
    }
    if (typeof content === 'object' && blockNeedsVision(content)) count += 1;
  };
  for (const msg of payload.messages) {
    if (msg) walk(msg.content);
  }
  return count;
}

/**
 * Hash image bytes for cache keys (avoids hashing multi-MB base64 twice and
 * gives stable keys for identical images).
 * @param {string} data - base64 or URL string
 * @returns {string} short hash
 */
function hashImageData(data) {
  if (!data || typeof data !== 'string') return 'empty';
  // URLs are short — hash full string; base64 is huge — hash first+last 4k
  const sample = data.length > 8192 ? data.slice(0, 4096) + data.slice(-4096) + data.length : data;
  return crypto.createHash('sha256').update(sample).digest('hex').substring(0, 16);
}

/**
 * Collect per-image hashes for semantic-cache context keying.
 * @param {object} payload
 * @returns {string|null} combined hash or null when no images
 */
function visionContextHash(payload) {
  if (!payload || !Array.isArray(payload.messages)) return null;
  const hashes = [];
  const collect = (content) => {
    if (!content || typeof content === 'string') return;
    const arr = Array.isArray(content) ? content : [content];
    for (const b of arr) {
      if (!b || typeof b !== 'object') continue;
      if (b.type === 'image' && b.source?.data) hashes.push(hashImageData(b.source.data));
      else if (b.type === 'image' && b.source?.url) hashes.push(hashImageData(b.source.url));
      else if ((b.type === 'image_url' || b.type === 'input_image') && b.image_url?.url) hashes.push(hashImageData(b.image_url.url));
      else if (b.image_url?.url) hashes.push(hashImageData(b.image_url.url));
      else if (b.inlineData?.data) hashes.push(hashImageData(b.inlineData.data));
      else if (b.inline_data?.data) hashes.push(hashImageData(b.inline_data.data));
      else if (b.type === 'tool_result' && b.content) collect(b.content);
    }
  };
  for (const msg of payload.messages) {
    if (msg) collect(msg.content);
  }
  if (hashes.length === 0) return null;
  return crypto.createHash('sha256').update(hashes.sort().join(',')).digest('hex').substring(0, 16);
}

/**
 * Per-provider transport + model capability gate.
 * Returns true only when the provider can carry image bytes AND the model
 * advertises vision support in the registry.
 *
 * @param {string} provider
 * @param {string|null} model
 * @returns {boolean}
 */
function providerSupportsVision(provider, model) {
  if (!provider || TRANSPORTLESS_PROVIDERS.has(provider)) return false;
  if (!model) return false;
  try {
    const { getModelRegistrySync } = require('./model-registry');
    const registry = getModelRegistrySync();
    const info = registry.getCost(model);
    return info?.vision === true;
  } catch {
    return false;
  }
}

/**
 * Redact image bytes for logging / trajectory export.
 * Replaces source.data / image_url data: URLs with [REDACTED len=N hash=H].
 * Mutates a deep-cloned structure — never call on live payloads.
 * @param {*} value
 * @returns {*}
 */
function redactVisionBytes(value) {
  if (typeof value === 'string') {
    if (value.length > 2000 && value.includes('data:image')) {
      return value.replace(/data:image\/[^;,]+;base64,[A-Za-z0-9+/=]{100,}/g, (m) => `[REDACTED_IMAGE len=${m.length} hash=${hashImageData(m)}]`);
    }
    return value;
  }
  if (Array.isArray(value)) return value.map(redactVisionBytes);
  if (value && typeof value === 'object') {
    const out = { ...value };
    if (typeof out.source?.data === 'string' && out.source.data.length > 500) {
      out.source = { ...out.source, data: `[REDACTED_IMAGE len=${out.source.data.length} hash=${hashImageData(out.source.data)}]` };
    }
    if (typeof out.image_url?.url === 'string' && out.image_url.url.startsWith('data:image') && out.image_url.url.length > 500) {
      out.image_url = { ...out.image_url, url: `[REDACTED_IMAGE len=${out.image_url.url.length} hash=${hashImageData(out.image_url.url)}]` };
    }
    if (typeof out.inlineData?.data === 'string' && out.inlineData.data.length > 500) {
      out.inlineData = { ...out.inlineData, data: `[REDACTED_IMAGE len=${out.inlineData.data.length}]` };
    }
    // Recurse into nested content
    if (out.content !== undefined) out.content = redactVisionBytes(out.content);
    if (out.text !== undefined && typeof out.text === 'string' && out.text.includes('data:image')) {
      out.text = redactVisionBytes(out.text);
    }
    return out;
  }
  return value;
}

module.exports = {
  VISION_IMAGE_TOKEN_ESTIMATE,
  TRANSPORTLESS_PROVIDERS,
  blockNeedsVision,
  contentNeedsVision,
  payloadNeedsVision,
  countVisionImages,
  hashImageData,
  visionContextHash,
  providerSupportsVision,
  redactVisionBytes,
};
