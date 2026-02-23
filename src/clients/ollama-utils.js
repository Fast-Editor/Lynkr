const config = require("../config");
const logger = require("../logger");

// Cache for model capabilities
const modelCapabilitiesCache = new Map();

/**
 * Check if a model name indicates a cloud-hosted model.
 * Cloud models follow Ollama's naming convention with "-cloud" in the tag
 * (e.g. "deepseek-v3.1:671b-cloud", "nemotron-3-nano:30b-cloud").
 */
function isCloudModel(modelName) {
  if (!modelName || typeof modelName !== 'string') return false;
  const lower = modelName.toLowerCase();
  // Match cloud indicators in Ollama model naming:
  // - Tag ends with "-cloud" (e.g., "deepseek-v3.1:671b-cloud")
  // - Tag is exactly "cloud" (e.g., "glm-4.7:cloud")
  return lower.endsWith('-cloud') || lower.endsWith(':cloud');
}

/**
 * Get the correct Ollama endpoint for a given model.
 * Cloud models route to OLLAMA_CLOUD_ENDPOINT; local models route to OLLAMA_ENDPOINT.
 * Falls back to the standard endpoint if no cloud endpoint is configured.
 */
function getOllamaEndpointForModel(modelName) {
  if (isCloudModel(modelName) && config.ollama?.cloudEndpoint) {
    return config.ollama.cloudEndpoint;
  }
  if (config.ollama?.endpoint) {
    return config.ollama.endpoint;
  }
  // Cloud-only mode: use cloud endpoint even for non-cloud-named models
  if (config.ollama?.cloudEndpoint) {
    return config.ollama.cloudEndpoint;
  }
  return 'http://localhost:11434';
}

/**
 * Build standard headers for Ollama API requests.
 * Includes Authorization header when OLLAMA_API_KEY is configured.
 * When a cloud endpoint is configured, auth is only sent for cloud models
 * (to avoid leaking keys to local endpoints). When no cloud endpoint is
 * configured, auth is sent to all requests (legacy/single-endpoint behavior).
 */
function getOllamaHeaders(modelName) {
  const headers = { "Content-Type": "application/json" };
  if (config.ollama?.apiKey) {
    // Send auth if: model is cloud, OR no cloud endpoint configured (legacy compat)
    if (isCloudModel(modelName) || !config.ollama?.cloudEndpoint) {
      headers["Authorization"] = `Bearer ${config.ollama.apiKey}`;
    }
  }
  return headers;
}

/**
 * Known models with tool calling support
 */
const TOOL_CAPABLE_MODELS = new Set([
  "llama3.1",
  "llama3.2",
  "qwen2.5",
  "mistral",
  "mistral-nemo",
  "firefunction-v2",
  "kimi-k2.5",
  "nemotron",
  "glm-4",
  "glm4",
  "qwen3",
  "qwen3-coder",
  "deepseek-v3",
  "kimi-k2"
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
 * Extract tool calls from text using the per-model parser registry.
 *
 * Delegates to src/parsers/ — each model family has its own parser class.
 * Falls back to GenericToolParser for unknown models.
 *
 * @param {string} text - Text content that may contain tool calls
 * @param {string} [modelName] - Optional model name for model-specific strategies
 * @returns {object[]|null} - Array of tool call objects in Ollama format, or null if none found
 */
function extractToolCallsFromText(text, modelName) {
  if (!text || typeof text !== 'string') return null;

  const { getParserForModel } = require('../parsers');
  const parser = getParserForModel(modelName);
  return parser.extractToolCallsFromText(text);
}

// Backward-compatible wrapper — returns first match only
function extractToolCallFromText(text, modelName) {
  const results = extractToolCallsFromText(text, modelName);
  return results ? results[0] : null;
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
function convertOllamaToolCallsToAnthropic(ollamaResponse, modelName = null) {
  const message = ollamaResponse?.message || {};
  let toolCalls = message.tool_calls || [];
  let textContent = message.content || "";
  let toolCallsWereExtracted = false;

  // FALLBACK: If no tool_calls but text contains tool calls, parse them
  if (toolCalls.length === 0 && textContent) {
    const extracted = extractToolCallsFromText(textContent, modelName);
    if (extracted && extracted.length > 0) {
      logger.info({
        extractedCount: extracted.length,
        toolNames: extracted.map(tc => tc.function?.name),
        modelName
      }, "Using fallback text parsing for tool calls");
      toolCalls = extracted;
      toolCallsWereExtracted = true;

      // Strip extracted tool calls from text content to prevent double-display
      // This ensures tool results are shown instead of the command text
      textContent = "";
      logger.debug("Stripped tool call text from response to allow tool results display");
    }
  }

  const contentBlocks = [];

  // Add text content if present (will be empty if tool calls were extracted)
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
  const { contentBlocks, stopReason } = convertOllamaToolCallsToAnthropic(ollamaResponse, requestedModel);

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

/**
 * Strip markdown code fences and prompt characters from a command string
 * Exported for universal use in tool call cleaning.
 *
 * @param {string} command - Command that may contain markdown or prompt chars
 * @returns {string} - Cleaned command
 */
function stripMarkdownFromCommand(command) {
  if (!command || typeof command !== 'string') {
    return command;
  }

  let cleaned = command;

  // Check for code fence
  const fenceRe = /```(?:bash|sh|shell|zsh|console|terminal)\s*\n([\s\S]*?)```/i;
  const fenceMatch = command.match(fenceRe);
  if (fenceMatch && fenceMatch[1]) {
    cleaned = fenceMatch[1];
  }

  // Strip prompt characters from each line
  cleaned = cleaned.replace(/^\s*[$#]\s+/gm, '');

  return cleaned.trim();
}

module.exports = {
  checkOllamaToolSupport,
  convertAnthropicToolsToOllama,
  convertOllamaToolCallsToAnthropic,
  buildAnthropicResponseFromOllama,
  modelNameSupportsTools,
  extractToolCallFromText,
  extractToolCallsFromText,
  stripMarkdownFromCommand,
  getOllamaHeaders,
  isCloudModel,
  getOllamaEndpointForModel,
};
