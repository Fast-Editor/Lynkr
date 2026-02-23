/**
 * GLM-4.7 tool parser.
 *
 * Handles GLM-4.7's native XML tool call format:
 *   <tool_call>funcname
 *   <arg_key>key</arg_key>
 *   <arg_value>value</arg_value>
 *   </tool_call>
 *
 * Also handles GLM's common fallback patterns:
 *   - Bullet-point shell commands
 *   - Fenced code block shell commands
 *
 * Based on vLLM's glm4_tool_parser.py
 */
const BaseToolParser = require('./base-tool-parser');
const logger = require('../logger');

// Shared constants from generic parser
const { SHELL_COMMAND_RE, FENCE_REGEX, BULLET_POINT_REGEX, PROMPT_CHAR_REGEX } = require('./generic-tool-parser');

// GLM-4.7 XML format regex
const TOOL_CALL_BLOCK_RE = /<tool_call>([\s\S]*?)<\/tool_call>/g;
const ARG_PAIR_RE = /<arg_key>([\s\S]*?)<\/arg_key>\s*<arg_value>([\s\S]*?)<\/arg_value>/g;

// Orphaned closing tags that GLM-4.7 leaks into content when it fails to produce
// proper tool_calls (e.g. "Invoking tool(s): Grep</arg_value>").
// Also catches orphaned </think> from reasoning tag leaks.
const ORPHAN_CLOSING_TAG_RE = /<\/(?:arg_value|arg_key|tool_call|think)>/g;

// Fenced code block regex (for fallback extraction)
const FENCED_BLOCK_RE = /```(?:bash|sh|shell|zsh|console|terminal)\s*\n([\s\S]*?)```/gi;

class Glm47ToolParser extends BaseToolParser {
  /**
   * Extract tool calls from GLM-4.7 text output.
   *
   * Strategy order:
   *   1. GLM XML format (<tool_call>...) — model's native non-API tool format
   *   2. Bullet-point shell commands
   *   3. Fenced code block shell commands
   */
  extractToolCallsFromText(text) {
    if (!text || typeof text !== 'string') return null;

    // Strip reasoning tags (<think>...</think>) and orphaned closing tags
    // that GLM-4.7 leaks into content (e.g. "</arg_value>", "</think>").
    // Must happen before extraction — these fragments break regex matching
    // and pollute "Invoking tool(s):" text detection downstream.
    // stripReasoningTags handles both complete pairs AND orphaned closers.
    const cleaned = this.stripReasoningTags(text);

    // 1. Try GLM XML tool call format
    const xmlResults = this._extractXmlToolCalls(cleaned);
    if (xmlResults) return xmlResults;

    // 2. Try bullet-point commands
    const bulletResults = this._extractBulletPointCommands(cleaned);
    if (bulletResults) return bulletResults;

    // 3. Try fenced code block commands
    const fencedResults = this._extractFencedCodeBlockCommands(cleaned);
    if (fencedResults) return fencedResults;

    return null;
  }

