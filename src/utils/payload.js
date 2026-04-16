/**
 * Smart Payload Cloning & Size Estimation
 *
 * Optimizes deep-cloning of LLM request payloads to avoid
 * wasting memory on large base64 media blocks that will be
 * discarded by flattenBlocks() for most providers.
 *
 * @module utils/payload
 */

const logger = require('../logger');

/**
 * Estimate the byte size of message content without full serialization.
 * Scans for base64 image/audio data blocks and text blocks.
 *
 * @param {Object} payload - Request payload
 * @returns {number} Estimated size in bytes
 */
function estimateContentSize(payload) {
  if (!payload || !Array.isArray(payload.messages)) return 0;

  let size = 0;
  for (const msg of payload.messages) {
    if (!msg) continue;

    if (typeof msg.content === 'string') {
      size += msg.content.length;
      continue;
    }

    if (!Array.isArray(msg.content)) continue;

    for (const block of msg.content) {
      if (!block || typeof block !== 'object') continue;

      if (block.text) {
        size += block.text.length;
      }
      // Anthropic image format
      if (block.source?.data) {
        size += block.source.data.length;
      }
      // OpenAI image_url format (inline base64)
      if (block.image_url?.url && block.image_url.url.startsWith('data:')) {
        size += block.image_url.url.length;
      }
      // tool_result content
      if (block.type === 'tool_result' && typeof block.content === 'string') {
        size += block.content.length;
      }
    }
  }

  return size;
}

/**
 * Check if any message content block has base64 media data exceeding threshold.
 *
 * @param {Object} payload - Request payload
 * @param {number} threshold - Size threshold in bytes (default 1MB)
 * @returns {boolean}
 */
function hasLargeMedia(payload, threshold = 1_048_576) {
  if (!payload || !Array.isArray(payload.messages)) return false;

  for (const msg of payload.messages) {
    if (!msg || !Array.isArray(msg.content)) continue;

    for (const block of msg.content) {
      if (!block || typeof block !== 'object') continue;

      // Anthropic base64 image
      if (block.source?.data && block.source.data.length > threshold) {
        return true;
      }
      // OpenAI inline base64 image
      if (block.image_url?.url && block.image_url.url.length > threshold) {
        return true;
      }
    }
  }

  return false;
}

// Block types that flattenBlocks() discards (returns empty string)
const HEAVY_BLOCK_TYPES = new Set(['image', 'audio', 'image_url', 'video']);

/**
 * Check if a content block is a heavy media block that flattenBlocks() discards.
 * @param {Object} block
 * @returns {boolean}
 */
function isHeavyMediaBlock(block) {
  if (!block || typeof block !== 'object') return false;
  if (HEAVY_BLOCK_TYPES.has(block.type)) return true;
  if (block.source?.type === 'base64') return true;
  return false;
}

/**
 * Clone payload optimized for providers that will flatten content.
 * Skips cloning heavy media blocks since flattenBlocks() discards them.
 *
 * @param {Object} payload
 * @returns {Object} Cloned payload with media placeholders
 */
function cloneWithFlattenAwareness(payload) {
  const clean = { ...payload };

  // Deep-clone messages array but skip heavy media blocks
  if (Array.isArray(payload.messages)) {
    clean.messages = payload.messages.map(msg => {
      if (!msg) return msg;
      const cloned = { ...msg };

      if (Array.isArray(msg.content)) {
        cloned.content = msg.content.map(block => {
          if (!block || typeof block !== 'object') return block;

          // Skip heavy media blocks — flattenBlocks() produces "" for these
          if (isHeavyMediaBlock(block)) {
            return { type: block.type, _skipped: true };
          }

          // Shallow clone small blocks (text, tool_result, tool_use)
          if (block.type === 'tool_result' && typeof block.content === 'object') {
            return { ...block, content: JSON.parse(JSON.stringify(block.content)) };
          }
          return { ...block };
        });
      } else if (typeof msg.content === 'object' && msg.content !== null) {
        cloned.content = { ...msg.content };
      }

      // Clone tool_calls if present
      if (Array.isArray(msg.tool_calls)) {
        cloned.tool_calls = JSON.parse(JSON.stringify(msg.tool_calls));
      }

      return cloned;
    });
  }

  // Deep-clone small arrays that get mutated
  if (Array.isArray(payload.tools)) {
    clean.tools = JSON.parse(JSON.stringify(payload.tools));
  }
  if (Array.isArray(payload.system)) {
    clean.system = JSON.parse(JSON.stringify(payload.system));
  } else if (typeof payload.system === 'string') {
    clean.system = payload.system;
  }

  return clean;
}

/**
 * Smart deep-clone a request payload.
 *
 * - If willFlatten is true: skips cloning heavy media blocks (they'll be discarded)
 * - If willFlatten is false: uses structuredClone (faster than JSON round-trip)
 * - Falls back to JSON.parse(JSON.stringify()) for compatibility
 *
 * @param {Object} payload - Request payload to clone
 * @param {Object} options
 * @param {boolean} options.willFlatten - Whether flattenBlocks() will run (true for most providers)
 * @returns {Object} Cloned payload
 */
function clonePayloadSmart(payload, options = {}) {
  if (!payload) return {};

  const { willFlatten = false } = options;

  // Fast path: provider will flatten content — skip cloning media blocks
  if (willFlatten && Array.isArray(payload.messages)) {
    const hasMedia = payload.messages.some(msg =>
      Array.isArray(msg?.content) && msg.content.some(isHeavyMediaBlock)
    );
    if (hasMedia) {
      logger.debug('[payload] Using flatten-aware clone (skipping media blocks)');
      return cloneWithFlattenAwareness(payload);
    }
  }

  // Medium path: structuredClone (faster, no string intermediate)
  if (typeof structuredClone === 'function') {
    try {
      return structuredClone(payload);
    } catch {
      // structuredClone can fail on functions, symbols, etc.
    }
  }

  // Slow path: JSON round-trip (original behavior)
  return JSON.parse(JSON.stringify(payload));
}

module.exports = {
  estimateContentSize,
  hasLargeMedia,
  clonePayloadSmart,
  isHeavyMediaBlock,
};
