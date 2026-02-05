/**
 * OpenAI ↔ Anthropic Format Conversion Utilities
 *
 * Converts between OpenAI's /v1/chat/completions format and Anthropic's /v1/messages format.
 * Used for Cursor IDE compatibility.
 *
 * @module clients/openai-format
 */

const logger = require("../logger");

/**
 * Convert OpenAI chat completion request to Anthropic messages format
 * @param {Object} openaiRequest - OpenAI format request
 * @returns {Object} Anthropic format request
 */
function convertOpenAIToAnthropic(openaiRequest) {
  const { messages, input, model, temperature, max_tokens, top_p, stream, tools, tool_choice } = openaiRequest;

  // Cursor's inline edit uses "input" instead of "messages"
  const messageArray = messages || input;

  // Validate messages/input field
  if (!messageArray) {
    logger.error({
      openaiRequest: JSON.stringify(openaiRequest),
      hasMessages: !!messages,
      hasInput: !!input,
      messagesType: typeof messages,
      inputType: typeof input
    }, "convertOpenAIToAnthropic: neither messages nor input field present");
    throw new Error("OpenAI request missing 'messages' or 'input' field");
  }

  if (!Array.isArray(messageArray)) {
    logger.error({
      messageArray: JSON.stringify(messageArray),
      messageArrayType: typeof messageArray,
      isArray: Array.isArray(messageArray)
    }, "convertOpenAIToAnthropic: messages/input is not an array");
    throw new Error(`OpenAI request 'messages'/'input' must be an array, got ${typeof messageArray}`);
  }

  // Extract system message if present
  let system = null;
  const anthropicMessages = [];

  for (const msg of messageArray) {
    if (msg.role === "system") {
      // Anthropic uses a separate system field
      system = msg.content;
    } else if (msg.role === "user" || msg.role === "assistant") {
      // Convert content format
      let content;
      if (typeof msg.content === "string") {
        content = msg.content;
      } else if (Array.isArray(msg.content)) {
        // OpenAI content parts format
        content = msg.content.map(part => {
          if (part.type === "text") {
            return { type: "text", text: part.text };
          } else if (part.type === "image_url") {
            return {
              type: "image",
              source: {
                type: "url",
                url: part.image_url.url
              }
            };
          }
          return part;
        });
      }

      // Handle tool calls in assistant messages (OpenAI format)
      if (msg.role === "assistant" && msg.tool_calls) {
        // Convert OpenAI tool_calls to Anthropic tool_use blocks
        const contentBlocks = [];

        // Add text content if present
        if (msg.content) {
          contentBlocks.push({ type: "text", text: msg.content });
        }

        // Add tool use blocks
        for (const toolCall of msg.tool_calls) {
          contentBlocks.push({
            type: "tool_use",
            id: toolCall.id,
            name: toolCall.function.name,
            input: JSON.parse(toolCall.function.arguments)
          });
        }

        anthropicMessages.push({
          role: "assistant",
          content: contentBlocks
        });
      } else {
        anthropicMessages.push({
          role: msg.role,
          content
        });
      }
    } else if (msg.role === "tool") {
      // OpenAI tool response → Anthropic tool_result
      const previousMsg = anthropicMessages[anthropicMessages.length - 1];

      // Tool results must follow assistant message with tool_use
      // Add as separate user message with tool_result
      anthropicMessages.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: msg.tool_call_id,
            content: msg.content
          }
        ]
      });
    }
  }

  // Convert tools format (OpenAI → Anthropic)
  let anthropicTools = null;
  if (tools && tools.length > 0) {
    anthropicTools = tools
      .filter(tool => tool && tool.function && tool.function.name) // Filter out invalid tools
      .map(tool => ({
        name: tool.function.name,
        description: tool.function.description || "",
        input_schema: tool.function.parameters || {
          type: "object",
          properties: {},
          required: []
        }
      }));
  }

  // Build Anthropic request
  const anthropicRequest = {
    model: model || "claude-3-5-sonnet-20241022",
    messages: anthropicMessages,
    max_tokens: max_tokens || 4096,
    stream: stream || false
  };

  if (system) {
    anthropicRequest.system = system;
  }

  if (temperature !== undefined) {
    anthropicRequest.temperature = temperature;
  }

  if (top_p !== undefined) {
    anthropicRequest.top_p = top_p;
  }

  if (anthropicTools) {
    anthropicRequest.tools = anthropicTools;
  }

  // Handle tool_choice
  if (tool_choice) {
    if (tool_choice === "auto") {
      anthropicRequest.tool_choice = { type: "auto" };
    } else if (tool_choice === "none") {
      anthropicRequest.tool_choice = { type: "none" };
    } else if (typeof tool_choice === "object" && tool_choice.function) {
      anthropicRequest.tool_choice = {
        type: "tool",
        name: tool_choice.function.name
      };
    }
  }

  logger.debug({
    openaiMessageCount: messageArray.length,
    anthropicMessageCount: anthropicMessages.length,
    hasSystem: !!system,
    hasTools: !!anthropicTools,
    toolCount: anthropicTools?.length || 0
  }, "Converted OpenAI request to Anthropic format");

  return anthropicRequest;
}

/**
 * Convert Anthropic messages response to OpenAI chat completion format
 * @param {Object} anthropicResponse - Anthropic format response
 * @param {string} model - Model name to include in response
 * @returns {Object} OpenAI format response
 */
