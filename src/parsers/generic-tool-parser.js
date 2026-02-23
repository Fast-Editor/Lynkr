/**
 * Generic (fallback) tool parser.
 *
 * Handles JSON tool call extraction and markdown argument cleaning.
 * Used for any model that doesn't have a dedicated parser.
 */
const BaseToolParser = require('./base-tool-parser');
const logger = require('../logger');

// Shared regex for shell command validation
const SHELL_COMMAND_RE = /^(git|ls|cd|cat|head|tail|grep|find|mkdir|rm|cp|mv|pwd|echo|curl|wget|npm|node|python|pip|docker|kubectl|make|go|cargo|rustc)\b/;

// Markdown cleaning regex (used in cleanArguments)
const FENCE_REGEX = /```(?:bash|sh|shell|zsh|console|terminal)\s*\n([\s\S]*?)```/i;
const BULLET_POINT_REGEX = /^\s*[●•\-\*❯>]\s+/gm;
const PROMPT_CHAR_REGEX = /^\s*[$#]\s+/gm;

class GenericToolParser extends BaseToolParser {
  /**
   * Extract tool calls from text using JSON detection.
   * Looks for {"name": "...", "parameters": {...}} patterns.
   */
  extractToolCallsFromText(text) {
    if (!text || typeof text !== 'string') return null;
    return this._jsonToolCall(text);
  }

  /**
   * Clean a tool call's arguments by stripping markdown formatting.
   * Currently handles Bash tool command cleanup.
   */
  cleanArguments(toolCall) {
    if (!toolCall) return toolCall;

    const toolName = toolCall.name ?? toolCall.function?.name;
    if (toolName !== 'Bash') return toolCall;

    // Handle Anthropic format
    if (toolCall.input?.command && typeof toolCall.input.command === 'string') {
      const cleaned = this._stripMarkdownFromCommand(toolCall.input.command);
      if (cleaned !== toolCall.input.command) {
        return { ...toolCall, input: { ...toolCall.input, command: cleaned } };
      }
      return toolCall;
    }

    // Handle OpenAI format
    if (toolCall.function?.arguments) {
      const args = typeof toolCall.function.arguments === 'string'
        ? JSON.parse(toolCall.function.arguments)
        : toolCall.function.arguments;
      if (args?.command && typeof args.command === 'string') {
        const cleaned = this._stripMarkdownFromCommand(args.command);
        if (cleaned !== args.command) {
          return {
            ...toolCall,
            function: {
              ...toolCall.function,
              arguments: JSON.stringify({ ...args, command: cleaned })
            }
          };
        }
      }
    }

    return toolCall;
  }

  // -- Private helpers -------------------------------------------------------

  /**
   * JSON tool call extraction: {"name": "...", "parameters": {...}}
   */
  _jsonToolCall(text) {
    const startMatch = text.match(/\{\s*"name"\s*:/);
    if (!startMatch) return null;

    const startIdx = startMatch.index;
    let braceCount = 0;
    let endIdx = -1;
    for (let i = startIdx; i < text.length; i++) {
      if (text[i] === '{') braceCount++;
      else if (text[i] === '}') {
        braceCount--;
        if (braceCount === 0) { endIdx = i + 1; break; }
      }
    }
    if (endIdx === -1) return null;

    try {
      const parsed = JSON.parse(text.substring(startIdx, endIdx));
      if (parsed.name && parsed.parameters) {
        logger.info({ toolName: parsed.name }, 'GenericToolParser: JSON tool call extracted');
        return [{ function: { name: parsed.name, arguments: parsed.parameters } }];
      }
    } catch (e) {
      logger.debug({ error: e.message }, 'GenericToolParser: JSON parse failed');
    }
    return null;
  }

  /**
   * Strip markdown code fences, bullet points, and prompt characters.
   */
  _stripMarkdownFromCommand(command) {
    if (!command || typeof command !== 'string') return command;

    let cleaned = command;

    // Code fence extraction
    const fenceMatch = command.match(FENCE_REGEX);
    if (fenceMatch && fenceMatch[1]) {
      cleaned = fenceMatch[1];
    }

    // Bullet points
    cleaned = cleaned.replace(BULLET_POINT_REGEX, '');

    // Prompt characters
    cleaned = cleaned.replace(PROMPT_CHAR_REGEX, '');

    return cleaned.trim();
  }
}

// Export the class and shared constants for testing
module.exports = GenericToolParser;
module.exports.SHELL_COMMAND_RE = SHELL_COMMAND_RE;
module.exports.FENCE_REGEX = FENCE_REGEX;
module.exports.BULLET_POINT_REGEX = BULLET_POINT_REGEX;
module.exports.PROMPT_CHAR_REGEX = PROMPT_CHAR_REGEX;
