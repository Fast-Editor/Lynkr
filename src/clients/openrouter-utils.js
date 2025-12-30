const logger = require("../logger");

/**
 * Convert Anthropic tool format to OpenAI/OpenRouter format
 *
 * Anthropic format:
 * {
 *   name: "get_weather",
 *   description: "Get weather",
 *   input_schema: { type: "object", properties: {...}, required: [...] }
 * }
 *
 * OpenRouter format:
 * {
 *   type: "function",
 *   function: {
 *     name: "get_weather",
 *     description: "Get weather",
 *     parameters: { type: "object", properties: {...}, required: [...] }
 *   }
 * }
 */
function convertAnthropicToolsToOpenRouter(anthropicTools) {
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
        required: []
      }
    }
  }));
}

/**
 * Convert Anthropic messages to OpenAI/OpenRouter format
 *
 * Anthropic format:
 * - Assistant messages with tool_use blocks → OpenRouter assistant with tool_calls
 * - User messages with tool_result blocks → OpenRouter tool role messages
 * - Regular text content → OpenRouter text content
 */
function convertAnthropicMessagesToOpenRouter(anthropicMessages) {
  if (!Array.isArray(anthropicMessages)) return [];

  const logger = require("../logger");
  const converted = [];

  for (const msg of anthropicMessages) {
    let content = msg.content;

    // Handle array of content blocks
    if (Array.isArray(content)) {
      const textBlocks = content.filter(block => block.type === 'text');
      const toolUseBlocks = content.filter(block => block.type === 'tool_use');
      const toolResultBlocks = content.filter(block => block.type === 'tool_result');

      logger.debug({
        role: msg.role,
        contentIsArray: true,
        contentLength: content.length,
        blockTypes: content.map(b => b.type),
        textCount: textBlocks.length,
        toolUseCount: toolUseBlocks.length,
        toolResultCount: toolResultBlocks.length
      }, "Processing Anthropic message");

      // Assistant message with tool calls
      if (msg.role === 'assistant' && toolUseBlocks.length > 0) {
        const textContent = textBlocks.map(block => block.text || '').join('\n');
        const tool_calls = toolUseBlocks.map(block => ({
          id: block.id || `call_${Date.now()}`,
          type: 'function',
          function: {
            name: block.name || 'unknown',
            arguments: JSON.stringify(block.input || {})
          }
        }));

        const message = {
          role: 'assistant',
          tool_calls
        };

        // Only add content if there's actual text, otherwise omit the field entirely
        // Some providers require content to be present, so use empty string as fallback
        if (textContent && textContent.trim()) {
          message.content = textContent;
        } else {
          message.content = '';
        }

        converted.push(message);
      }
      // User message with tool results
      else if (msg.role === 'user' && toolResultBlocks.length > 0) {
        // Add text content as user message first if present
        const textContent = textBlocks.map(block => block.text || '').join('\n');
        if (textContent) {
          converted.push({
            role: 'user',
            content: textContent
          });
        }

        // Add each tool result as a separate tool message
        for (const toolResult of toolResultBlocks) {
          converted.push({
            role: 'tool',
            tool_call_id: toolResult.tool_use_id || `call_${Date.now()}`,
            content: typeof toolResult.content === 'string'
              ? toolResult.content
              : JSON.stringify(toolResult.content || {})
          });
        }
      }
      // Regular message with just text
      else {
        const textContent = textBlocks.map(block => block.text || '').join('\n');
        converted.push({
          role: msg.role,
          content: textContent || ''
        });
      }
    }
    // Simple string content
    else {
      logger.debug({
        role: msg.role,
        contentIsArray: false,
        contentType: typeof content,
        contentLength: content?.length || 0
      }, "Processing Anthropic message (string content)");

      converted.push({
        role: msg.role,
        content: content || ''
      });
    }
  }

  // Validate message sequence: tool messages must follow assistant messages with tool_calls
  for (let i = 0; i < converted.length; i++) {
    const msg = converted[i];
    if (msg.role === 'tool') {
      // Find the preceding assistant message with tool_calls
      let foundMatchingToolCall = false;
      for (let j = i - 1; j >= 0; j--) {
        const prevMsg = converted[j];
        if (prevMsg.role === 'assistant' && Array.isArray(prevMsg.tool_calls)) {
          // Check if this tool result matches any of the tool calls
          if (prevMsg.tool_calls.some(tc => tc.id === msg.tool_call_id)) {
            foundMatchingToolCall = true;
            break;
          }
        }
        // Stop if we hit another user message
        if (prevMsg.role === 'user') break;
      }

      if (!foundMatchingToolCall) {
        logger.warn({
          messageIndex: i,
          toolCallId: msg.tool_call_id,
          precedingMessages: converted.slice(Math.max(0, i - 3), i).map(m => ({
            role: m.role,
            hasToolCalls: !!m.tool_calls,
            toolCallIds: m.tool_calls?.map(tc => tc.id)
          }))
        }, "Orphaned tool message detected - removing from sequence");

        // Remove the orphaned tool message
        converted.splice(i, 1);
        i--; // Adjust index after removal
      }
    }
  }

  // Log the converted messages for debugging
  logger.debug({
    inputCount: anthropicMessages.length,
    outputCount: converted.length,
    converted: converted.map((m, i) => ({
      index: i,
      role: m.role,
      hasContent: !!m.content,
      contentLength: m.content?.length || 0,
      hasToolCalls: !!m.tool_calls,
      toolCallsCount: m.tool_calls?.length || 0,
      hasToolCallId: !!m.tool_call_id
    }))
  }, "OpenRouter message conversion");

  return converted;
}

