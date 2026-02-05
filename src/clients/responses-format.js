/**
 * OpenAI Responses API ↔ Chat Completions API Conversion
 *
 * The Responses API is OpenAI's new format that uses 'input' instead of 'messages'.
 * This module converts between the two formats for compatibility.
 *
 * @module clients/responses-format
 */

const logger = require("../logger");

/**
 * Map client tool names back to Lynkr tool names
 * Used when processing incoming function_call messages from various AI coding clients
 * Supports: Codex CLI, Cline (VS Code), Continue.dev
 * @param {string} clientToolName - Client tool name (e.g., shell_command, execute_command, read_file)
 * @returns {string} Lynkr tool name (e.g., Bash, Read)
 */
function mapClientToolToLynkr(clientToolName) {
  const reverseMapping = {
    // ============== CODEX CLI ==============
    "shell_command": "Bash",
    "read_file": "Read",
    "write_file": "Write",
    "apply_patch": "Edit",
    "glob_file_search": "Glob",
    "rg": "Grep",
    "list_dir": "ListDir",

    // ============== CLINE (VS Code) ==============
    "execute_command": "Bash",
    // "read_file" already mapped above
    "write_to_file": "Write",
    "replace_in_file": "Edit",
    "search_files": "Grep",
    "list_files": "ListDir",

    // ============== KILO CODE (Fork of Cline) ==============
    // Most tools same as Cline, but apply_diff is different
    "apply_diff": "Edit",
    "codebase_search": "Grep",
    "delete_file": "Bash",  // No direct equivalent, use Bash rm
    "browser_action": "WebFetch",  // Approximate mapping

    // ============== CONTINUE.DEV ==============
    "run_terminal_command": "Bash",
    // "read_file" already mapped above
    "create_new_file": "Write",
    "edit_existing_file": "Edit",
    "exact_search": "Grep",
    "read_currently_open_file": "Read",

    // ============== Lowercase Lynkr tools (pass-through) ==============
    "bash": "Bash",
    "read": "Read",
    "write": "Write",
    "edit": "Edit",
    "glob": "Glob",
    "grep": "Grep",
    "listdir": "ListDir"
  };

  return reverseMapping[clientToolName] || clientToolName;
}

/**
 * Convert Responses API request to Chat Completions format
 * @param {Object} responsesRequest - Responses API format request
 * @returns {Object} Chat Completions format request
 */
