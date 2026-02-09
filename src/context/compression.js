/**
 * History Compression for Token Optimization
 *
 * Compresses conversation history to reduce token usage while
 * maintaining context quality. Uses sliding window approach with
 * percentage-based tiered compression that scales with recency
 * and the model's context window size.
 *
 * Tiers:
 * - veryRecent (last 4 messages): keep 90% of content
 * - recent (messages 5-10): keep 50% of content
 * - old (11+): keep 20% of content
 */

const logger = require('../logger');
const config = require('../config');

// Compression tiers: ratio = percentage of content to keep, minFloor = minimum chars
const COMPRESSION_TIERS = {
  veryRecent: { ratio: 0.9, minFloor: 500 },
  recent:     { ratio: 0.5, minFloor: 300 },
  old:        { ratio: 0.2, minFloor: 200 },
};

// How many of the recent messages count as "very recent"
const VERY_RECENT_COUNT = 4;

/**
 * Compute the maximum character cap for a tier based on context window size.
 *
 * @param {number} contextWindowTokens - Model's context window in tokens (-1 = unknown)
 * @param {string} tierName - "veryRecent", "recent", or "old"
 * @returns {number} Maximum characters for tool result content in this tier
 */
function computeMaxCap(contextWindowTokens, tierName) {
  // Convert tokens to chars (~4 chars/token), default to 8K tokens if unknown
  const contextChars = (contextWindowTokens === -1 ? 8000 : contextWindowTokens) * 4;
  const budgetRatios = {
    veryRecent: 0.25,
    recent: 0.10,
    old: 0.03,
  };
  return Math.floor(contextChars * (budgetRatios[tierName] ?? 0.03));
}

/**
 * Compute the character limit for a piece of content based on tier and context window.
 *
 * @param {string} text - The text content
 * @param {string} tierName - Tier name
 * @param {number} contextWindowTokens - Context window in tokens
 * @returns {number} Character limit
 */
function computeLimit(text, tierName, contextWindowTokens) {
  const tier = COMPRESSION_TIERS[tierName] || COMPRESSION_TIERS.old;
  const maxCap = computeMaxCap(contextWindowTokens, tierName);
  return Math.min(maxCap, Math.max(tier.minFloor, Math.floor(text.length * tier.ratio)));
}

/**
 * Compress conversation history to fit within token budget
 *
 * @param {Array} messages - Conversation history
 * @param {Object} options - Compression options
 * @returns {Array} Compressed messages
 */
function compressHistory(messages, options = {}) {
  if (!messages || messages.length === 0) return messages;

  const contextWindowTokens = options.contextWindowTokens ?? -1;

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
    // Compress tool results in old messages using "old" tier
    compressed = oldMessages.map(msg => compressMessage(msg, "old", contextWindowTokens));
  }

  // Add recent messages with tiered compression
  const recentCompressed = recentMessages.map((msg, i) => {
    const isVeryRecent = i >= recentMessages.length - VERY_RECENT_COUNT;
    const tierName = isVeryRecent ? "veryRecent" : "recent";
    return compressToolResults(msg, tierName, contextWindowTokens);
  });

  const finalMessages = [...compressed, ...recentCompressed];

  // Log compression stats - estimate sizes without expensive JSON.stringify
  const originalLength = estimateMessagesSize(messages);
  const compressedLength = estimateMessagesSize(finalMessages);
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
      recentMessages: recentMessages.length,
      contextWindowTokens,
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
 * Compress a single message (used for old messages outside the recent window)
 *
 * @param {Object} message - Message to compress
 * @param {string} tierName - Compression tier
 * @param {number} contextWindowTokens - Context window in tokens
 * @returns {Object} Compressed message
 */
function compressMessage(message, tierName = "old", contextWindowTokens = -1) {
  if (!message) return message;

  const limit = computeLimit("x".repeat(300), tierName, contextWindowTokens);

  const compressed = {
    role: message.role
  };

  // Compress content based on type
  if (typeof message.content === 'string') {
    compressed.content = compressText(message.content, limit);
  } else if (Array.isArray(message.content)) {
    compressed.content = message.content
      .map(block => compressContentBlock(block, tierName, contextWindowTokens))
      .filter(Boolean);
  } else {
    compressed.content = message.content;
  }

  return compressed;
}