/**
 * Convert OpenRouter response to Anthropic format
 *
 * OpenRouter format:
 * {
 *   id: "chatcmpl-123",
 *   choices: [{
 *     message: {
 *       role: "assistant",
 *       content: "Hello",
 *       tool_calls: [{
 *         id: "call_abc123",
 *         type: "function",
 *         function: { name: "get_weather", arguments: "{...}" }
 *       }]
 *     },
 *     finish_reason: "stop"
 *   }],
 *   usage: { prompt_tokens: 10, completion_tokens: 20 }
 * }
 *
 * Anthropic format:
 * {
 *   id: "msg_123",
 *   type: "message",
 *   role: "assistant",
 *   content: [
 *     { type: "text", text: "Hello" },
 *     { type: "tool_use", id: "toolu_123", name: "get_weather", input: {...} }
 *   ],
 *   stop_reason: "tool_use",
 *   usage: { input_tokens: 10, output_tokens: 20 }
 * }
 */
function convertOpenRouterResponseToAnthropic(openRouterResponse, requestedModel) {
  const choice = openRouterResponse.choices?.[0];
  if (!choice) {
    throw new Error("No choices in OpenRouter response");
  }

  const message = choice.message || {};
  const contentBlocks = [];

  // Check if there are tool calls present
  const hasToolCalls = Array.isArray(message.tool_calls) && message.tool_calls.length > 0;

  // Helper function to detect if content is a JSON representation of a tool call
  // Some models (like llama.cpp) may output tool calls in both content AND tool_calls
  const isToolCallJson = (text) => {
    if (!text) return false;
    const trimmed = text.trim();
    // Check if it looks like a JSON object containing tool/function call
    // Matches various formats:
    // - {"type": "function", "function": {"name": "X", "parameters": {...}}}
    // - {"function": "X", "parameters": {...}}
    // - {"tool": "X", "input": {...}}
    return (trimmed.startsWith('{') || trimmed.startsWith('[')) &&
           (trimmed.includes('"function"') || trimmed.includes('"tool"') ||
            (trimmed.includes('"type"') && trimmed.includes('"parameters"'))) &&
           (trimmed.includes('"parameters"') || trimmed.includes('"input"') ||
            trimmed.includes('"arguments"'));
  };

  // Add text content if present, but skip if it's a duplicate/malformed tool call JSON
  if (message.content && message.content.trim()) {
    const looksLikeToolJson = isToolCallJson(message.content);

    // Skip content in two cases:
    // 1. We have proper tool_calls AND content duplicates them (original fix)
    // 2. Content looks like tool call JSON but we DON'T have tool_calls
    //    (model incorrectly output JSON instead of structured tool_calls)
    if (looksLikeToolJson) {
      if (hasToolCalls) {
        // Case 1: Duplicate - model provided both content and tool_calls
        logger.debug({
          contentPreview: message.content.substring(0, 100),
          toolCallCount: message.tool_calls.length
        }, "Skipping text content that duplicates tool_calls (llama.cpp quirk)");
      } else {
        // Case 2: Malformed - model only provided JSON in content, not structured tool_calls
        // This is a model error - it should have used tool_calls, not raw JSON
        logger.warn({
          contentPreview: message.content.substring(0, 200)
        }, "Model output tool call as JSON text instead of structured tool_calls - filtering out malformed output");
      }
      // Skip this content block in both cases
    } else {
      // Normal text content - include it
      contentBlocks.push({
        type: "text",
        text: message.content
      });
    }
  }

  // Add tool calls if present
  if (hasToolCalls) {
    for (const toolCall of message.tool_calls) {
      const func = toolCall.function || {};
      let input = {};

      // Parse arguments string
      if (func.arguments) {
        try {
          input = typeof func.arguments === "string"
            ? JSON.parse(func.arguments)
            : func.arguments;
        } catch (err) {
          logger.warn({
            error: err.message,
            arguments: func.arguments
          }, "Failed to parse OpenRouter tool arguments");
          input = {};
        }
      }

      contentBlocks.push({
        type: "tool_use",
        id: toolCall.id || `toolu_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        name: func.name || "unknown",
        input
      });
    }
  }

  if (contentBlocks.length === 0) {
    contentBlocks.push({ type: "text", text: "" });
  }

  // Determine stop reason
  let stopReason = "end_turn";
  if (hasToolCalls) {
    stopReason = "tool_use";
  } else if (choice.finish_reason === "length") {
    stopReason = "max_tokens";
  }

  return {
    id: openRouterResponse.id || `msg_${Date.now()}`,
    type: "message",
    role: "assistant",
    model: requestedModel,
    content: contentBlocks,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: openRouterResponse.usage?.prompt_tokens || 0,
      output_tokens: openRouterResponse.usage?.completion_tokens || 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0
    }
  };
}

module.exports = {
  convertAnthropicToolsToOpenRouter,
  convertAnthropicMessagesToOpenRouter,
  convertOpenRouterResponseToAnthropic
};
