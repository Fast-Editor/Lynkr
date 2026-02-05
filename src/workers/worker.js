/**
 * Worker Thread Script
 *
 * Handles CPU-intensive tasks offloaded from main thread:
 * - JSON parsing/stringifying
 * - Deep cloning
 * - Message transformation/compression
 *
 * @module workers/worker
 */

const { parentPort } = require('worker_threads');

// ============== Task Handlers ==============

const handlers = {
  /**
   * Parse JSON string
   */
  parse(payload) {
    return JSON.parse(payload);
  },

  /**
   * Stringify object to JSON
   */
  stringify(payload) {
    return JSON.stringify(payload);
  },

  /**
   * Deep clone an object
   * Uses structuredClone when available (faster for complex objects)
   */
  clone(payload) {
    if (typeof structuredClone === 'function') {
      return structuredClone(payload);
    }
    return JSON.parse(JSON.stringify(payload));
  },

  /**
   * Transform/compress messages
   * Applies various optimizations to reduce token count
   */
  transform(payload) {
    const { messages, options = {} } = payload;

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return {
        messages,
        transformed: false,
        stats: { originalCount: 0, transformedCount: 0 },
      };
    }

    const {
      maxAssistantLength = 5000,
      maxToolResultLength = 3000,
      truncateCode = true,
      maxCodeBlockLength = 2000,
      deduplicateToolResults = true,
    } = options;

    let tokensReduced = 0;
    const seenToolResults = new Map(); // For deduplication

    const transformed = messages.map((msg, idx) => {
      if (!msg) return msg;

      // Clone to avoid mutating original
      const result = { ...msg };

      // Truncate long assistant messages
      if (result.role === 'assistant' && typeof result.content === 'string') {
        if (result.content.length > maxAssistantLength) {
          const original = result.content.length;
          result.content = result.content.substring(0, maxAssistantLength) + '\n[...truncated...]';
          tokensReduced += Math.floor((original - maxAssistantLength) / 4);
        }
      }

      // Truncate tool results
      if (result.role === 'tool' && typeof result.content === 'string') {
        // Deduplication check
        if (deduplicateToolResults && result.tool_call_id) {
          const hash = simpleHash(result.content);
          if (seenToolResults.has(hash)) {
            const original = result.content.length;
            result.content = `[Duplicate of previous tool result - see tool_call_id: ${seenToolResults.get(hash)}]`;
            tokensReduced += Math.floor(original / 4);
            return result;
          }
          seenToolResults.set(hash, result.tool_call_id);
        }

        if (result.content.length > maxToolResultLength) {
          const original = result.content.length;
          result.content = truncateToolResult(result.content, maxToolResultLength);
          tokensReduced += Math.floor((original - result.content.length) / 4);
        }
      }

      // Truncate code blocks in user messages
      if (truncateCode && result.role === 'user' && typeof result.content === 'string') {
        result.content = truncateCodeBlocks(result.content, maxCodeBlockLength);
      }

      return result;
    });

    return {
      messages: transformed,
      transformed: true,
      stats: {
        originalCount: messages.length,
        transformedCount: transformed.length,
        tokensReduced,
      },
    };
  },
};

// ============== Helper Functions ==============

/**
 * Simple hash function for deduplication
 */
function simpleHash(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  return hash.toString(36);
}

/**
 * Smart truncation of tool results
 * Preserves structure (JSON, lists) when possible
 */
function truncateToolResult(content, maxLength) {
  if (content.length <= maxLength) return content;

  // Try to parse as JSON and truncate intelligently
  try {
    const parsed = JSON.parse(content);

    if (Array.isArray(parsed)) {
      // Truncate array items
      const kept = [];
      let currentLength = 2; // []
      for (const item of parsed) {
        const itemStr = JSON.stringify(item);
        if (currentLength + itemStr.length + 1 > maxLength - 50) break;
        kept.push(item);
        currentLength += itemStr.length + 1;
      }
      return JSON.stringify(kept) + `\n[...${parsed.length - kept.length} more items truncated...]`;
    }

    if (typeof parsed === 'object' && parsed !== null) {
      // Truncate object properties
      const keys = Object.keys(parsed);
      const truncated = {};
      let currentLength = 2; // {}
      for (const key of keys) {
        const valStr = JSON.stringify(parsed[key]);
        if (currentLength + key.length + valStr.length + 4 > maxLength - 50) break;
        truncated[key] = parsed[key];
        currentLength += key.length + valStr.length + 4;
      }
      return JSON.stringify(truncated, null, 2) + `\n[...${keys.length - Object.keys(truncated).length} properties truncated...]`;
    }
  } catch {
    // Not JSON, fall through to simple truncation
  }

  // Simple truncation with line preservation
  const lines = content.split('\n');
  let result = '';
  for (const line of lines) {
    if (result.length + line.length + 1 > maxLength - 30) break;
    result += line + '\n';
  }

  return result + `\n[...truncated ${content.length - result.length} characters...]`;
}

/**
 * Truncate code blocks in content
 */
function truncateCodeBlocks(content, maxLength) {
  // Match code blocks: ```lang\ncode\n```
  return content.replace(/```(\w*)\n([\s\S]*?)```/g, (match, lang, code) => {
    if (code.length <= maxLength) return match;

    const lines = code.split('\n');
    const keepLines = [];
    let currentLength = 0;

    // Keep first half of allowed lines
    for (let i = 0; i < lines.length && currentLength < maxLength / 2; i++) {
      keepLines.push(lines[i]);
      currentLength += lines[i].length + 1;
    }

    keepLines.push(`\n... [${lines.length - keepLines.length} lines truncated] ...\n`);

    // Keep last few lines
    const lastLines = lines.slice(-3);
    keepLines.push(...lastLines);

    return '```' + lang + '\n' + keepLines.join('\n') + '\n```';
  });
}

// ============== Message Handler ==============

parentPort.on('message', async (msg) => {
  const { taskId, type, payload } = msg;
  const startTime = Date.now();

  try {
    const handler = handlers[type];
    if (!handler) {
      throw new Error(`Unknown task type: ${type}`);
    }

    const result = handler(payload);
    const processingTime = Date.now() - startTime;

    parentPort.postMessage({
      taskId,
      result,
      processingTime,
    });

  } catch (err) {
    parentPort.postMessage({
      taskId,
      error: err.message,
      processingTime: Date.now() - startTime,
    });
  }
});

// Signal ready
parentPort.postMessage({ type: 'ready' });