/**
 * Compress tool results in a message while keeping other content
 *
 * @param {Object} message - Message to process
 * @param {string} tierName - Compression tier
 * @param {number} contextWindowTokens - Context window in tokens
 * @returns {Object} Message with compressed tool results
 */
function compressToolResults(message, tierName = "recent", contextWindowTokens = -1) {
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
        return compressToolResultBlock(block, tierName, contextWindowTokens);
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
 * @param {string} tierName - Compression tier
 * @param {number} contextWindowTokens - Context window in tokens
 * @returns {Object|null} Compressed block or null if removed
 */
function compressContentBlock(block, tierName = "old", contextWindowTokens = -1) {
  if (!block) return null;

  const limit = computeLimit("x".repeat(300), tierName, contextWindowTokens);

  switch (block.type) {
    case 'text':
      return {
        type: 'text',
        text: compressText(block.text, limit)
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
      return compressToolResultBlock(block, tierName, contextWindowTokens);

    default:
      return block;
  }
}

/**
 * Compress tool result block
 *
 * Uses dynamic limits based on compression tier and context window size
 * instead of a hardcoded character limit.
 *
 * @param {Object} block - tool_result block
 * @param {string} tierName - Compression tier
 * @param {number} contextWindowTokens - Context window in tokens
 * @returns {Object} Compressed tool_result
 */
function compressToolResultBlock(block, tierName = "old", contextWindowTokens = -1) {
  if (!block || block.type !== 'tool_result') return block;

  const compressed = {
    type: 'tool_result',
    tool_use_id: block.tool_use_id,
  };

  // Compress content using dynamic limits
  if (typeof block.content === 'string') {
    const limit = computeLimit(block.content, tierName, contextWindowTokens);
    compressed.content = compressText(block.content, limit);
  } else if (Array.isArray(block.content)) {
    compressed.content = block.content.map(item => {
      if (typeof item === 'string') {
        const limit = computeLimit(item, tierName, contextWindowTokens);
        return compressText(item, limit);
      } else if (item.type === 'text') {
        const limit = computeLimit(item.text || "", tierName, contextWindowTokens);
        return {
          type: 'text',
          text: compressText(item.text, limit)
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

/**
 * Estimate size of messages array without full JSON serialization
 *
 * Provides a rough size estimation that's much faster than JSON.stringify
 * while being accurate enough for compression statistics.
 *
 * @param {Array} messages - Messages to estimate
 * @returns {number} Estimated size in characters
 */
function estimateMessagesSize(messages) {
  if (!messages || !Array.isArray(messages)) return 0;

  let totalSize = 0;

  for (const msg of messages) {
    // Base overhead for message structure
    totalSize += 50;

    // Role field
    if (msg.role) totalSize += msg.role.length;

    // Content estimation
    if (typeof msg.content === 'string') {
      totalSize += msg.content.length;
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        totalSize += 20; // Block overhead

        if (block.type) totalSize += block.type.length;

        if (block.text) {
          totalSize += block.text.length;
        } else if (block.content) {
          if (typeof block.content === 'string') {
            totalSize += block.content.length;
          } else if (Array.isArray(block.content)) {
            for (const item of block.content) {
              if (typeof item === 'string') {
                totalSize += item.length;
              } else if (item.text) {
                totalSize += item.text.length;
              }
            }
          }
        }

        // Tool use fields
        if (block.name) totalSize += block.name.length;
        if (block.id) totalSize += block.id.length;
        if (block.tool_use_id) totalSize += block.tool_use_id.length;

        // Input estimation (rough)
        if (block.input) {
          totalSize += JSON.stringify(block.input).length;
        }
      }
    }
  }

  return totalSize;
}

module.exports = {
  compressHistory,
  compressMessage,
  compressToolResults,
  calculateCompressionStats,
  needsCompression,
  summarizeOldHistory,
  COMPRESSION_TIERS,
  computeMaxCap,
};