function convertResponsesToChat(responsesRequest) {
  const { input, model, max_tokens, temperature, top_p, tools, tool_choice, stream } = responsesRequest;

  logger.info({
    inputType: typeof input,
    inputIsArray: Array.isArray(input),
    inputLength: Array.isArray(input) ? input.length : input?.length || 0,
    model,
    hasTools: !!tools
  }, "Converting Responses API to Chat Completions");

  // Handle input as either string or array of messages
  let messages;

  if (typeof input === 'string') {
    // Simple string input - convert to user message
    messages = [{ role: "user", content: input }];
    logger.info({ messageCount: 1 }, "Converted string input to single user message");

  } else if (Array.isArray(input)) {
    // Array of messages - validate and clean each message
    logger.info({
      rawInputSample: input.slice(0, 3).map(m => ({
        role: m?.role,
        hasContent: !!m?.content,
        contentType: typeof m?.content,
        contentLength: m?.content?.length || 0,
        hasToolCalls: !!m?.tool_calls,
        hasToolCallId: !!m?.tool_call_id,
        allKeys: m ? Object.keys(m) : []
      }))
    }, "Processing Responses API message array");

    messages = input
      .filter(msg => {
        // Keep messages that have valid role and either content or tool_calls
        // Also keep function_call_output type messages (tool results)
        const hasRole = msg && msg.role;
        const hasContent = msg && (msg.content || msg.tool_calls || msg.tool_call_id);
        const isFunctionCallOutput = msg && msg.type === 'function_call_output';
        const isFunctionCall = msg && msg.type === 'function_call';

        const isValid = hasRole && hasContent || isFunctionCallOutput || isFunctionCall;

        if (!isValid && msg) {
          logger.debug({
            msg: {
              role: msg.role,
              type: msg.type,
              hasContent: !!msg.content,
              hasOutput: !!msg.output,
              hasCallId: !!msg.call_id,
              keys: Object.keys(msg),
              rawMsg: JSON.stringify(msg).substring(0, 300)
            }
          }, "Filtering out message without role+content or function type");
        }

        return isValid;
      })
      .map(msg => {
        // Handle function_call_output (tool results from client)
        if (msg.type === 'function_call_output') {
          return {
            role: 'tool',
            tool_call_id: msg.call_id,
            content: msg.output || ''
          };
        }

        // Handle function_call (tool calls - convert to assistant with tool_calls)
        if (msg.type === 'function_call') {
          // Map client tool names back to Lynkr names for model consistency
          // Supports Codex CLI, Cline, Continue.dev
          const lynkrToolName = mapClientToolToLynkr(msg.name);
          logger.debug({
            originalName: msg.name,
            mappedName: lynkrToolName
          }, "Mapping client tool name to Lynkr");

          return {
            role: 'assistant',
            content: null,
            tool_calls: [{
              id: msg.call_id || msg.id,
              type: 'function',
              function: {
                name: lynkrToolName,
                arguments: typeof msg.arguments === 'string' ? msg.arguments : JSON.stringify(msg.arguments || {})
              }
            }]
          };
        }

        // Clean up message structure - only keep valid OpenAI Chat Completions fields
        let content = msg.content || null;

        // Handle content that's an array of content parts (multimodal format)
        // OpenAI accepts both: string OR array of {type, text/image_url}
        // If it's an array with input_text/text types, extract the text
        if (Array.isArray(content)) {
          // Extract text from array of content parts
          const textParts = content
            .filter(part => part && (part.type === 'text' || part.type === 'input_text'))
            .map(part => part.text || part.input_text || '')
            .filter(text => text.length > 0);

          if (textParts.length > 0) {
            // Combine all text parts into a single string
            content = textParts.join('\n\n');
            logger.info({
              originalPartCount: content.length,
              extractedTextLength: content.length,
              sample: content.substring(0, 100)
            }, "Converted multimodal content array to string");
          } else {
            // No text found, keep as array (might be image-only)
            content = content;
          }
        }

        const cleaned = {
          role: msg.role,
          content: content
        };

        // Add optional fields if present
        if (msg.name) cleaned.name = msg.name;
        if (msg.tool_calls) cleaned.tool_calls = msg.tool_calls;
        if (msg.tool_call_id) cleaned.tool_call_id = msg.tool_call_id;

        return cleaned;
      });

    logger.info({
      originalCount: input.length,
      filteredCount: messages.length,
      messageRoles: messages.map(m => m.role),
      sample: messages.slice(0, 2).map(m => ({
        role: m.role,
        contentType: typeof m.content,
        contentIsArray: Array.isArray(m.content),
        contentPreview: typeof m.content === 'string' ? m.content.substring(0, 50) : (Array.isArray(m.content) ? `[Array:${m.content.length}]` : m.content),
        hasToolCalls: !!m.tool_calls
      }))
    }, "Converted and cleaned Responses API message array");

    // Debug: Log ALL messages to see what's actually being returned
    logger.info({
      allMessagesDetailed: messages.map((m, idx) => ({
        index: idx,
        role: m.role,
        contentType: typeof m.content,
        contentLength: typeof m.content === 'string' ? m.content.length : (Array.isArray(m.content) ? m.content.length : 'N/A'),
        contentSample: typeof m.content === 'string' ? m.content.substring(0, 100) : JSON.stringify(m.content).substring(0, 100)
      }))
    }, "ALL MESSAGES AFTER CONVERSION");

    // Validate we have at least one message
    if (messages.length === 0) {
      logger.error({ originalInput: input }, "All messages filtered out - no valid messages remaining");
      throw new Error("Responses API: No valid messages after filtering. All messages were invalid.");
    }

  } else {
    // Fallback for unexpected format
    logger.warn({
      inputType: typeof input,
      input: input
    }, "Unexpected input format in Responses API");
    messages = [{ role: "user", content: String(input || "") }];
  }

  const result = {
    model: model || "gpt-4o",
    messages: messages,
    max_tokens: max_tokens || 4096,
    temperature: temperature,
    top_p: top_p,
    tools: tools,
    tool_choice: tool_choice,
    stream: stream || false
  };

  logger.info({
    resultMessageCount: messages.length,
    resultHasTools: !!result.tools,
    resultStream: result.stream
  }, "Responses to Chat conversion complete");

  return result;
}

/**
 * Convert Chat Completions response to Responses API format
 * @param {Object} chatResponse - Chat Completions format response
 * @returns {Object} Responses API format response
 */
function convertChatToResponses(chatResponse) {
  logger.debug({
    hasContent: !!chatResponse.choices?.[0]?.message?.content,
    finishReason: chatResponse.choices?.[0]?.finish_reason
  }, "Converting Chat Completions to Responses API");

  const message = chatResponse.choices[0].message;

  // Extract content and tool calls
  const content = message.content || "";
  const toolCalls = message.tool_calls || [];

  return {
    id: chatResponse.id,
    object: "response",
    created: chatResponse.created,
    model: chatResponse.model,
    content: content,
    tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
    stop_reason: mapFinishReason(chatResponse.choices[0].finish_reason),
    usage: chatResponse.usage
  };
}

/**
 * Map Chat Completions finish_reason to Responses API stop_reason
 * @param {string} finishReason - Chat Completions finish reason
 * @returns {string} Responses API stop reason
 */
function mapFinishReason(finishReason) {
  const mapping = {
    "stop": "end_turn",
    "length": "max_tokens",
    "tool_calls": "tool_use",
    "content_filter": "content_filter"
  };

  return mapping[finishReason] || "end_turn";
}

module.exports = {
  convertResponsesToChat,
  convertChatToResponses,
  mapFinishReason
};
