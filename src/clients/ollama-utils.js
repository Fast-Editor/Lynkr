const config = require("../config");
const logger = require("../logger");

// Cache for model capabilities
const modelCapabilitiesCache = new Map();

/**
 * Known models with tool calling support
 */
const TOOL_CAPABLE_MODELS = new Set([
  "llama3.1",
  "llama3.2",
  "llama3.3",
  "qwen2.5",
  "qwen3",
  "mistral",
  "mistral-nemo",
  "firefunction-v2",
  "kimi-k2.5",
  "nemotron",
  "glm-4",
  "glm-4.5",
  "glm-4.7",
  "glm-5",
  "gpt-oss",
  "minimax",
  "deepseek-r1",
]);

/**
 * Check if a model name indicates tool support
 */
function modelNameSupportsTools(modelName) {
  if (!modelName) return false;

  const normalized = modelName.toLowerCase();

  // Check if model name starts with any known tool-capable model
  return Array.from(TOOL_CAPABLE_MODELS).some(prefix =>
    normalized.startsWith(prefix)
  );
}

/**
 * Check if Ollama model supports tool calling
 * Uses heuristics and caching to avoid repeated API calls
 */
async function checkOllamaToolSupport(modelName = config.ollama?.model) {
  if (!modelName) return false;

  // Check cache
  if (modelCapabilitiesCache.has(modelName)) {
    return modelCapabilitiesCache.get(modelName);
  }

  // Quick heuristic check based on model name
  const supportsTools = modelNameSupportsTools(modelName);

  logger.debug({ modelName, supportsTools }, "Ollama tool support check");

  // Cache the result
  modelCapabilitiesCache.set(modelName, supportsTools);

  return supportsTools;
}

/**
 * Convert Anthropic tool format to Ollama format
 *
 * Anthropic format:
 * {
 *   name: "get_weather",
 *   description: "Get weather",
 *   input_schema: { type: "object", properties: {...}, required: [...] }
 * }
 *
 * Ollama format:
 * {
 *   type: "function",
 *   function: {
 *     name: "get_weather",
 *     description: "Get weather",
 *     parameters: { type: "object", properties: {...}, required: [...] }
 *   }
 * }
 */
function convertAnthropicToolsToOllama(anthropicTools) {
  if (!Array.isArray(anthropicTools) || anthropicTools.length === 0) {
    return [];
  }

  return anthropicTools.map(tool => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description || "",
      parameters: tool.input_schema || {
        type: "object",
        properties: {},
      },
    },
  }));
}

/**
 * Convert Ollama tool call response to Anthropic format
 *
 * Ollama format (actual):
 * {
 *   message: {
 *     role: "assistant",
 *     content: "",
 *     tool_calls: [{
 *       function: {
 *         name: "get_weather",
 *         arguments: { location: "SF" }  // Already parsed object
 *       }
 *     }]
 *   }
 * }
 *
 * Anthropic format:
 * {
 *   content: [{
 *     type: "tool_use",
 *     id: "toolu_123",
 *     name: "get_weather",
 *     input: { location: "SF" }
 *   }],
 *   stop_reason: "tool_use"
 * }
 */
function convertOllamaToolCallsToAnthropic(ollamaResponse) {
  const message = ollamaResponse?.message || {};
  const toolCalls = message.tool_calls || [];
  const textContent = message.content || "";

  const contentBlocks = [];

  // Add text content if present
  if (textContent && textContent.trim()) {
    contentBlocks.push({
      type: "text",
      text: textContent,
    });
  }

  // Add tool calls
  for (const toolCall of toolCalls) {
    const func = toolCall.function || {};
    let input = {};

    // Handle arguments - can be string JSON or already parsed object
    if (func.arguments) {
      if (typeof func.arguments === "string") {
        try {
          input = JSON.parse(func.arguments);
        } catch (err) {
          logger.warn({
            error: err.message,
            arguments: func.arguments
          }, "Failed to parse Ollama tool arguments string");
          input = {};
        }
      } else if (typeof func.arguments === "object") {
        // Already an object, use directly
        input = func.arguments;
      }
    }

    // Generate tool use ID (Ollama may or may not provide one)
    const toolUseId = toolCall.id || `toolu_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    contentBlocks.push({
      type: "tool_use",
      id: toolUseId,
      name: func.name || "unknown",
      input,
    });
  }

  // Determine stop reason
  const stopReason = toolCalls.length > 0 ? "tool_use" : "end_turn";

  return {
    contentBlocks,
    stopReason,
  };
}

/**
 * Build complete Anthropic response from Ollama with tool calls
 */
function buildAnthropicResponseFromOllama(ollamaResponse, requestedModel) {
  const { contentBlocks, stopReason } = convertOllamaToolCallsToAnthropic(ollamaResponse);

  // Ensure at least one content block
  const finalContent = contentBlocks.length > 0
    ? contentBlocks
    : [{ type: "text", text: "" }];

  // Extract token counts
  const inputTokens = ollamaResponse.prompt_eval_count || 0;
  const outputTokens = ollamaResponse.eval_count || 0;

  return {
    id: `msg_${Date.now()}`,
    type: "message",
    role: "assistant",
    model: requestedModel,
    content: finalContent,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  };
}

module.exports = {
  checkOllamaToolSupport,
  convertAnthropicToolsToOllama,
  convertOllamaToolCallsToAnthropic,
  buildAnthropicResponseFromOllama,
  modelNameSupportsTools,
};
