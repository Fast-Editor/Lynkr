/**
 * History Compression for Token Optimization
 *
 * Compresses conversation history to reduce token usage while
 * maintaining context quality. Uses sliding window approach:
 * - Keep recent turns verbatim
 * - Summarize older turns
 * - Compress tool results
 *
 */

const logger = require('../logger');
const config = require('../config');

/**
 * Compress conversation history to fit within token budget
 *
 * Strategy:
 * 1. Keep last N turns verbatim (fresh context)
 * 2. Summarize older turns (compressed history)
 * 3. Compress tool results to key information only
 * 4. Remove redundant exchanges
 *
 * @param {Array} messages - Conversation history
 * @param {Object} options - Compression options
 * @returns {Array} Compressed messages
 */
function compressHistory(messages, options = {}) {
  if (!messages || messages.length === 0) return messages;

  const opts = {
    keepRecentTurns: options.keepRecentTurns ?? config.historyCompression?.keepRecentTurns ?? 10,
    summarizeOlder: options.summarizeOlder ?? config.historyCompression?.summarizeOlder ?? true,
    enabled: options.enabled ?? config.historyCompression?.enabled ?? true,
  };

  if (!opts.enabled) {
    return messages; // Return uncompressed if disabled
  }

  // Calculate split point
  const splitIndex = Math.max(0, messages.length - opts.keepRecentTurns);

  if (splitIndex === 0) {
    // All messages are recent, no compression needed
    return messages;
  }

  const recentMessages = messages.slice(splitIndex);
  const oldMessages = messages.slice(0, splitIndex);

  let compressed = [];

  // Summarize old messages if configured
  if (opts.summarizeOlder && oldMessages.length > 0) {
    const summary = summarizeOldHistory(oldMessages);
    if (summary) {
      compressed.push(summary);
    }
  } else {
    // Just compress tool results in old messages
    compressed = oldMessages.map(msg => compressMessage(msg));
  }

  // Add recent messages (may compress tool results but keep content)
  const recentCompressed = recentMessages.map(msg => compressToolResults(msg));

  const finalMessages = [...compressed, ...recentCompressed];

  // Log compression stats
  const originalLength = JSON.stringify(messages).length;
  const compressedLength = JSON.stringify(finalMessages).length;
  const saved = originalLength - compressedLength;

  if (saved > 1000) {
    logger.debug({
      originalMessages: messages.length,
      compressedMessages: finalMessages.length,
      originalChars: originalLength,
      compressedChars: compressedLength,
      saved,
      percentage: ((saved / originalLength) * 100).toFixed(1),
      splitIndex,
      oldMessages: oldMessages.length,
      recentMessages: recentMessages.length
    }, 'History compression applied');
  }

  return finalMessages;
}

/**
 * Summarize old conversation history into a single message
 *
 * Creates a compact summary of older exchanges to preserve
 * context without consuming excessive tokens.
 *
 * @param {Array} messages - Old messages to summarize
 * @returns {Object} Summary message
 */
function summarizeOldHistory(messages) {
  if (!messages || messages.length === 0) return null;

  // Extract key exchanges and decisions
  const keyPoints = [];
  let hasUserInput = false;
  let hasAssistantOutput = false;

  for (const msg of messages) {
    if (msg.role === 'user') {
      hasUserInput = true;
      const content = extractTextContent(msg);
      if (content.length < 200) {
        keyPoints.push(`User: ${content}`);
      } else {
        // Compress long user messages
        keyPoints.push(`User: ${content.substring(0, 150)}...`);
      }
    } else if (msg.role === 'assistant') {
      hasAssistantOutput = true;
      const content = extractTextContent(msg);

      // Extract tool uses
      const toolUses = extractToolUses(msg);
      if (toolUses.length > 0) {
        keyPoints.push(`Assistant used tools: ${toolUses.join(', ')}`);
      }

      // Add assistant text if meaningful
      if (content.length > 20 && content.length < 200) {
        keyPoints.push(`Assistant: ${content}`);
      } else if (content.length >= 200) {
        keyPoints.push(`Assistant: ${content.substring(0, 150)}...`);
      }
    }
  }

  if (!hasUserInput || !hasAssistantOutput) {
    // Not enough content to summarize meaningfully
    return null;
  }

  const summaryText = `[Earlier conversation summary: ${keyPoints.join(' | ')}]`;

  return {
    role: 'user',
    content: summaryText
  };
}

/**
 * Compress a single message
 *
 * Reduces message size while preserving essential information.
 *
 * @param {Object} message - Message to compress
 * @returns {Object} Compressed message
 */
function compressMessage(message) {
  if (!message) return message;

  const compressed = {
    role: message.role
  };

  // Compress content based on type
  if (typeof message.content === 'string') {
    compressed.content = compressText(message.content, 300);
  } else if (Array.isArray(message.content)) {
    compressed.content = message.content
      .map(block => compressContentBlock(block))
      .filter(Boolean);
  } else {
    compressed.content = message.content;
  }

  return compressed;
}

