/**
 * Accurate token estimation using js-tiktoken.
 *
 * Replaces the chars/4 approximation across the routing path. Falls back to
 * chars/4 if js-tiktoken is unavailable (graceful degradation — never throws).
 *
 * Phase 1.1 of the routing overhaul.
 *
 * @module routing/tokenizer
 */

const logger = require('../logger');

let _tiktoken = null;
let _tiktokenLoaded = false;
const _encoderCache = new Map();

function _loadTiktoken() {
  if (_tiktokenLoaded) return _tiktoken;
  _tiktokenLoaded = true;
  try {
    _tiktoken = require('js-tiktoken');
  } catch (err) {
    logger.debug(
      { err: err.message },
      '[Tokenizer] js-tiktoken not available, falling back to chars/4'
    );
    _tiktoken = null;
  }
  return _tiktoken;
}

function _encodingForModel(model) {
  if (!model || typeof model !== 'string') return 'cl100k_base';
  const lower = model.toLowerCase();
  // GPT-4o family + o-series use o200k_base
  if (
    lower.includes('gpt-4o') ||
    lower.includes('gpt-4.1') ||
    lower.includes('gpt-5') ||
    lower.includes('o1') ||
    lower.includes('o3') ||
    lower.includes('o4')
  ) {
    return 'o200k_base';
  }
  // GPT-4 / GPT-3.5 / Anthropic / most others approximate well with cl100k_base
  return 'cl100k_base';
}

function _getEncoder(model) {
  const tiktoken = _loadTiktoken();
  if (!tiktoken) return null;
  const encName = _encodingForModel(model);
  let cached = _encoderCache.get(encName);
  if (cached) return cached;
  try {
    cached = tiktoken.getEncoding(encName);
    _encoderCache.set(encName, cached);
    return cached;
  } catch (err) {
    logger.debug(
      { err: err.message, encoding: encName },
      '[Tokenizer] Encoder load failed, using fallback'
    );
    return null;
  }
}

/**
 * Count tokens in a single string.
 * @param {string} text
 * @param {string|null} model - optional model name for encoding selection
 * @returns {number}
 */
function countTokens(text, model = null) {
  if (!text || typeof text !== 'string') return 0;
  const encoder = _getEncoder(model);
  if (!encoder) return Math.ceil(text.length / 4);
  try {
    return encoder.encode(text).length;
  } catch (err) {
    return Math.ceil(text.length / 4);
  }
}

function _extractText(content) {
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    let combined = '';
    for (const block of content) {
      if (!block) continue;
      if (typeof block === 'string') {
        combined += block + ' ';
      } else if (block.type === 'text' && block.text) {
        combined += block.text + ' ';
      } else if (typeof block.text === 'string') {
        combined += block.text + ' ';
      } else if (block.type === 'tool_use' && block.input) {
        try {
          combined += JSON.stringify(block.input) + ' ';
        } catch {
          // ignore non-serializable input
        }
      } else if (block.type === 'tool_result' && block.content) {
        combined += _extractText(block.content) + ' ';
      }
    }
    return combined;
  }
  return '';
}

function _imageTokenEstimate(content) {
  if (!Array.isArray(content)) return 0;
  let imageBase64Bytes = 0;
  for (const block of content) {
    if (block?.type === 'image' && block.source?.data) {
      imageBase64Bytes += block.source.data.length;
    }
  }
  // Rough heuristic mirroring previous behavior: ~1 token per 6 base64 chars
  return Math.floor(imageBase64Bytes / 6);
}

/**
 * Count tokens across a full Anthropic-format message array + optional system.
 * @param {Array} messages
 * @param {string|Array|null} system
 * @param {string|null} model
 * @returns {number}
 */
function countMessagesTokens(messages = [], system = null, model = null) {
  let total = 0;
  if (system) {
    total += countTokens(_extractText(system), model);
  }
  if (Array.isArray(messages)) {
    for (const msg of messages) {
      total += countTokens(_extractText(msg?.content), model);
      total += _imageTokenEstimate(msg?.content);
    }
    // Per-message structural overhead (~4 tokens per message in both Anthropic and OpenAI)
    total += messages.length * 4;
  }
  return total;
}

/**
 * Count tokens from a full payload object (Anthropic-style with .messages, .system, .model).
 */
function countPayloadTokens(payload, model = null) {
  if (!payload) return 0;
  return countMessagesTokens(payload.messages, payload.system, model || payload.model);
}

module.exports = {
  countTokens,
  countMessagesTokens,
  countPayloadTokens,
};
