/**
 * Abstract base class for per-model tool parsers.
 *
 * Inspired by vLLM's ToolParser hierarchy — each model family gets its own
 * subclass that owns all regex patterns, tag detection, and argument parsing.
 *
 * Subclasses MUST override at least `extractToolCallsFromText`.
 */
class BaseToolParser {
  /**
   * @param {string} modelName - Full model name (e.g. "glm-4.7:cloud")
   */
  constructor(modelName) {
    this.modelName = modelName;
  }

  /**
   * Parse tool calls from raw text when the model outputs text instead of
   * native tool_calls.
   *
   * @param {string} text - Raw assistant text
   * @returns {object[]|null} Array of Ollama-format tool call objects, or null
   *   Each element: { function: { name, arguments } }
   */
  extractToolCallsFromText(text) {
    throw new Error(`${this.constructor.name} must implement extractToolCallsFromText`);
  }

  /**
   * Normalize / fix native tool_calls from the Ollama response.
   * Default implementation is identity (pass-through).
   *
   * @param {object[]} toolCalls - Ollama-format tool_calls array
   * @returns {object[]} Cleaned tool calls
   */
  normalizeToolCalls(toolCalls) {
    return toolCalls;
  }

  /**
   * Clean a single tool call's arguments (strip markdown, fix formatting).
   * Default: pass-through.
   *
   * @param {object} toolCall - Single tool call (Anthropic or OpenAI format)
   * @returns {object} Cleaned tool call
   */
  cleanArguments(toolCall) {
    return toolCall;
  }

  /**
   * Strip model-specific reasoning tags (e.g. <think> for DeepSeek/Qwen).
   * Default strips the universal <think>...</think> pattern.
   *
   * @param {string} text
   * @returns {string}
   */
  stripReasoningTags(text) {
    if (typeof text !== 'string') return text;
    return text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  }
}

module.exports = BaseToolParser;