/**
 * Compress tool results in a message while keeping other content
 *
 * Tool results can be very large. This compresses them while
 * keeping user and assistant text intact.
 *
 * @param {Object} message - Message to process
 * @returns {Object} Message with compressed tool results
 */
function compressToolResults(message) {
  if (!message) return message;

  const compressed = {
    role: message.role
  };

  if (typeof message.content === 'string') {
    compressed.content = message.content;
  } else if (Array.isArray(message.content)) {
    compressed.content = message.content.map(block => {
      // Compress tool_result blocks
      if (block.type === 'tool_result') {
        return compressToolResultBlock(block);
      }
      // Keep other blocks as-is
      return block;
    });
  } else {
    compressed.content = message.content;
  }

  return compressed;
}

/**
 * Compress a content block
 *
 * @param {Object} block - Content block
 * @returns {Object|null} Compressed block or null if removed
 */
function compressContentBlock(block) {
  if (!block) return null;

  switch (block.type) {
    case 'text':
      return {
        type: 'text',
        text: compressText(block.text, 300)
      };

    case 'tool_use':
      // Keep tool_use but compress arguments
      return {
        type: 'tool_use',
        id: block.id,
        name: block.name,
        input: block.input // Keep as-is, these are usually small
      };

    case 'tool_result':
      return compressToolResultBlock(block);

    default:
      return block;
  }
}

/**
 * Compress tool result block
 *
 * Tool results can be very large (file contents, bash output).
 * Compress while preserving essential information.
 *
 * @param {Object} block - tool_result block
 * @returns {Object} Compressed tool_result
 */
function compressToolResultBlock(block) {
  if (!block || block.type !== 'tool_result') return block;

  const compressed = {
    type: 'tool_result',
    tool_use_id: block.tool_use_id,
  };

  // Compress content
  if (typeof block.content === 'string') {
    compressed.content = compressText(block.content, 500);
  } else if (Array.isArray(block.content)) {
    compressed.content = block.content.map(item => {
      if (typeof item === 'string') {
        return compressText(item, 500);
      } else if (item.type === 'text') {
        return {
          type: 'text',
          text: compressText(item.text, 500)
        };
      }
      return item;
    });
  } else {
    compressed.content = block.content;
  }

  // Preserve error status
  if (block.is_error !== undefined) {
    compressed.is_error = block.is_error;
  }

  return compressed;
}

/**
 * Compress text to maximum length
 *
 * Uses intelligent truncation to preserve meaning.
 *
 * @param {string} text - Text to compress
 * @param {number} maxLength - Maximum length
 * @returns {string} Compressed text
 */
function compressText(text, maxLength) {
  if (!text || text.length <= maxLength) return text;

  // Try to preserve beginning and end
  const keepStart = Math.floor(maxLength * 0.4);
  const keepEnd = Math.floor(maxLength * 0.4);

  const start = text.substring(0, keepStart);
  const end = text.substring(text.length - keepEnd);

  return `${start}...[${text.length - maxLength} chars omitted]...${end}`;
}

/**
 * Extract text content from message
 *
 * @param {Object} message - Message object
 * @returns {string} Extracted text
 */
function extractTextContent(message) {
  if (typeof message.content === 'string') {
    return message.content;
  }

  if (Array.isArray(message.content)) {
    return message.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join(' ')
      .trim();
  }

  return '';
}

/**
 * Extract tool names used in message
 *
 * @param {Object} message - Message object
 * @returns {Array} Tool names
 */
function extractToolUses(message) {
  if (!Array.isArray(message.content)) return [];

  return message.content
    .filter(block => block.type === 'tool_use')
    .map(block => block.name);
}

/**
 * Calculate compression statistics
 *
 * @param {Array} original - Original messages
 * @param {Array} compressed - Compressed messages
 * @returns {Object} Statistics
 */
function calculateCompressionStats(original, compressed) {
  const originalLength = JSON.stringify(original).length;
  const compressedLength = JSON.stringify(compressed).length;
  const saved = originalLength - compressedLength;

  // Rough token estimate (4 chars ≈ 1 token)
  const tokensOriginal = Math.ceil(originalLength / 4);
  const tokensCompressed = Math.ceil(compressedLength / 4);
  const tokensSaved = tokensOriginal - tokensCompressed;

  return {
    originalMessages: original.length,
    compressedMessages: compressed.length,
    originalChars: originalLength,
    compressedChars: compressedLength,
    charsSaved: saved,
    tokensOriginal,
    tokensCompressed,
    tokensSaved,
    percentage: originalLength > 0 ? ((saved / originalLength) * 100).toFixed(1) : '0.0'
  };
}

/**
 * Check if history needs compression
 *
 * @param {Array} messages - Messages to check
 * @param {number} threshold - Minimum message count to trigger compression
 * @returns {boolean} True if compression recommended
 */
function needsCompression(messages, threshold = 15) {
  return messages && messages.length > threshold;
}

module.exports = {
  compressHistory,
  compressMessage,
  compressToolResults,
  calculateCompressionStats,
  needsCompression,
  summarizeOldHistory,
};
