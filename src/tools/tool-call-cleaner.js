/**
 * Universal tool call argument cleaning
 *
 * Delegates to the per-model parser registry for argument cleaning.
 * This module provides the backward-compatible API that the orchestrator calls.
 */

const logger = require('../logger');
const { getParserForModel } = require('../parsers');

// Re-export regex constants from GenericToolParser for test compatibility
const { FENCE_REGEX, BULLET_POINT_REGEX, PROMPT_CHAR_REGEX } = require('../parsers/generic-tool-parser');

/**
 * Strip markdown code fences and prompt characters from a command string.
 * Delegates to GenericToolParser's implementation.
 *
 * @param {string} command - Command that may contain markdown or prompt chars
 * @returns {string} - Cleaned command
 */
function stripMarkdownFromCommand(command) {
  if (!command || typeof command !== 'string') {
    return command;
  }

  let cleaned = command;

  // 1. Check for code fence
  const fenceMatch = command.match(FENCE_REGEX);
  if (fenceMatch && fenceMatch[1]) {
    cleaned = fenceMatch[1];
  }

  // 2. Strip bullet points at line start
  cleaned = cleaned.replace(BULLET_POINT_REGEX, '');

  // 3. Strip prompt characters from each line
  cleaned = cleaned.replace(PROMPT_CHAR_REGEX, '');

  return cleaned.trim();
}

/**
 * Clean tool call arguments by extracting from markdown/formatting.
 * Delegates to the appropriate parser's cleanArguments method.
 *
 * @param {object} toolCall - Tool call in Anthropic/OpenAI format
 * @param {string} [modelName] - Optional model name for model-specific cleaning
 * @returns {object} - Cleaned tool call (may be same object if no cleaning needed)
 */
function cleanToolCallArguments(toolCall, modelName) {
  if (!toolCall) return toolCall;

  const parser = getParserForModel(modelName);
  return parser.cleanArguments(toolCall);
}

/**
 * Clean an array of tool calls.
 *
 * @param {object[]} toolCalls - Array of tool calls
 * @param {string} [modelName] - Optional model name for model-specific cleaning
 * @returns {object[]} - Array of cleaned tool calls
 */
function cleanToolCalls(toolCalls, modelName) {
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) {
    return toolCalls;
  }

  const parser = getParserForModel(modelName);
  let cleanedCount = 0;

  const cleaned = toolCalls.map(call => {
    const cleanedCall = parser.cleanArguments(call);
    if (cleanedCall !== call) cleanedCount++;
    return cleanedCall;
  });

  if (cleanedCount > 0) {
    logger.info({
      totalCalls: toolCalls.length,
      cleanedCalls: cleanedCount,
      tools: cleaned.map(tc => tc.name ?? tc.function?.name),
      parser: parser.constructor.name,
    }, 'Universal tool call cleaning applied (via parser)');
  }

  return cleaned;
}

module.exports = {
  cleanToolCallArguments,
  cleanToolCalls,
  stripMarkdownFromCommand,
  // Export regex for testing
  FENCE_REGEX,
  BULLET_POINT_REGEX,
  PROMPT_CHAR_REGEX
};