function convertAnthropicToOpenAI(anthropicResponse, model = "claude-3-5-sonnet-20241022") {
  // Validate input
  if (!anthropicResponse) {
    throw new Error("convertAnthropicToOpenAI: anthropicResponse is undefined or null");
  }

  const { id, content, stop_reason, usage } = anthropicResponse;

  // Validate required fields
  if (!content || !Array.isArray(content)) {
    throw new Error(`convertAnthropicToOpenAI: invalid content field (got ${typeof content})`);
  }

  // Convert content blocks to OpenAI format
  let messageContent = "";
  const toolCalls = [];

  for (const block of content) {
    if (block.type === "text") {
      messageContent += block.text;
    } else if (block.type === "tool_use") {
      toolCalls.push({
        id: block.id,
        type: "function",
        function: {
          name: block.name,
          arguments: JSON.stringify(block.input)
        }
      });
    }
  }

  // Build OpenAI response
  // Ensure ID has the chatcmpl- prefix that OpenAI clients expect
  const responseId = id && id.startsWith("chatcmpl-") ? id : `chatcmpl-${Date.now()}`;
  const openaiResponse = {
    id: responseId,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: messageContent || null
        },
        finish_reason: mapStopReason(stop_reason)
      }
    ],
    usage: {
      prompt_tokens: usage?.input_tokens || 0,
      completion_tokens: usage?.output_tokens || 0,
      total_tokens: (usage?.input_tokens || 0) + (usage?.output_tokens || 0)
    }
  };

  // Add tool_calls if present
  if (toolCalls.length > 0) {
    openaiResponse.choices[0].message.tool_calls = toolCalls;
    openaiResponse.choices[0].finish_reason = "tool_calls";
  }

  logger.debug({
    anthropicStopReason: stop_reason,
    openaiFinishReason: openaiResponse.choices[0].finish_reason,
    hasToolCalls: toolCalls.length > 0,
    messageLength: messageContent.length
  }, "Converted Anthropic response to OpenAI format");

  return openaiResponse;
}

/**
 * Convert Anthropic streaming chunk to OpenAI streaming format
 * @param {Object} chunk - Anthropic SSE event
 * @param {string} model - Model name
 * @returns {string} OpenAI format SSE line (data: {...})
 */
function convertAnthropicStreamChunkToOpenAI(chunk, model = "claude-3-5-sonnet-20241022") {
  const eventType = chunk.type;

  if (eventType === "message_start") {
    // Initial message metadata
    return {
      id: chunk.message?.id || `chatcmpl-${Date.now()}`,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: model,
      choices: [
        {
          index: 0,
          delta: { role: "assistant", content: "" },
          finish_reason: null
        }
      ]
    };
  } else if (eventType === "content_block_start") {
    // Start of content block (text or tool_use)
    const contentBlock = chunk.content_block;

    if (contentBlock?.type === "tool_use") {
      return {
        id: `chatcmpl-${Date.now()}`,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: model,
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: chunk.index,
                  id: contentBlock.id,
                  type: "function",
                  function: {
                    name: contentBlock.name,
                    arguments: ""
                  }
                }
              ]
            },
            finish_reason: null
          }
        ]
      };
    }
  } else if (eventType === "content_block_delta") {
    // Incremental content
    const delta = chunk.delta;

    if (delta?.type === "text_delta") {
      return {
        id: `chatcmpl-${Date.now()}`,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: model,
        choices: [
          {
            index: 0,
            delta: { content: delta.text },
            finish_reason: null
          }
        ]
      };
    } else if (delta?.type === "input_json_delta") {
      // Tool call arguments streaming
      return {
        id: `chatcmpl-${Date.now()}`,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: model,
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: chunk.index,
                  function: {
                    arguments: delta.partial_json
                  }
                }
              ]
            },
            finish_reason: null
          }
        ]
      };
    }
  } else if (eventType === "message_delta") {
    // Final message metadata (stop reason, usage)
    const stopReason = chunk.delta?.stop_reason;
    const usage = chunk.usage;

    return {
      id: `chatcmpl-${Date.now()}`,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: model,
      choices: [
        {
          index: 0,
          delta: {},
          finish_reason: mapStopReason(stopReason)
        }
      ],
      usage: usage ? {
        prompt_tokens: 0, // Not available in streaming
        completion_tokens: usage.output_tokens || 0,
        total_tokens: usage.output_tokens || 0
      } : undefined
    };
  } else if (eventType === "message_stop") {
    // End of stream
    return {
      id: `chatcmpl-${Date.now()}`,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: model,
      choices: [
        {
          index: 0,
          delta: {},
          finish_reason: "stop"
        }
      ]
    };
  }

  // Unknown event type, return empty chunk
  return null;
}

/**
 * Map Anthropic stop_reason to OpenAI finish_reason
 * @param {string} stopReason - Anthropic stop reason
 * @returns {string} OpenAI finish reason
 */
function mapStopReason(stopReason) {
  const mapping = {
    "end_turn": "stop",
    "max_tokens": "length",
    "stop_sequence": "stop",
    "tool_use": "tool_calls"
  };

  return mapping[stopReason] || "stop";
}

module.exports = {
  convertOpenAIToAnthropic,
  convertAnthropicToOpenAI,
  convertAnthropicStreamChunkToOpenAI,
  mapStopReason
};