  /**
   * Clean Bash tool arguments by stripping markdown formatting.
   */
  cleanArguments(toolCall) {
    if (!toolCall) return toolCall;

    const toolName = toolCall.name ?? toolCall.function?.name;
    if (toolName !== 'Bash') return toolCall;

    // Anthropic format
    if (toolCall.input?.command && typeof toolCall.input.command === 'string') {
      const cleaned = this._stripMarkdownFromCommand(toolCall.input.command);
      if (cleaned !== toolCall.input.command) {
        return { ...toolCall, input: { ...toolCall.input, command: cleaned } };
      }
      return toolCall;
    }

    // OpenAI format
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

  /**
   * Override: strip <think> tags AND orphaned GLM closing tags from text.
   */
  stripReasoningTags(text) {
    if (typeof text !== 'string') return text;
    // First strip complete <think>...</think> blocks (base behavior)
    let cleaned = text.replace(/<think>[\s\S]*?<\/think>/g, '');
    // Then strip orphaned closing tags specific to GLM
    cleaned = this._stripOrphanedClosingTags(cleaned);
    return cleaned.trim();
  }

  // -- Private: orphaned tag stripping ----------------------------------------

  /**
   * Strip orphaned closing tags that GLM-4.7 leaks into content.
   * Only removes a closing tag if its matching opener is NOT present in the text.
   * E.g. "Grep</arg_value>" → "Grep", but "<arg_value>val</arg_value>" stays intact.
   */
  _stripOrphanedClosingTags(text) {
    return text.replace(ORPHAN_CLOSING_TAG_RE, (match) => {
      // Extract tag name from </tagname>
      const tagName = match.slice(2, -1);
      const opener = `<${tagName}>`;
      // If the opener exists, this closing tag is NOT orphaned — keep it
      if (text.includes(opener)) return match;
      // Orphaned — strip it
      return '';
    }).trim();
  }

  // -- Private: GLM XML extraction -------------------------------------------

  _extractXmlToolCalls(text) {
    if (!text.includes('<tool_call>')) return null;

    TOOL_CALL_BLOCK_RE.lastIndex = 0;
    const results = [];
    let match;

    while ((match = TOOL_CALL_BLOCK_RE.exec(text)) !== null) {
      const block = match[1].trim();
      const parsed = this._parseXmlToolCallBlock(block);
      if (parsed) results.push(parsed);
    }

    if (results.length > 0) {
      logger.info({
        count: results.length,
        toolNames: results.map(r => r.function.name),
      }, 'Glm47ToolParser: XML tool calls extracted');
      return results;
    }
    return null;
  }

  /**
   * Parse a single <tool_call> block body.
   * Format: funcname\n<arg_key>key</arg_key>\n<arg_value>value</arg_value>\n...
   */
  _parseXmlToolCallBlock(block) {
    // Function name is the first line (before any <arg_key>)
    const firstTagIdx = block.indexOf('<arg_key>');
    let funcName;
    let argsText;

    if (firstTagIdx === -1) {
      // No arguments — entire block is the function name
      funcName = block.trim();
      argsText = '';
    } else {
      funcName = block.substring(0, firstTagIdx).trim();
      argsText = block.substring(firstTagIdx);
    }

    if (!funcName) return null;

    // Extract key-value pairs
    const args = {};
    ARG_PAIR_RE.lastIndex = 0;
    let argMatch;
    while ((argMatch = ARG_PAIR_RE.exec(argsText)) !== null) {
      const key = argMatch[1].trim();
      let value = argMatch[2];
      // Trim leading/trailing newlines (vLLM convention)
      if (value.startsWith('\n')) value = value.substring(1);
      if (value.endsWith('\n')) value = value.slice(0, -1);
      args[key] = value;
    }

    return {
      function: {
        name: funcName,
        arguments: args,
      }
    };
  }

  // -- Private: bullet-point extraction --------------------------------------

  _extractBulletPointCommands(text) {
    const results = [];
    const lines = text.split('\n');
    for (const line of lines) {
      const match = line.match(/^\s*[●•\-*❯>]\s+(.+)$/);
      if (match) {
        const command = match[1].trim();
        if (SHELL_COMMAND_RE.test(command)) {
          results.push({ function: { name: 'Bash', arguments: { command } } });
        }
      }
    }
    if (results.length > 0) {
      logger.info({ count: results.length }, 'Glm47ToolParser: bullet-point commands extracted');
      return results;
    }
    return null;
  }

  // -- Private: fenced code block extraction ---------------------------------

  _extractFencedCodeBlockCommands(text) {
    FENCED_BLOCK_RE.lastIndex = 0;
    const results = [];
    let fenceMatch;
    while ((fenceMatch = FENCED_BLOCK_RE.exec(text)) !== null) {
      const blockContent = fenceMatch[1];
      for (const line of blockContent.split('\n')) {
        const cleaned = line.replace(/^\s*[$#]\s*/, '').trim();
        if (!cleaned) continue;
        if (SHELL_COMMAND_RE.test(cleaned)) {
          results.push({ function: { name: 'Bash', arguments: { command: cleaned } } });
        }
      }
    }
    if (results.length > 0) {
      logger.info({ count: results.length }, 'Glm47ToolParser: fenced code block commands extracted');
      return results;
    }
    return null;
  }

  // -- Private: markdown stripping -------------------------------------------

  _stripMarkdownFromCommand(command) {
    if (!command || typeof command !== 'string') return command;

    let cleaned = command;
    const fenceMatch = command.match(FENCE_REGEX);
    if (fenceMatch && fenceMatch[1]) cleaned = fenceMatch[1];

    cleaned = cleaned.replace(BULLET_POINT_REGEX, '');
    cleaned = cleaned.replace(PROMPT_CHAR_REGEX, '');

    return cleaned.trim();
  }
}

module.exports = Glm47ToolParser;
