/**
 * Codex Format Conversion Utilities
 *
 * Converts between Anthropic/Lynkr internal message format
 * and Codex app-server JSON-RPC format.
 *
 * @module clients/codex-utils
 */

const logger = require("../logger");

/**
 * Extract text content from Anthropic message format
 * Handles both string content and content block arrays
 */
function extractText(message) {
  if (!message) return "";
  const content = message.content;

  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .map((block) => {
      if (block.type === "text") return block.text || "";
      if (block.type === "tool_result") {
        const result = typeof block.content === "string"
          ? block.content
          : JSON.stringify(block.content);
        return `[Tool Result: ${result}]`;
      }
      if (block.type === "tool_use") {
        return `[Tool Call: ${block.name}(${JSON.stringify(block.input)})]`;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

/**
 * Convert Anthropic request body to a Codex turn prompt
 *
 * Strategy: Codex turn/start takes a simple text prompt.
 * We flatten system + message history into a single prompt.
 *
 * @param {Object} body - Lynkr internal body (Anthropic format)
 * @returns {{ prompt: string, systemContext: string|null }}
 */
function convertAnthropicToCodexPrompt(body) {
  const systemContext = body.system || null;
  const messages = body.messages || [];

  if (messages.length === 0) {
    return { prompt: "", systemContext };
  }

  // If only one user message, use it directly
  if (messages.length === 1 && messages[0].role === "user") {
    return {
      prompt: extractText(messages[0]),
      systemContext,
    };
  }

  // Multiple messages — flatten into a conversation prompt
  // Keep last user message as the main prompt
  // Include prior messages as context
  const lastUserIndex = findLastIndex(messages, (m) => m.role === "user");
  if (lastUserIndex === -1) {
    return { prompt: extractText(messages[messages.length - 1]), systemContext };
  }

  const lastUserMessage = extractText(messages[lastUserIndex]);

  // Build context from prior messages
  const priorMessages = messages.slice(0, lastUserIndex);
  if (priorMessages.length === 0) {
    return { prompt: lastUserMessage, systemContext };
  }

  const contextParts = priorMessages.map((m) => {
    const text = extractText(m);
    if (!text) return null;
    const role = m.role === "user" ? "User" : "Assistant";
    return `${role}: ${text}`;
  }).filter(Boolean);

  const conversationContext = contextParts.join("\n\n");

  // Combine context + latest question
  const prompt = conversationContext
    ? `Previous conversation:\n${conversationContext}\n\nUser: ${lastUserMessage}`
    : lastUserMessage;

  return { prompt, systemContext };
}

/**
 * Convert Codex turn response to Anthropic message format
 *
 * @param {Object} turnResult - { text, turnId, raw }
 * @param {string} model - Model name to include in response
 * @returns {Object} Anthropic format response
 */
function convertCodexResponseToAnthropic(turnResult, model) {
  const text = turnResult.text || "";

  // Estimate tokens (rough: 1 token ≈ 4 chars)
  const estimatedOutputTokens = Math.ceil(text.length / 4);

  return {
    id: `msg_codex_${Date.now()}`,
    type: "message",
    role: "assistant",
    model: model || "codex",
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: 0, // Codex doesn't report these via app-server
      output_tokens: estimatedOutputTokens,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  };
}

/**
 * Array.findLastIndex polyfill
 */
function findLastIndex(arr, fn) {
  for (let i = arr.length - 1; i >= 0; i--) {
    if (fn(arr[i])) return i;
  }
  return -1;
}

module.exports = {
  convertAnthropicToCodexPrompt,
  convertCodexResponseToAnthropic,
  extractText,
};
