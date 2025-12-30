const logger = require("../logger");
const config = require("../config");

const TRUNCATION_LIMITS = {
  Read: { maxChars: 8000, strategy: 'middle' },
  Bash: { maxChars: 30000, strategy: 'tail' },
  Grep: { maxChars: 12000, strategy: 'head' },
  Glob: { maxChars: 8000, strategy: 'head' },
  WebFetch: { maxChars: 16000, strategy: 'head' },
  WebSearch: { maxChars: 12000, strategy: 'head' },
  LSP: { maxChars: 8000, strategy: 'head' },
  Edit: { maxChars: 8000, strategy: 'middle' },
  Write: { maxChars: 8000, strategy: 'middle' },
  Task: { maxChars: 20000, strategy: 'tail' },
  AgentTask: { maxChars: 20000, strategy: 'tail' },
};

/**
 * Apply truncation strategy to text
 */
function applyTruncationStrategy(text, maxChars, strategy) {
  if (text.length <= maxChars) {
    return text;
  }

  switch (strategy) {
    case 'head':
      // Keep beginning
      return text.slice(0, maxChars);

    case 'tail':
      // Keep end
      return text.slice(-maxChars);

    case 'middle': {
      // Keep start and end, remove middle
      const keepSize = Math.floor(maxChars / 2);
      const start = text.slice(0, keepSize);
      const end = text.slice(-keepSize);
      const removed = text.length - (keepSize * 2);
      return `${start}\n\n... [${removed} characters truncated for token efficiency] ...\n\n${end}`;
    }

    default:
      return text.slice(0, maxChars);
  }
}

/**
 * Truncate tool output based on tool type
 */
function truncateToolOutput(toolName, output) {
  // Skip if truncation disabled
  if (config.toolTruncation?.enabled === false) {
    return output;
  }

  if (!output || typeof output !== 'string') {
    return output;
  }

  const limit = TRUNCATION_LIMITS[toolName];
  if (!limit) {
    // No truncation for unknown tools
    return output;
  }

  if (output.length <= limit.maxChars) {
    return output;
  }

  const truncated = applyTruncationStrategy(output, limit.maxChars, limit.strategy);
  const removed = output.length - truncated.length;

  logger.debug({
    tool: toolName,
    originalLength: output.length,
    truncatedLength: truncated.length,
    removed,
    strategy: limit.strategy
  }, 'Truncated tool output for token efficiency');

  return truncated;
}

/**
 * Get truncation limit for a specific tool
 */
function getTruncationLimit(toolName) {
  return TRUNCATION_LIMITS[toolName] || null;
}

/**
 * Update truncation limit for a tool (useful for testing)
 */
function setTruncationLimit(toolName, maxChars, strategy = 'head') {
  TRUNCATION_LIMITS[toolName] = { maxChars, strategy };
}

module.exports = {
  truncateToolOutput,
  getTruncationLimit,
  setTruncationLimit,
  TRUNCATION_LIMITS
};
