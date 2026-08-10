/**
 * Context Compression Module
 *
 * Inspired by TencentDB Agent Memory's short-term memory compression.
 * Reduces conversation context size before complexity scoring to enable
 * more accurate tier routing.
 *
 * Key insight: Long conversations bloat context → force expensive routing
 * even for simple follow-ups. By compressing tool outputs and previous
 * turns, we keep more requests in SIMPLE/MEDIUM tiers.
 *
 * @module routing/context-compressor
 */

const logger = require('../logger');

/**
 * Compress conversation messages by:
 * 1. Offloading verbose tool_result content
 * 2. Summarizing repetitive patterns
 * 3. Keeping only essential context for scoring
 *
 * Does NOT modify the actual request sent to LLM — only used for complexity scoring.
 *
 * @param {Array} messages - Conversation messages
 * @returns {{ compressed: Array, stats: Object }} - Compressed messages + stats
 */
function compressMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return { compressed: messages, stats: { original: 0, compressed: 0, ratio: 1.0 } };
  }

  const compressed = [];
  let originalSize = 0;
  let compressedSize = 0;
  let toolResultsOffloaded = 0;
  let messagesKept = 0;

  // Keep system message always
  const systemMsg = messages.find(m => m.role === 'system');
  if (systemMsg) {
    compressed.push(systemMsg);
    const size = estimateMessageSize(systemMsg);
    originalSize += size;
    compressedSize += size;
  }

  // Keep last N user/assistant turns (sliding window)
  const WINDOW_SIZE = 5;
  const recentTurns = messages
    .filter(m => m.role === 'user' || m.role === 'assistant')
    .slice(-WINDOW_SIZE);

  for (const msg of recentTurns) {
    const original = estimateMessageSize(msg);
    originalSize += original;

    // Compress tool_result blocks (biggest token consumers)
    if (Array.isArray(msg.content)) {
      const compressedContent = msg.content.map(block => {
        if (block?.type === 'tool_result') {
          toolResultsOffloaded++;
          // Keep only metadata, offload actual content
          return {
            type: 'tool_result',
            tool_use_id: block.tool_use_id,
            content: '[offloaded]', // Replaced with placeholder
            _compressed: true,
          };
        }
        return block;
      });

      const compressedMsg = { ...msg, content: compressedContent };
      compressed.push(compressedMsg);
      compressedSize += estimateMessageSize(compressedMsg);
      messagesKept++;
    } else {
      // No compression needed for string content
      compressed.push(msg);
      compressedSize += original;
      messagesKept++;
    }
  }

  const ratio = originalSize > 0 ? compressedSize / originalSize : 1.0;

  const stats = {
    original: originalSize,
    compressed: compressedSize,
    ratio,
    reduction: Math.round((1 - ratio) * 100),
    toolResultsOffloaded,
    messagesKept,
    messagesDropped: messages.length - messagesKept - (systemMsg ? 1 : 0),
  };

  logger.debug({
    ...stats,
    originalMsgs: messages.length,
    compressedMsgs: compressed.length,
  }, '[context-compressor] Compression complete');

  return { compressed, stats };
}

/**
 * Estimate message size in tokens (rough heuristic: chars / 4)
 */
function estimateMessageSize(msg) {
  if (!msg) return 0;

  let size = 0;

  // Role + metadata overhead
  size += 10;

  // Content
  if (typeof msg.content === 'string') {
    size += Math.ceil(msg.content.length / 4);
  } else if (Array.isArray(msg.content)) {
    for (const block of msg.content) {
      if (block?.type === 'text' && block.text) {
        size += Math.ceil(block.text.length / 4);
      } else if (block?.type === 'tool_result') {
        // Tool results are verbose (code, logs, errors)
        const content = Array.isArray(block.content)
          ? block.content.map(c => c?.text || '').join('')
          : (block.content || '');
        size += Math.ceil(content.length / 4);
      } else if (block?.type === 'tool_use') {
        // Tool use is compact (function name + args)
        size += 50;
      }
    }
  }

  return size;
}

/**
 * Check if compression is beneficial for this payload.
 * Only compress if conversation is long enough to matter.
 */
function shouldCompress(payload) {
  if (!payload?.messages || !Array.isArray(payload.messages)) {
    return false;
  }

  const msgCount = payload.messages.length;

  // Count total tool_result blocks (not just messages with tool results)
  let toolResultCount = 0;
  for (const msg of payload.messages) {
    if (Array.isArray(msg.content)) {
      toolResultCount += msg.content.filter(c => c?.type === 'tool_result').length;
    }
  }

  // Compress if:
  // 1. More than 10 messages (long conversation), OR
  // 2. More than 3 tool_result blocks (verbose outputs)
  return msgCount > 10 || toolResultCount > 3;
}

module.exports = {
  compressMessages,
  shouldCompress,
  estimateMessageSize,
};
