const config = require("../config");
const { invokeModel } = require("../clients/databricks");
const { appendTurnToSession } = require("../sessions/record");
const { executeToolCall } = require("../tools");
const policy = require("../policy");
const logger = require("../logger");
const { needsWebFallback } = require("../policy/web-fallback");
const promptCache = require("../cache/prompt");
const tokens = require("../utils/tokens");
const systemPrompt = require("../prompts/system");
const historyCompression = require("../context/compression");
const tokenBudget = require("../context/budget");
const { applyToonCompression } = require("../context/toon");
const { getContextWindow } = require("../providers/context-window");
const { classifyRequestType, selectToolsSmartly } = require("../tools/smart-selection");
const { compressMessages: headroomCompress, isEnabled: isHeadroomEnabled } = require("../headroom");
const { createAuditLogger } = require("../logger/audit-logger");
const { getResolvedIp, runWithDnsContext } = require("../clients/dns-logger");
const { getShuttingDown } = require("../api/health");
const crypto = require("crypto");
const { asyncClone, asyncTransform, getPoolStats } = require("../workers/helpers");
const { getSemanticCache, isSemanticCacheEnabled } = require("../cache/semantic");
const lazyLoader = require("../tools/lazy-loader");
const { spawnAgent } = require("../agents");
const { mapToolsToAgentType, buildSubagentPrompt } = require("../agents/tool-agent-mapper");
const { getProgressEmitter } = require("../progress/emitter");

/**
 * Generate a unique agent ID
 * Format: agent_<timestamp>_<random>
 */
function generateAgentId() {
  return `agent_${Date.now()}_${crypto.randomBytes(8).toString('hex')}`;
}

/**
 * Get destination URL for audit logging based on provider type
 * @param {string} providerType - Provider type (databricks, azure-anthropic, etc)
 * @returns {string} - Destination URL
 */
function getDestinationUrl(providerType) {
  switch (providerType) {
    case 'databricks':
      return config.databricks?.url ?? 'unknown';
    case 'azure-anthropic':
      return config.azureAnthropic?.endpoint ?? 'unknown';
    case 'ollama':
      return config.ollama?.endpoint ?? config.ollama?.cloudEndpoint ?? 'unknown';
    case 'azure-openai':
      return config.azureOpenAI?.endpoint ?? 'unknown';
    case 'openrouter':
      return config.openrouter?.endpoint ?? 'unknown';
    case 'openai':
      return 'https://api.openai.com/v1/chat/completions';
    case 'llamacpp':
      return config.llamacpp?.endpoint ?? 'unknown';
    case 'lmstudio':
      return config.lmstudio?.endpoint ?? 'unknown';
    case 'bedrock':
      return config.bedrock?.endpoint ?? 'unknown';
    case 'zai':
      return config.zai?.endpoint ?? 'unknown';
    case 'vertex':
      return config.vertex?.endpoint ?? 'unknown';
    default:
      return 'unknown';
  }
}

const DROP_KEYS = new Set([
  "provider",
  "api_type",
  "beta",
  "context_management",
  "stream",
  "thinking",
  "max_steps",
  "max_duration_ms",
]);

const DEFAULT_AZURE_TOOLS = Object.freeze([
  {
    name: "WebSearch",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query to execute.",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "WebFetch",
    input_schema: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "URL to fetch.",
        },
        prompt: {
          type: "string",
          description: "Optional summarisation prompt.",
        },
      },
      required: ["url"],
      additionalProperties: false,
    },
  },
  {
    name: "Bash",
    input_schema: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "Shell command to execute.",
        },
        timeout: {
          type: "integer",
          description: "Optional timeout in milliseconds.",
        },
      },
      required: ["command"],
      additionalProperties: false,
    },
  },
  {
    name: "BashOutput",
    input_schema: {
      type: "object",
      properties: {
        bash_id: {
          type: "string",
          description: "Identifier of the background bash process.",
        },
      },
      required: ["bash_id"],
      additionalProperties: false,
    },
  },
  {
    name: "KillShell",
    input_schema: {
      type: "object",
      properties: {
        shell_id: {
          type: "string",
          description: "Identifier of the background shell to terminate.",
        },
      },
      required: ["shell_id"],
      additionalProperties: false,
    },
  },
]);

const PLACEHOLDER_WEB_RESULT_REGEX = /^Web search results for query:/i;

function flattenBlocks(blocks) {
  if (!Array.isArray(blocks)) return String(blocks ?? "");
  return blocks
    .map((block) => {
      if (!block) return "";
      if (typeof block === "string") return block;
      if (block.type === "text" && typeof block.text === "string") return block.text;
      if (block.type === "tool_result") {
        const payload = block?.content ?? "";
        return typeof payload === "string" ? payload : JSON.stringify(payload);
      }
      if (block.input_text) return block.input_text;
      return "";
    })
    .join("");
}

function normaliseMessages(payload, options = {}) {
  const flattenContent = options.flattenContent !== false;
  const normalised = [];
  if (Array.isArray(payload.system) && payload.system.length) {
    const text = flattenBlocks(payload.system).trim();
    if (text) normalised.push({ role: "system", content: text });
  }
  if (Array.isArray(payload.messages)) {
    for (const message of payload.messages) {
      if (!message) continue;
      const role = message.role ?? "user";
      const rawContent = message.content;
      let content;
      if (Array.isArray(rawContent)) {
        content = flattenContent ? flattenBlocks(rawContent) : rawContent.slice();
      } else if (rawContent === undefined || rawContent === null) {
        content = flattenContent ? "" : rawContent;
      } else if (typeof rawContent === "string") {
        content = rawContent;
      } else if (flattenContent) {
        content = String(rawContent);
      } else {
        content = rawContent;
      }
      normalised.push({ role, content });
    }
  }
  return normalised;
}

/**
 * Clean user input that was concatenated due to request interruption.
 * When Claude Code interrupts a request and the user types a new command,
 * the client may concatenate old + new messages (e.g. "ls[Request interrupted by user]ls").
 * This function strips the old prefix if a pending flag exists on the session.
 *
 * @param {object} session - Session object (has _pendingUserInput flag)
 * @param {Array} messages - Raw messages array from payload
 * @returns {Array} messages - Cleaned messages (modified in place)
 */
function cleanInterruptedInput(session, messages) {
  if (!session || !messages || !Array.isArray(messages)) return messages;

  const pendingInput = session._pendingUserInput;
  if (!pendingInput) return messages;  // No interrupted request, nothing to clean

  // Find the last user message
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg?.role !== 'user') continue;

    // Extract text content
    let text = '';
    if (typeof msg.content === 'string') {
      text = msg.content;
    } else if (Array.isArray(msg.content)) {
      const textBlocks = msg.content.filter(b => b?.type === 'text');
      text = textBlocks.map(b => b.text || '').join('\n');
    }
    if (!text) break;

    // Check if message starts with the pending input (concatenation pattern)
    if (text.length > pendingInput.length && text.startsWith(pendingInput)) {
      let cleanedText = text.slice(pendingInput.length);

      // Strip common separators between old and new input
      cleanedText = cleanedText
        .replace(/^\[Request interrupted by user\]/i, '')
        .replace(/^\n+/, '')
        .replace(/^\s+/, '');

      if (cleanedText.length > 0) {
        logger.info({
          original: text.substring(0, 100),
          cleaned: cleanedText.substring(0, 100),
          pendingInput: pendingInput.substring(0, 50)
        }, "[INPUT_CLEANUP] Stripped interrupted request prefix from user input");

        // Update the message content
        if (typeof msg.content === 'string') {
          msg.content = cleanedText;
        } else if (Array.isArray(msg.content)) {
          // Find and update the text block(s)
          for (const block of msg.content) {
            if (block?.type === 'text' && block.text) {
              if (block.text.startsWith(pendingInput)) {
                let cleanBlock = block.text.slice(pendingInput.length);
                cleanBlock = cleanBlock
                  .replace(/^\[Request interrupted by user\]/i, '')
                  .replace(/^\n+/, '')
                  .replace(/^\s+/, '');
                block.text = cleanBlock;
              }
              break;  // Only clean the first text block
            }
          }
        }
      }
    }
    break;  // Only process the last user message
  }

  return messages;
}

/**
 * Extract the last user message text from payload messages.
 * Used for setting the pending input flag.
 */
function extractLastUserText(messages) {
  if (!messages || !Array.isArray(messages)) return '';
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg?.role !== 'user') continue;
    if (typeof msg.content === 'string') return msg.content.trim();
    if (Array.isArray(msg.content)) {
      const textBlocks = msg.content.filter(b => b?.type === 'text');
      return textBlocks.map(b => b.text || '').join('\n').trim();
    }
  }
  return '';
}

function normaliseTools(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return undefined;
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name || "unnamed_tool",
      description: tool.description || tool.name || "No description provided",
      parameters: tool.input_schema ?? {},
    },
  }));
}

/**
 * Ensure tools are in Anthropic format for Databricks/Claude API
 * Databricks expects: {name, description, input_schema}
 * NOT OpenAI format: {type: "function", function: {...}}
 */
function ensureAnthropicToolFormat(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return undefined;
  return tools.map((tool) => {
    // Ensure input_schema has required 'type' field
    let input_schema = tool.input_schema || { type: "object", properties: {} };

    // If input_schema exists but missing 'type', add it
    if (input_schema && !input_schema.type) {
      input_schema = { type: "object", ...input_schema };
    }

    return {
      name: tool.name || "unnamed_tool",
      description: tool.description || tool.name || "No description provided",
      input_schema,
    };
  });
}

function stripPlaceholderWebSearchContent(message) {
  if (!message || message.content === undefined || message.content === null) {
    return message;
  }

  if (typeof message.content === "string") {
    return PLACEHOLDER_WEB_RESULT_REGEX.test(message.content.trim()) ? null : message;
  }

  if (!Array.isArray(message.content)) {
    return message;
  }

  const filtered = message.content.filter((block) => {
    if (!block) return false;
    if (block.type === "tool_result") {
      const content = typeof block.content === "string" ? block.content.trim() : "";
      if (PLACEHOLDER_WEB_RESULT_REGEX.test(content)) {
        return false;
      }
    }
    if (block.type === "text" && typeof block.text === "string") {
      if (PLACEHOLDER_WEB_RESULT_REGEX.test(block.text.trim())) {
        return false;
      }
    }
    return true;
  });

  if (filtered.length === 0) {
    return null;
  }

  if (filtered.length === message.content.length) {
    return message;
  }

  return {
    ...message,
    content: filtered,
  };
}

function isPlaceholderToolResultMessage(message) {
  if (!message) return false;
  if (message.role !== "user" && message.role !== "tool") return false;

  if (typeof message.content === "string") {
    return PLACEHOLDER_WEB_RESULT_REGEX.test(message.content.trim());
  }

  if (!Array.isArray(message.content) || message.content.length === 0) {
    return false;
  }

  return message.content.every((block) => {
    if (!block || block.type !== "tool_result") return false;
    const text = typeof block.content === "string" ? block.content.trim() : "";
    return PLACEHOLDER_WEB_RESULT_REGEX.test(text);
  });
}

function removeMatchingAssistantToolUse(cleanMessages, toolUseId) {
  if (!toolUseId || cleanMessages.length === 0) return;
  const lastIndex = cleanMessages.length - 1;
  const candidate = cleanMessages[lastIndex];
  if (!candidate || candidate.role !== "assistant") return;

  if (Array.isArray(candidate.content)) {
    const remainingBlocks = candidate.content.filter((block) => {
      if (!block || block.type !== "tool_use") return true;
      return block.id !== toolUseId;
    });

    if (remainingBlocks.length === 0) {
      cleanMessages.pop();
    } else if (remainingBlocks.length !== candidate.content.length) {
      cleanMessages[lastIndex] = {
        ...candidate,
        content: remainingBlocks,
      };
    }
    return;
  }

  if (Array.isArray(candidate.tool_calls)) {
    const remainingCalls = candidate.tool_calls.filter((call) => call.id !== toolUseId);
    if (remainingCalls.length === 0) {
      cleanMessages.pop();
    } else if (remainingCalls.length !== candidate.tool_calls.length) {
      cleanMessages[lastIndex] = {
        ...candidate,
        tool_calls: remainingCalls,
      };
    }
  }
}

const WEB_SEARCH_NORMALIZED = new Set(["websearch", "web_search", "web-search"]);

function normaliseToolIdentifier(name = "") {
  return String(name).toLowerCase().replace(/[^a-z0-9]/g, "");
}

function buildWebSearchSummary(rawContent, options = {}) {
  if (rawContent === undefined || rawContent === null) return null;
  let data = rawContent;
  if (typeof data === "string") {
    const trimmed = data.trim();
    if (!trimmed) return null;
    try {
      data = JSON.parse(trimmed);
    } catch {
      return null;
    }
  }
  if (!data || typeof data !== "object") return null;
  const results = Array.isArray(data.results) ? data.results : [];
  if (results.length === 0) return null;
  const maxItems =
    Number.isInteger(options.maxItems) && options.maxItems > 0 ? options.maxItems : 5;
  const lines = [];
  for (let i = 0; i < results.length && lines.length < maxItems; i += 1) {
    const item = results[i];
    if (!item || typeof item !== "object") continue;
    const title = item.title || item.name || item.url || item.href;
    const url = item.url || item.href || "";
    const snippet = item.snippet || item.summary || item.excerpt || "";
    if (!title && !snippet) continue;
    let line = `${lines.length + 1}. ${title ?? snippet}`;
    if (snippet && snippet !== title) {
      line += ` — ${snippet}`;
    }
    if (url) {
      line += ` (${url})`;
    }
    lines.push(line);
  }
  if (lines.length === 0) return null;
  return `Top search hits:\n${lines.join("\n")}`;
}

/**
 * Count tool_use and tool_result blocks in message history.
 * Only counts tools from the CURRENT TURN (after the last user text message).
 * This prevents the guard from blocking new questions after a previous loop.
 */
function countToolCallsInHistory(messages) {
  if (!Array.isArray(messages)) return { toolUseCount: 0, toolResultCount: 0 };

  // Find the index of the last user message that contains actual text (not just tool_result)
  let lastUserTextIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg?.role !== 'user') continue;

    // Check if this user message has actual text content (not just tool_result)
    if (typeof msg.content === 'string' && msg.content.trim().length > 0) {
      lastUserTextIndex = i;
      break;
    }
    if (Array.isArray(msg.content)) {
      const hasText = msg.content.some(block =>
        (block?.type === 'text' && block?.text?.trim?.().length > 0) ||
        (block?.type === 'input_text' && block?.input_text?.trim?.().length > 0)
      );
      if (hasText) {
        lastUserTextIndex = i;
        break;
      }
    }
  }

  // Count only tool_use/tool_result AFTER the last user text message
  let toolUseCount = 0;
  let toolResultCount = 0;

  const startIndex = lastUserTextIndex >= 0 ? lastUserTextIndex : 0;

  for (let i = startIndex; i < messages.length; i++) {
    const msg = messages[i];
    if (!msg || !Array.isArray(msg.content)) continue;

    for (const block of msg.content) {
      if (block?.type === 'tool_use') toolUseCount++;
      if (block?.type === 'tool_result') toolResultCount++;
    }
  }

  return { toolUseCount, toolResultCount, lastUserTextIndex };
}

/**
 * Inject a "stop looping" instruction if there are too many tool calls in history.
 * This helps prevent infinite loops when the model keeps calling tools instead of responding.
 *
 * @param {Array} messages - The conversation messages
 * @param {number} threshold - Max tool results before injection (default: 5)
 * @returns {Array} - Messages with stop instruction injected if needed
 */
function injectToolLoopStopInstruction(messages, threshold = 5) {
  if (!Array.isArray(messages)) return messages;

  const { toolResultCount } = countToolCallsInHistory(messages);

  if (toolResultCount >= threshold) {
    logger.warn({
      toolResultCount,
      threshold,
    }, "[ToolLoopGuard] Too many tool results in conversation - injecting stop instruction");

    // Inject instruction to stop tool calls and provide a final answer
    const stopInstruction = {
      role: "user",
      content: `⚠️ IMPORTANT: You have already executed ${toolResultCount} tool calls in this conversation. This is likely an infinite loop. STOP calling tools immediately and provide a direct text response to the user based on the information you have gathered. If you cannot complete the task, explain why. DO NOT call any more tools.`,
    };

    // Add to end of messages
    return [...messages, stopInstruction];
  }

  return messages;
}

function sanitiseAzureTools(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return undefined;
  const allowed = new Set([
    "WebSearch",
    "Web_Search",
    "websearch",
    "web_search",
    "web-fetch",
    "webfetch",
    "web_fetch",
    "bash",
    "shell",
    "bash_output",
    "bashoutput",
    "kill_shell",
    "killshell",
  ]);
  const cleaned = new Map();
  for (const tool of tools) {
    if (!tool || typeof tool !== "object") continue;
    const rawName = typeof tool.name === "string" ? tool.name.trim() : "";
    if (!rawName) continue;
    const identifier = normaliseToolIdentifier(rawName);
    if (!allowed.has(identifier)) continue;
    if (cleaned.has(identifier)) continue;
    let schema = null;
    if (tool.input_schema && typeof tool.input_schema === "object") {
      schema = tool.input_schema;
    } else if (tool.parameters && typeof tool.parameters === "object") {
      schema = tool.parameters;
    }
    if (!schema || typeof schema !== "object") {
      schema = { type: "object" };
    }
    cleaned.set(identifier, {
      name: rawName,
      input_schema: schema,
    });
  }
  return cleaned.size > 0 ? Array.from(cleaned.values()) : undefined;
}

function parseToolArguments(toolCall) {
  if (!toolCall?.function?.arguments) return {};
  const raw = toolCall.function.arguments;
  if (typeof raw !== "string") return raw ?? {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function parseExecutionContent(content) {
  if (content === undefined || content === null) {
    return null;
  }
  if (typeof content === "string") {
    const trimmed = content.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        return JSON.parse(trimmed);
      } catch {
        return content;
      }
    }
    return content;
  }
  return content;
}

function createFallbackAssistantMessage(providerType, { text, toolCall }) {
  if (providerType === "azure-anthropic") {
    const blocks = [];
    if (typeof text === "string" && text.trim().length > 0) {
      blocks.push({ type: "text", text: text.trim() });
    }
    blocks.push({
      type: "tool_use",
      id: toolCall.id ?? `tool_${Date.now()}`,
      name: toolCall.function?.name ?? "tool",
      input: parseToolArguments(toolCall),
    });
    return {
      role: "assistant",
      content: blocks,
    };
  }
  return {
    role: "assistant",
    content: text ?? "",
    tool_calls: [
      {
        id: toolCall.id,
        function: toolCall.function,
      },
    ],
  };
}

function createFallbackToolResultMessage(providerType, { toolCall, execution }) {
  const toolName = execution.name ?? toolCall.function?.name ?? "tool";
  const toolId = execution.id ?? toolCall.id ?? `tool_${Date.now()}`;
  if (providerType === "azure-anthropic") {
    const parsed = parseExecutionContent(execution.content);
    let contentBlocks;
    if (typeof parsed === "string" || parsed === null) {
      contentBlocks = [
        {
          type: "tool_result",
          tool_use_id: toolId,
          content: parsed ?? "",
          is_error: execution.ok === false,
        },
      ];
    } else {
      contentBlocks = [
        {
          type: "tool_result",
          tool_use_id: toolId,
          content: JSON.stringify(parsed),
          is_error: execution.ok === false,
        },
      ];
    }
    return {
      role: "user",
      content: contentBlocks,
    };
  }
  return {
    role: "tool",
    tool_call_id: toolId,
    name: toolCall.function?.name ?? toolName,
    content: execution.content,
  };
}

function extractWebSearchUrls(messages, options = {}, toolNameLookup = new Map()) {
  const max = Number.isInteger(options.max) && options.max > 0 ? options.max : 10;
  const urls = [];
  const seen = new Set();
  if (!Array.isArray(messages)) return urls;

  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (!message) continue;
    if (Array.isArray(message.content)) {
      for (const part of message.content) {
        if (!part || part.type !== "tool_result") continue;
        const toolIdentifier = toolNameLookup.get(part.tool_use_id ?? "") ?? null;
        if (!toolIdentifier || !WEB_SEARCH_NORMALIZED.has(toolIdentifier)) continue;
        let data = part.content;
        if (typeof data === "string") {
          try {
            data = JSON.parse(data);
          } catch {
            continue;
          }
        }
        if (!data || typeof data !== "object") continue;
        const results = Array.isArray(data.results) ? data.results : [];
        for (const entry of results) {
          if (!entry || typeof entry !== "object") continue;
          const url = entry.url ?? entry.href ?? null;
          if (!url) continue;
          if (seen.has(url)) continue;
          seen.add(url);
          urls.push(url);
          if (urls.length >= max) return urls;
        }
      }
      continue;
    }

    if (message.role === "tool") {
      const toolIdentifier = normaliseToolIdentifier(message.name ?? "");
      if (!WEB_SEARCH_NORMALIZED.has(toolIdentifier)) continue;
      let data = message.content;
      if (typeof data === "string") {
        try {
          data = JSON.parse(data);
        } catch {
          continue;
        }
      }
      if (!data || typeof data !== "object") continue;
      const results = Array.isArray(data.results) ? data.results : [];
      for (const entry of results) {
        if (!entry || typeof entry !== "object") continue;
        const url = entry.url ?? entry.href ?? null;
        if (!url) continue;
        if (seen.has(url)) continue;
        seen.add(url);
        urls.push(url);
        if (urls.length >= max) return urls;
      }
      continue;
    }
  }

  return urls;
}

function normaliseToolChoice(choice) {
  if (!choice) return undefined;
  if (typeof choice === "string") return choice; // "auto", "none"
  if (choice.type === "tool" && choice.name) {
    return { type: "function", function: { name: choice.name } };
  }
  return undefined;
}

/**
 * Strip <think>...</think> tags that some models (DeepSeek, Qwen) emit for chain-of-thought reasoning.
 */
function stripThinkTags(text) {
  if (typeof text !== "string") return text;
  return text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
}

function ollamaToAnthropicResponse(ollamaResponse, requestedModel) {
  // Ollama response format:
  // { model, created_at, message: { role, content, tool_calls }, done, total_duration, ... }
  // { eval_count, prompt_eval_count, ... }

  const message = ollamaResponse?.message ?? {};
  const rawContent = message.content || "";
  const toolCalls = message.tool_calls || [];

  // Build content blocks
  const contentItems = [];

  // Add text content if present, after stripping thinking blocks
  if (typeof rawContent === "string" && rawContent.trim()) {
    const cleanedContent = stripThinkTags(rawContent);
    if (cleanedContent) {
      contentItems.push({ type: "text", text: cleanedContent });
    }
  }

  // Add tool calls if present
  // Always go through buildAnthropicResponseFromOllama for Ollama responses
  // It handles both native tool_calls AND text extraction fallback
  const { buildAnthropicResponseFromOllama } = require("../clients/ollama-utils");
  if (Array.isArray(toolCalls) && toolCalls.length > 0) {
    return buildAnthropicResponseFromOllama(ollamaResponse, requestedModel);
  }
  // FALLBACK: Check for tool calls in text content even without native tool_calls
  if (typeof rawContent === 'string' && rawContent.trim()) {
    const fallbackResponse = buildAnthropicResponseFromOllama(ollamaResponse, requestedModel);
    // Only use fallback response if it actually found tool calls
    if (fallbackResponse.stop_reason === "tool_use") {
      return fallbackResponse;
    }
  }

  if (contentItems.length === 0) {
    contentItems.push({ type: "text", text: "" });
  }

  // Ollama uses different token count fields
  const inputTokens = ollamaResponse.prompt_eval_count ?? 0;
  const outputTokens = ollamaResponse.eval_count ?? 0;

  return {
    id: `msg_${Date.now()}`,
    type: "message",
    role: "assistant",
    model: requestedModel,
    content: contentItems,
    stop_reason: ollamaResponse.done ? "end_turn" : "max_tokens",
    stop_sequence: null,
    usage: {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  };
}

function toAnthropicResponse(openai, requestedModel, wantsThinking) {
  const choice = openai?.choices?.[0];
  const message = choice?.message ?? {};
  const usage = openai?.usage ?? {};
  const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  const contentItems = [];

  if (wantsThinking) {
    contentItems.push({
      type: "thinking",
      thinking: "Reasoning not available from the backing Databricks model.",
    });
  }

  if (toolCalls.length) {
    for (const call of toolCalls) {
      let input = {};
      try {
        input = call.function?.arguments ? JSON.parse(call.function.arguments) : {};
      } catch {
        input = {};
      }
      contentItems.push({
        type: "tool_use",
        id: call.id ?? `tool_${Date.now()}`,
        name: call.function?.name ?? "function",
        input,
      });
    }
  }

  const textContent = message.content;
  if (typeof textContent === "string" && textContent.trim()) {
    contentItems.push({ type: "text", text: textContent });
  } else if (Array.isArray(textContent)) {
    for (const part of textContent) {
      if (typeof part === "string") {
        contentItems.push({ type: "text", text: part });
      } else if (part?.type === "text" && typeof part.text === "string") {
        contentItems.push({ type: "text", text: part.text });
      }
    }
  }

  if (contentItems.length === 0) {
    contentItems.push({ type: "text", text: "" });
  }

  return {
    id: openai.id ?? `msg_${Date.now()}`,
    type: "message",
    role: "assistant",
    model: requestedModel,
    content: contentItems,
    stop_reason:
      choice?.finish_reason === "stop"
        ? "end_turn"
        : choice?.finish_reason === "length"
          ? "max_tokens"
          : choice?.finish_reason === "tool_calls"
            ? "tool_use"
            : choice?.finish_reason ?? "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: usage.prompt_tokens ?? 0,
      output_tokens: usage.completion_tokens ?? 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  };
}

async function sanitizePayload(payload) {
  const clean = JSON.parse(JSON.stringify(payload ?? {}));
  const requestedModel =
    (typeof payload?.model === "string" && payload.model.trim().length > 0
      ? payload.model.trim()
      : null) ??
    config.modelProvider?.defaultModel ??
    "databricks-claude-sonnet-4-5";
  clean.model = requestedModel;
  const providerType = config.modelProvider?.type ?? "databricks";
  const flattenContent = providerType !== "azure-anthropic";
  clean.messages = normaliseMessages(clean, { flattenContent }).filter((msg) => {
    const hasToolCalls =
      Array.isArray(msg?.tool_calls) && msg.tool_calls.length > 0;
    if (!msg?.content) {
      return hasToolCalls;
    }
    if (typeof msg.content === "string") {
      return hasToolCalls || msg.content.trim().length > 0;
    }
    if (Array.isArray(msg.content)) {
      return hasToolCalls || msg.content.length > 0;
    }
    if (typeof msg.content === "object" && msg.content !== null) {
      return hasToolCalls || Object.keys(msg.content).length > 0;
    }
    return hasToolCalls;
  });
  if (providerType === "azure-anthropic") {
    const cleanedMessages = [];
    for (const message of clean.messages) {
      if (isPlaceholderToolResultMessage(message)) {
        let toolUseId = null;
        if (Array.isArray(message.content)) {
          for (const block of message.content) {
            if (block?.type === "tool_result" && block.tool_use_id) {
              toolUseId = block.tool_use_id;
              break;
            }
          }
        }
        removeMatchingAssistantToolUse(cleanedMessages, toolUseId);
        continue;
      }
      const stripped = stripPlaceholderWebSearchContent(message);
      if (stripped) {
        cleanedMessages.push(stripped);
      }
    }
    clean.messages = cleanedMessages;

    const systemChunks = [];
    clean.messages = clean.messages.filter((msg) => {
      if (msg?.role === "tool") {
        return false;
      }
      if (msg?.role === "system") {
        if (typeof msg.content === "string" && msg.content.trim().length > 0) {
          systemChunks.push(msg.content.trim());
        }
        return false;
      }
      return true;
    });
    if (systemChunks.length > 0) {
      clean.system = systemChunks.join("\n\n");
    } else if (typeof clean.system === "string" && clean.system.trim().length > 0) {
      clean.system = clean.system.trim();
    } else {
      delete clean.system;
    }
    const azureDefaultModel =
      config.modelProvider?.defaultModel && config.modelProvider.defaultModel.trim().length > 0
        ? config.modelProvider.defaultModel.trim()
        : "claude-opus-4-5";
    clean.model = azureDefaultModel;
  } else if (providerType === "ollama") {
    // Override client model with Ollama config model
    const ollamaConfiguredModel = config.ollama?.model;
    clean.model = ollamaConfiguredModel;

    // Ollama format conversion
    // Check if tools should be enabled (native support OR tool execution provider configured)
    const toolConfig = shouldEnableToolsForRequest(providerType, config);

    logger.warn({
      location: "sanitizePayload - ollama start",
      toolsBeforeProcessing: Array.isArray(clean.tools) ? clean.tools.length : 'not array or null',
      toolConfigShouldEnable: toolConfig.shouldEnableTools,
      toolConfigReason: toolConfig.reason,
      toolConfigLogOverride: toolConfig.logOverride,
      toolExecutionProvider: config.toolExecutionProvider,
      providerType
    }, "[TOOL_FLOW_1] Ollama processing start");

    // Log override if tools are enabled via TOOL_EXECUTION_PROVIDER
    if (toolConfig.logOverride) {
      logger.info({
        conversationModel: config.ollama?.model,
        conversationProvider: providerType,
        toolExecutionProvider: config.toolExecutionProvider,
        toolExecutionModel: config.toolExecutionModel || 'default',
        reason: 'TOOL_EXECUTION_PROVIDER configured'
      }, "Enabling tools despite conversation model not supporting tools - will route to tool execution provider");
    }

    if (!toolConfig.shouldEnableTools) {
      // Filter out tool_result content blocks for models without tool support
      clean.messages = clean.messages
        .map((msg) => {
          if (Array.isArray(msg.content)) {
            // Filter out tool_use and tool_result blocks
            const textBlocks = msg.content.filter(
              (block) => block.type === "text" && block.text
            );
            if (textBlocks.length > 0) {
              // Convert to simple string format for Ollama
              return {
                role: msg.role,
                content: textBlocks.map((b) => b.text).join("\n"),
              };
            }
            return null;
          }
          return msg;
        })
        .filter(Boolean);
    } else {
      // Keep tool blocks for tool-capable models
      // But flatten content to simple string for better compatibility
      clean.messages = clean.messages.map((msg) => {
        if (Array.isArray(msg.content)) {
          const textBlocks = msg.content.filter(
            (block) => block.type === "text" && block.text
          );
          if (textBlocks.length > 0) {
            return {
              role: msg.role,
              content: textBlocks.map((b) => b.text).join("\n"),
            };
          }
        }
        return msg;
      });
    }

    // Keep system prompt separate for Ollama (same as other providers)
    // Let invokeOllama() handle body.system properly
  } else {
    delete clean.system;
  }
  DROP_KEYS.forEach((key) => delete clean[key]);

  if (Array.isArray(clean.tools) && clean.tools.length === 0) {
    delete clean.tools;
  } else if (providerType === "databricks") {
    const tools = normaliseTools(clean.tools);
    if (tools) clean.tools = tools;
    else delete clean.tools;
  } else if (providerType === "azure-anthropic") {
    const tools = sanitiseAzureTools(clean.tools);
    clean.tools =
      tools && tools.length > 0
        ? tools
        : DEFAULT_AZURE_TOOLS.map((tool) => ({
          name: tool.name,
          input_schema: JSON.parse(JSON.stringify(tool.input_schema)),
        }));
    delete clean.tool_choice;
  } else if (providerType === "ollama") {
    // Check if tools should be enabled (native support OR tool execution provider configured)
    const toolConfig = shouldEnableToolsForRequest(providerType, config);

    // Check if this is a simple conversational message (no tools needed)
    const isConversational = (() => {
      if (!Array.isArray(clean.messages) || clean.messages.length === 0) {
        logger.debug({ reason: "No messages array" }, "Ollama conversational check");
        return false;
      }
      const lastMessage = clean.messages[clean.messages.length - 1];
      if (lastMessage?.role !== "user") {
        logger.debug({ role: lastMessage?.role }, "Ollama conversational check - not user");
        return false;
      }

      const content = typeof lastMessage.content === "string"
        ? lastMessage.content
        : "";

      logger.debug({
        contentType: typeof lastMessage.content,
        isString: typeof lastMessage.content === "string",
        contentLength: typeof lastMessage.content === "string" ? lastMessage.content.length : "N/A",
        actualContent: typeof lastMessage.content === "string" ? lastMessage.content.substring(0, 100) : JSON.stringify(lastMessage.content).substring(0, 100)
      }, "Ollama conversational check - analyzing content");

      const trimmed = content.trim().toLowerCase();

      // Simple greetings
      if (/^(hi|hello|hey|good morning|good afternoon|good evening|howdy|greetings)[\s\.\!\?]*$/.test(trimmed)) {
        logger.debug({ matched: "greeting", trimmed }, "Ollama conversational check - matched");
        return true;
      }

      // Very short messages (< 20 chars) without code/technical keywords
      // BUT: Common shell commands should NOT be treated as conversational
      const shellCommands = /^(pwd|ls|cd|cat|echo|grep|find|ps|top|df|du|whoami|which|env)[\s\.\!\?]*$/;
      if (shellCommands.test(trimmed)) {
        logger.info({ matched: "shell_command", trimmed }, "Ollama conversational check - SHELL COMMAND detected, keeping tools");
        return false; // NOT conversational - needs tools!
      }

      if (trimmed.length < 20 && !/code|file|function|error|bug|fix|write|read|create|python|rust|javascript|typescript|java|csharp|go|cpp|c\+\+|kotlin|swift|php|ruby|lua|perl|scala|haskell|clojure|r|matlab|sql|bash|shell|powershell/.test(trimmed)) {
        logger.warn({ matched: "short", trimmed, length: trimmed.length }, "Ollama conversational check - SHORT MESSAGE matched, DELETING TOOLS");
        return true;
      }

      logger.debug({ trimmed: trimmed.substring(0, 50), length: trimmed.length }, "Ollama conversational check - not matched");
      return false;
    })();

    logger.warn({
      location: "sanitizePayload - before conversational check",
      isConversational,
      toolsPresent: Array.isArray(clean.tools) ? clean.tools.length : 'not array',
      toolConfigShouldEnable: toolConfig.shouldEnableTools
    }, "[TOOL_FLOW_2] Before conversational branch");

    if (isConversational) {
      // Strip all tools for simple conversational messages
      // UNLESS tool execution provider is configured (tools will be routed there)
      const toolExecutionProviderConfigured = hasDedicatedToolModel(providerType);

      logger.warn({
        location: "conversational branch",
        toolExecutionProviderConfigured,
        toolExecutionProvider: config.toolExecutionProvider,
        providerType,
        toolsBefore: Array.isArray(clean.tools) ? clean.tools.length : 'not array'
      }, "[TOOL_FLOW_3] In conversational branch");

      if (!toolExecutionProviderConfigured) {
        const originalToolCount = Array.isArray(clean.tools) ? clean.tools.length : 0;
        delete clean.tools;
        delete clean.tool_choice;
        clean._noToolInjection = true;
        logger.warn({
          model: config.ollama?.model,
          message: "Removed tools for conversational message",
          originalToolCount,
          userMessage: clean.messages?.[clean.messages.length - 1]?.content?.substring(0, 50),
        }, "Ollama conversational mode - ALL TOOLS DELETED!");
      } else {
        logger.warn({
          model: config.ollama?.model,
          toolExecutionProvider: config.toolExecutionProvider,
          message: "Keeping tools despite conversational message - tool execution provider configured",
          toolsAfter: Array.isArray(clean.tools) ? clean.tools.length : 'not array'
        }, "[TOOL_FLOW_4] Ollama conversational mode - KEEPING tools for tool execution provider");
      }
    } else if (toolConfig.shouldEnableTools && Array.isArray(clean.tools) && clean.tools.length > 0) {
      logger.warn({
        location: "else if - tool limiting branch",
        toolCount: clean.tools.length
      }, "[TOOL_FLOW_5] In tool limiting branch");
      // Ollama performance degrades with too many tools
      // Limit to essential tools only
      const OLLAMA_ESSENTIAL_TOOLS = new Set([
        "Bash",
        "Read",
        "Write",
        "Edit",
        "Glob",
        "Grep",
        "WebSearch",
        "WebFetch",
        "shell",  // Tool is registered as "shell" internally
      ]);

      const limitedTools = clean.tools.filter(tool =>
        OLLAMA_ESSENTIAL_TOOLS.has(tool.name)
      );

      logger.debug({
        model: config.ollama?.model,
        originalToolCount: clean.tools.length,
        limitedToolCount: limitedTools.length,
        keptTools: limitedTools.map(t => t.name)
      }, "Ollama tools limited for performance");

      clean.tools = limitedTools.length > 0 ? limitedTools : undefined;
      if (!clean.tools) {
        delete clean.tools;
      }
    } else {
      logger.warn({
        location: "else block - fallback",
        toolsBefore: Array.isArray(clean.tools) ? clean.tools.length : 'not array',
        toolConfigShouldEnable: toolConfig.shouldEnableTools
      }, "[TOOL_FLOW_6] In else block - fallback case");

      // Check if tool execution provider is configured
      const toolExecutionProviderConfigured = hasDedicatedToolModel(providerType);

      logger.warn({
        location: "else block - provider check",
        toolExecutionProviderConfigured,
        toolExecutionProvider: config.toolExecutionProvider,
        providerType
      }, "[TOOL_FLOW_7] Else block - checking tool execution provider");

      if (!toolExecutionProviderConfigured) {
        // Remove tools only if no tool execution provider configured
        logger.warn({
          location: "else block - deleting tools",
          toolsDeleted: true
        }, "[TOOL_FLOW_8] DELETING TOOLS - no tool execution provider");
        delete clean.tools;
        delete clean.tool_choice;
      } else {
        // Keep tools field (even if empty) for tool execution provider
        // The Ollama client will inject STANDARD_TOOLS later
        logger.warn({
          model: config.ollama?.model,
          toolExecutionProvider: config.toolExecutionProvider,
          message: "Keeping empty tools - will be injected by Ollama client or handled by tool execution provider",
          toolsAfter: Array.isArray(clean.tools) ? clean.tools.length : 'not array'
        }, "[TOOL_FLOW_9] Ollama tools preserved for tool execution provider");
      }
    }

    logger.warn({
      location: "sanitizePayload - ollama end",
      toolsAfterOllamaProcessing: Array.isArray(clean.tools) ? clean.tools.length : 'deleted or not array',
      hasToolsProperty: 'tools' in clean,
      toolsValue: clean.tools
    }, "[TOOL_FLOW_10] Ollama processing complete - final tools state");

  } else if (providerType === "openrouter") {
    // OpenRouter supports tools - keep them as-is
    // Tools are already in Anthropic format and will be converted by openrouter-utils
    if (!Array.isArray(clean.tools) || clean.tools.length === 0) {
      delete clean.tools;
    }
  } else if (providerType === "zai") {
    // Z.AI (Zhipu) supports tools - keep them in Anthropic format
    // They will be converted to OpenAI format in invokeZai
    if (!Array.isArray(clean.tools) || clean.tools.length === 0) {
      delete clean.tools;
    } else {
      // Ensure tools are in Anthropic format
      clean.tools = ensureAnthropicToolFormat(clean.tools);
    }
  } else if (providerType === "vertex") {
    // Vertex AI supports tools - keep them in Anthropic format
    if (!Array.isArray(clean.tools) || clean.tools.length === 0) {
      delete clean.tools;
    } else {
      clean.tools = ensureAnthropicToolFormat(clean.tools);
    }
  } else if (Array.isArray(clean.tools)) {
    // Unknown provider - remove tools for safety
    delete clean.tools;
  }

  if (providerType === "databricks") {
    const toolChoice = normaliseToolChoice(clean.tool_choice);
    if (toolChoice !== undefined) clean.tool_choice = toolChoice;
    else delete clean.tool_choice;
  } else if (providerType === "ollama") {
    // Tool choice handling
    // Check if tools are enabled (to maintain consistency with tool handling above)
    const toolConfig = shouldEnableToolsForRequest(providerType, config);

    if (!toolConfig.shouldEnableTools) {
      delete clean.tool_choice;
    }
    // For tool-capable models, Ollama doesn't support tool_choice, so remove it
    delete clean.tool_choice;
  } else if (clean.tool_choice === undefined || clean.tool_choice === null) {
    delete clean.tool_choice;
  }

  // (a) Server mode: override client-provided tools with server's STANDARD_TOOLS
  if (config.toolExecutionMode === 'server' && Array.isArray(clean.tools) && clean.tools.length > 0) {
    const { STANDARD_TOOLS } = require('../clients/standard-tools');
    const clientNames = clean.tools.map(t => t.name).sort();
    const serverNames = STANDARD_TOOLS.map(t => t.name).sort();
    const isSubset = clientNames.length < serverNames.length
      || clientNames.some(n => !serverNames.includes(n));
    if (isSubset) {
      logger.info({
        clientToolCount: clean.tools.length,
        clientToolNames: clean.tools.map(t => t.name),
        serverToolCount: STANDARD_TOOLS.length,
      }, "Client tools overridden — TOOL_EXECUTION_MODE=server enforces STANDARD_TOOLS");
      clean.tools = STANDARD_TOOLS;
    }
  }

  // Smart tool selection (universal, applies to all providers)
  // Single-pass: classifies request type and filters tools accordingly
  // Skip smart-selection if this is a retry after "Invoking tool(s):" text (keeps core tools)
  if (config.smartToolSelection?.enabled && Array.isArray(clean.tools) && clean.tools.length > 0 && !clean._invokeTextRetry) {
    // (b) Skip smart selection for cloud models in tool-capable whitelist
    //     Cloud endpoints have large context windows — no need to trim tools
    const { isCloudModel, modelNameSupportsTools } = require('../clients/ollama-utils');
    const resolvedModel = clean.model || config.ollama?.model;
    const skipSmartSelection = isCloudModel(resolvedModel) && modelNameSupportsTools(resolvedModel);

    if (skipSmartSelection) {
      logger.info({
        model: resolvedModel,
        toolCount: clean.tools.length,
      }, "[TOOL_FLOW_SMART] Skipped — cloud model in tool-capable whitelist");
    } else {
      const classification = classifyRequestType(clean);
      const selectedTools = selectToolsSmartly(clean.tools, classification, {
        provider: providerType,
        tokenBudget: config.smartToolSelection.tokenBudget,
        config: config.smartToolSelection
      });

      const toolExecutionProviderConfigured = hasDedicatedToolModel(providerType);

      if (selectedTools.length !== clean.tools.length) {
        logger.warn({
          requestType: classification.type,
          confidence: classification.confidence,
          originalCount: clean.tools.length,
          selectedCount: selectedTools.length,
          provider: providerType,
          toolExecutionProviderConfigured
        }, "[TOOL_FLOW_SMART] Smart tool selection applied");
      }

      // If tool execution provider configured and selection filtered to 0, keep tools anyway
      if (toolExecutionProviderConfigured && selectedTools.length === 0) {
        logger.warn({
          requestType: classification.type,
          originalCount: clean.tools.length,
          toolExecutionProvider: config.toolExecutionProvider,
          reason: "TOOL_EXECUTION_PROVIDER configured - overriding smart selection"
        }, "[TOOL_FLOW_OVERRIDE] Keeping tools despite smart selection filtering to 0");
      } else {
        clean.tools = selectedTools.length > 0 ? selectedTools : undefined;
        if (!selectedTools.length) {
          clean._noToolInjection = true;
        }
      }
    }
  }

  clean.stream = payload.stream ?? false;

  if (
    config.modelProvider?.type === "azure-anthropic" &&
    logger &&
    typeof logger.debug === "function"
  ) {
    try {
      logger.debug(
        {
          model: clean.model,
          temperature: clean.temperature ?? null,
          max_tokens: clean.max_tokens ?? null,
          tool_count: Array.isArray(clean.tools) ? clean.tools.length : 0,
          has_tool_choice: clean.tool_choice !== undefined,
          messages: clean.messages,
        },
        "Azure Anthropic sanitized payload",
      );
      logger.debug(
        {
          payload: JSON.parse(JSON.stringify(clean)),
        },
        "Azure Anthropic request payload",
      );
    } catch (err) {
      logger.debug({ err }, "Failed logging Azure Anthropic payload");
    }
  }

  // Optional TOON conversion for large JSON message payloads (prompt context only).
  // Run this BEFORE message coalescing to preserve parseable JSON boundaries.
  applyToonCompression(clean, config.toon, { logger });

  // FIX: Handle consecutive messages with the same role (causes llama.cpp 400 error)
  // Strategy: Merge all consecutive messages, add instruction to focus on last request
  if (Array.isArray(clean.messages) && clean.messages.length > 0) {
    const merged = [];
    const messages = clean.messages;

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];

      if (merged.length > 0 && msg.role === merged[merged.length - 1].role) {
        // Merge content with the previous message of the same role
        const prevMsg = merged[merged.length - 1];
        const prevContent = typeof prevMsg.content === 'string' ? prevMsg.content : JSON.stringify(prevMsg.content);
        const currContent = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
        prevMsg.content = prevContent + '\n\n' + currContent;

        logger.debug({
          mergedRole: msg.role,
          addedContentPreview: currContent.substring(0, 50)
        }, 'Merged consecutive message with same role');
      } else {
        merged.push({ ...msg });
      }
    }

    // If the last message is from user, add instruction to focus on the actual request
    if (merged.length > 0 && merged[merged.length - 1].role === 'user') {
      const lastMsg = merged[merged.length - 1];
      const content = typeof lastMsg.content === 'string' ? lastMsg.content : JSON.stringify(lastMsg.content);

      // Find the last actual user request (after all the context/instructions)
      // Add a clear separator to help the model focus
      if (content.length > 500) {
        lastMsg.content = content + '\n\n---\nIMPORTANT: Focus on and respond ONLY to my most recent request above. Do not summarize or acknowledge previous instructions.';
      }
    }

    if (merged.length !== clean.messages.length) {
      logger.info({
        originalCount: clean.messages.length,
        mergedCount: merged.length,
        reduced: clean.messages.length - merged.length
      }, 'Merged consecutive messages with same role');
    }

    clean.messages = merged;
  }

  // [CONTEXT_FLOW] Log payload after sanitization
  logger.debug({
    providerType: config.modelProvider?.type ?? "databricks",
    phase: "after_sanitize",
    systemField: typeof clean.system === 'string'
      ? { type: 'string', length: clean.system.length }
      : clean.system
        ? { type: typeof clean.system, value: clean.system }
        : undefined,
    messageCount: clean.messages?.length ?? 0,
    firstMessageHasSystem: clean.messages?.[0]?.content?.includes?.('You are Claude Code') ?? false,
    toolCount: clean.tools?.length ?? 0
  }, '[CONTEXT_FLOW] After sanitizePayload');

  // === Suggestion mode: tag request and override model if configured ===
  const { isSuggestionMode: isSuggestion } = detectSuggestionMode(clean.messages);
  clean._requestMode = isSuggestion ? "suggestion" : "main";
  const smConfig = config.modelProvider?.suggestionModeModel ?? "default";
  if (isSuggestion && smConfig.toLowerCase() !== "default" && smConfig.toLowerCase() !== "none") {
    clean.model = smConfig;
    clean._suggestionModeModel = smConfig;
  }

  // === Topic detection: tag request and override model if configured ===
  if (clean._requestMode === "main") {
    const { isTopicDetection: isTopic } = detectTopicDetection(clean);
    if (isTopic) {
      clean._requestMode = "topic";
      const tdConfig = config.modelProvider?.topicDetectionModel ?? "default";
      if (tdConfig.toLowerCase() !== "default") {
        clean.model = tdConfig;
        clean._topicDetectionModel = tdConfig;
      }
    }
  }

  logger.warn({
    location: "sanitizePayload - FINAL RETURN",
    providerType,
    toolsFinal: Array.isArray(clean.tools) ? clean.tools.length : 'deleted or not array',
    hasToolsProperty: 'tools' in clean,
    toolsValue: clean.tools === undefined ? 'undefined' : (clean.tools === null ? 'null' : `array[${clean.tools.length}]`)
  }, "[TOOL_FLOW_FINAL] sanitizePayload returning - FINAL TOOL STATE");

  // Proactive tool-call nudge: always tell the model to call tools directly rather than describing intent
  if (Array.isArray(clean.tools) && clean.tools.length > 0) {
    const nudge = "Go ahead and use the tool calls if you want to. Do not describe what you are about to do — just call the tools directly.";
    if (typeof clean.system === "string" && clean.system.length > 0) {
      // azure-anthropic + ollama: system is a top-level string field
      clean.system += "\n\n" + nudge;
    } else if (typeof clean.system === "string") {
      clean.system = nudge;
    } else {
      // OpenAI-style providers: system lives as a role="system" message in messages array
      // (clean.system was deleted for these providers)
      const sysMsg = clean.messages?.find(m => m.role === "system");
      if (sysMsg && typeof sysMsg.content === "string") {
        sysMsg.content += "\n\n" + nudge;
      } else if (!sysMsg) {
        clean.messages?.unshift({ role: "system", content: nudge });
      }
    }
  }

  return clean;
}

const DEFAULT_LOOP_OPTIONS = {
  maxSteps: config.policy.maxStepsPerTurn ?? 6,
  maxDurationMs: config.policy.maxDurationMs ?? 120000,
  maxToolCallsPerRequest: config.policy.maxToolCallsPerRequest ?? 12,
};

function resolveLoopOptions(options = {}) {
  const maxSteps =
    Number.isInteger(options.maxSteps) && options.maxSteps > 0
      ? options.maxSteps
      : DEFAULT_LOOP_OPTIONS.maxSteps;
  const maxDurationMs =
    Number.isInteger(options.maxDurationMs) && options.maxDurationMs > 0
      ? options.maxDurationMs
      : DEFAULT_LOOP_OPTIONS.maxDurationMs;
  const maxToolCallsPerRequest =
    Number.isInteger(options.maxToolCallsPerRequest) && options.maxToolCallsPerRequest > 0
      ? options.maxToolCallsPerRequest
      : DEFAULT_LOOP_OPTIONS.maxToolCallsPerRequest;
  return {
    ...DEFAULT_LOOP_OPTIONS,
    maxSteps,
    maxDurationMs,
    maxToolCallsPerRequest,
  };
}

/**
 * Create a signature for a tool call to detect identical repeated calls
 * @param {Object} toolCall - The tool call object
 * @returns {string} - A hash signature of the tool name and parameters
 */
function getToolCallSignature(toolCall) {
  const crypto = require('crypto');
  const name = toolCall.function?.name ?? toolCall.name ?? 'unknown';
  const args = toolCall.function?.arguments ?? toolCall.input;

  // Parse arguments if they're a string
  let argsObj = args;
  if (typeof args === 'string') {
    try {
      argsObj = JSON.parse(args);
    } catch (err) {
      argsObj = args; // Use raw string if parse fails
    }
  }

  // Create a deterministic signature
  const signature = `${name}:${JSON.stringify(argsObj)}`;
  return crypto.createHash('sha256').update(signature).digest('hex').substring(0, 16);
}

/**
 * Check if a dedicated tool model is configured that differs from the conversation model.
 * Returns true when tool calls should be routed to a different model, even if both
 * use the same provider (e.g. Ollama chat llama3.1:8b + Ollama tools qwen3:32b).
 *
 * @param {string} providerType - Current conversation provider (ollama, openrouter, etc)
 * @returns {boolean}
 */
function hasDedicatedToolModel(providerType) {
  if (!config.toolExecutionProvider) return false;
  if (config.toolExecutionProvider !== providerType) return true;
  // Same provider — only route if a DIFFERENT model is specified
  if (!config.toolExecutionModel) return false;
  const conversationModel = providerType === 'ollama' ? config.ollama?.model
    : providerType === 'openrouter' ? config.openrouter?.model
    : null;
  return config.toolExecutionModel !== conversationModel;
}

/**
 * Determine if tools should be enabled for this request
 * Tools are enabled if EITHER:
 * 1. The conversation model natively supports tools, OR
 * 2. A separate tool execution provider is configured (tools will be routed there)
 *
 * @param {string} providerType - Current provider (ollama, openrouter, etc)
 * @param {object} config - Configuration object
 * @returns {{ shouldEnableTools: boolean, reason: string, logOverride: boolean }}
 */
function shouldEnableToolsForRequest(providerType, config) {
  // Check if model natively supports tools
  let modelSupportsTools = true; // Default for most providers

  if (providerType === 'ollama') {
    const { modelNameSupportsTools } = require('../clients/ollama-utils');
    modelSupportsTools = modelNameSupportsTools(config.ollama?.model);
    // Also check if the dedicated tool model supports tools
    if (!modelSupportsTools && config.toolExecutionModel) {
      modelSupportsTools = modelNameSupportsTools(config.toolExecutionModel);
    }
  }

  // Check if user configured separate tool execution provider
  const toolExecutionProviderConfigured = hasDedicatedToolModel(providerType);

  return {
    shouldEnableTools: modelSupportsTools || toolExecutionProviderConfigured,
    reason: modelSupportsTools
      ? 'model_native_support'
      : toolExecutionProviderConfigured
        ? 'tool_execution_provider_override'
        : 'not_supported',
    logOverride: toolExecutionProviderConfigured && !modelSupportsTools
  };
}

/**
 * Extract tool calls from provider response
 * Handles different provider formats (Anthropic, OpenAI, Ollama)
 *
 * @param {Object} response - The LLM response JSON
 * @param {string} providerType - Provider type for format detection
 * @returns {Array} Array of tool call objects
 */
function extractToolCallsFromResponse(response, providerType) {
  if (!response) return [];

  let toolCalls = [];

  try {
    // Anthropic format: { content: [{ type: "tool_use", ... }], stop_reason }
    if (Array.isArray(response.content) && response.stop_reason !== undefined) {
      toolCalls = response.content
        .filter(block => block?.type === "tool_use")
        .map(block => ({
          id: block.id,
          function: {
            name: block.name,
            arguments: JSON.stringify(block.input ?? {}),
          },
          _anthropic_block: block,
          _source_provider: providerType,
        }));
    }
    // Ollama format: { message: { tool_calls: [...] } }
    else if (response.message?.tool_calls) {
      toolCalls = Array.isArray(response.message.tool_calls)
        ? response.message.tool_calls.map(tc => ({
            ...tc,
            _source_provider: providerType,
          }))
        : [];
    }
    // OpenAI format: { choices: [{ message: { tool_calls: [...] } }] }
    else if (response.choices?.[0]?.message?.tool_calls) {
      toolCalls = Array.isArray(response.choices[0].message.tool_calls)
        ? response.choices[0].message.tool_calls.map(tc => ({
            ...tc,
            _source_provider: providerType,
          }))
        : [];
    }
  } catch (err) {
    logger.warn({ error: err.message, providerType }, "Failed to extract tool calls from response");
  }

  return toolCalls;
}

/**
 * Score a set of tool calls based on quality heuristics
 * Higher score = better quality
 */
function scoreToolCalls(toolCalls) {
  let score = 0;

  for (const tc of toolCalls) {
    // Base score for each tool call
    score += 10;

    // Bonus for having function name
    if (tc.function?.name) {
      score += 5;
    }

    // Bonus for having arguments
    if (tc.function?.arguments) {
      try {
        const args = JSON.parse(tc.function.arguments);
        const argCount = Object.keys(args).length;

        // More arguments = more specific = better
        score += argCount * 2;

        // Bonus for non-empty string values
        for (const value of Object.values(args)) {
          if (typeof value === "string" && value.length > 0) {
            score += 1;
          }
        }
      } catch (e) {
        // Invalid JSON arguments = penalty
        score -= 5;
      }
    }
  }

  return score;
}

/**
 * Compare tool calls from two providers and select the best
 *
 * @param {Array} conversationToolCalls - Tool calls from conversation provider
 * @param {Array} toolProviderToolCalls - Tool calls from tool execution provider
 * @param {Object} context - Context for logging
 * @returns {Object} { toolCalls: Array, selectedProvider: string, reason: string }
 */
function compareAndSelectToolCalls(conversationToolCalls, toolProviderToolCalls, context) {
  const { sessionId } = context;

  // If only one provider returned tool calls, use that
  if (toolProviderToolCalls.length === 0 && conversationToolCalls.length > 0) {
    logger.info({ sessionId, count: conversationToolCalls.length },
      "Tool execution provider returned no tools, using conversation provider");
    return {
      toolCalls: conversationToolCalls,
      selectedProvider: 'conversation',
      reason: 'tool_provider_empty'
    };
  }

  if (conversationToolCalls.length === 0 && toolProviderToolCalls.length > 0) {
    logger.info({ sessionId, count: toolProviderToolCalls.length },
      "Conversation provider returned no tools, using tool execution provider");
    return {
      toolCalls: toolProviderToolCalls,
      selectedProvider: 'tool_execution',
      reason: 'conversation_provider_empty'
    };
  }

  // If both returned nothing, return empty
  if (conversationToolCalls.length === 0 && toolProviderToolCalls.length === 0) {
    return {
      toolCalls: [],
      selectedProvider: 'none',
      reason: 'both_empty'
    };
  }

  // Both returned tool calls - compare them

  logger.info({
    sessionId,
    conversationTools: conversationToolCalls.map(tc => ({
      name: tc.function?.name,
      argCount: Object.keys(JSON.parse(tc.function?.arguments || '{}')).length
    })),
    toolProviderTools: toolProviderToolCalls.map(tc => ({
      name: tc.function?.name,
      argCount: Object.keys(JSON.parse(tc.function?.arguments || '{}')).length
    }))
  }, "Comparing tool calls from both providers");

  // Score each set
  const conversationScore = scoreToolCalls(conversationToolCalls);
  const toolProviderScore = scoreToolCalls(toolProviderToolCalls);

  if (toolProviderScore >= conversationScore) {
    logger.info({
      sessionId,
      toolProviderScore,
      conversationScore,
      selected: 'tool_execution'
    }, "Selected tool execution provider (higher or equal score)");

    return {
      toolCalls: toolProviderToolCalls,
      selectedProvider: 'tool_execution',
      reason: 'higher_score',
      scores: { tool_execution: toolProviderScore, conversation: conversationScore }
    };
  } else {
    logger.info({
      sessionId,
      toolProviderScore,
      conversationScore,
      selected: 'conversation'
    }, "Selected conversation provider (higher score)");

    return {
      toolCalls: conversationToolCalls,
      selectedProvider: 'conversation',
      reason: 'higher_score',
      scores: { tool_execution: toolProviderScore, conversation: conversationScore }
    };
  }
}

function buildNonJsonResponse(databricksResponse) {
  return {
    status: databricksResponse.status,
    headers: {
      "Content-Type": databricksResponse.contentType ?? "text/plain",
    },
    body: databricksResponse.text,
    terminationReason: "non_json_response",
  };
}

function buildStreamingResponse(databricksResponse) {
  return {
    status: databricksResponse.status,
    headers: {
      "Content-Type": databricksResponse.contentType ?? "text/event-stream",
    },
    stream: databricksResponse.stream,
    terminationReason: "streaming",
  };
}

function buildErrorResponse(databricksResponse) {
  return {
    status: databricksResponse.status,
    body: databricksResponse.json,
    terminationReason: "api_error",
  };
}

/**
 * Attempt to generate synthetic tool calls based on "Let me [action]..." pattern
 * Approach 2: Context-aware tool generation
 * @returns {Array|null} Generated tool calls or null if not possible
 */
function attemptGenerateToolCallsFromAction(action, fullText, payload) {
  const toolCalls = [];

  // Extract common patterns from the text
  const filePathMatch = fullText.match(/(?:file|path|location):\s*([^\n,\.]+)/i);
  const filePath = filePathMatch ? filePathMatch[1].trim() : null;

  switch (action) {
    case 'read':
    case 'check':
    case 'view':
      // Generate Read tool call
      if (filePath) {
        toolCalls.push({
          id: `call_letme_read_${Date.now()}`,
          function: {
            name: 'Read',
            arguments: { file_path: filePath }
          }
        });
      }
      break;

    case 'verify':
      // Generate verification tool calls (Read or Grep)
      if (filePath) {
        toolCalls.push({
          id: `call_letme_verify_${Date.now()}`,
          function: {
            name: 'Read',
            arguments: { file_path: filePath }
          }
        });
      }
      break;

    case 'run':
    case 'execute':
      // Generate Bash tool call for running tests/commands
      if (fullText.includes('test')) {
        toolCalls.push({
          id: `call_letme_run_${Date.now()}`,
          function: {
            name: 'Bash',
            arguments: { command: 'npm run test:unit 2>&1 | tail -20', description: 'Run unit tests' }
          }
        });
      }
      break;

    case 'search':
    case 'find':
    case 'grep':
      // Generate Grep/search tool call
      const searchTermMatch = fullText.match(/(?:for|search|find)\s+["\']?([^"\'\.]+)["\']?/i);
      if (searchTermMatch) {
        toolCalls.push({
          id: `call_letme_search_${Date.now()}`,
          function: {
            name: 'Grep',
            arguments: { pattern: searchTermMatch[1], path: 'src', output_mode: 'files_with_matches' }
          }
        });
      }
      break;

    case 'edit':
    case 'update':
    case 'modify':
      // For edits, we can't generate without more context
      // Return null to fallback to retry
      return null;

    default:
      return null;
  }

  return toolCalls.length > 0 ? toolCalls : null;
}

async function runAgentLoop({
  cleanPayload,
  requestedModel,
  wantsThinking,
  session,
  cwd,
  options,
  cacheKey,
  providerType,
  headers,
}) {
  console.log('[DEBUG] runAgentLoop ENTERED - providerType:', providerType, 'messages:', cleanPayload.messages?.length, 'mode:', cleanPayload._requestMode || 'main', 'model:', cleanPayload.model);
  logger.info({ providerType, messageCount: cleanPayload.messages?.length }, 'runAgentLoop ENTERED');
  const settings = resolveLoopOptions(options);
  // Detect context window size for intelligent compression
  const contextWindowTokens = await getContextWindow();
  console.log('[DEBUG] Context window detected:', contextWindowTokens, 'tokens for provider:', providerType);
  // Initialize audit logger (no-op if disabled)
  const auditLogger = createAuditLogger(config.audit);
  const start = Date.now();
  let steps = 0;
  let toolCallsExecuted = 0;
  let fallbackPerformed = false;
  const toolCallNames = new Map();
  const toolCallHistory = new Map(); // Track tool calls to detect loops: signature -> counta
  let loopWarningInjected = false; // Track if we've already warned about loops
  let emptyResponseRetried = false; // Track if we've retried after an empty LLM response
  let invokeTextRetries = 0;        // How many times we've retried after "Invoking tool(s):" text
  const MAX_INVOKE_TEXT_RETRIES = 3; // GLM-4.7 may need multiple nudges before producing tool_calls
  let autoSpawnAttempts = 0;          // How many times we've auto-spawned a subagent for "Invoking tool(s):" text
  const MAX_AUTO_SPAWN_ATTEMPTS = 2;  // Cap auto-spawn attempts to prevent infinite loops
  let classifierRetries = 0;          // How many times we've retried after classifier detects intent-narration
  const MAX_CLASSIFIER_RETRIES = 2;   // Max retries via LLM classifier for intent-narration detection

  // Log agent loop start
  logger.info(
    {
      sessionId: session?.id ?? null,
      model: requestedModel,
      maxSteps: settings.maxSteps,
      maxDurationMs: settings.maxDurationMs,
      wantsThinking,
      providerType,
    },
    "Agent loop started",
  );

  // Emit agent loop started event for external progress listeners
  const progress = getProgressEmitter();

  // Generate unique agent ID for this agent loop execution
  const agentId = generateAgentId();

  progress.agentLoopStarted({
    sessionId: session?.id ?? null,
    agentId,
    model: requestedModel,
    maxSteps: settings.maxSteps,
    maxDurationMs: settings.maxDurationMs,
    providerType,
  });

  while (steps < settings.maxSteps) {
    if (Date.now() - start > settings.maxDurationMs) {
      break;
    }

    // Check if system is shutting down (Ctrl+C or SIGTERM)
    if (getShuttingDown()) {
      logger.info(
        {
          sessionId: session?.id ?? null,
          steps,
          toolCallsExecuted,
          durationMs: Date.now() - start,
        },
        "Agent loop interrupted - system shutting down",
      );

      return {
        response: {
          status: 503,
          body: {
            error: {
              type: "service_unavailable",
              message: "Service is shutting down. Request was interrupted gracefully.",
            },
          },
          terminationReason: "shutdown",
        },
        steps,
        durationMs: Date.now() - start,
        terminationReason: "shutdown",
      };
    }

    steps += 1;
    logger.debug(
      {
        sessionId: session?.id ?? null,
        step: steps,
        maxSteps: settings.maxSteps,
      },
      "Agent loop step",
    );

    // Emit agent loop step started event
    progress.agentLoopStepStarted({
      sessionId: session?.id ?? null,
      agentId,
      step: steps,
      maxSteps: settings.maxSteps,
    });

    // Debug: Log payload before sending to Azure
    if (providerType === "azure-anthropic") {
      logger.debug(
        {
          sessionId: session?.id ?? null,
          messageCount: cleanPayload.messages?.length ?? 0,
          messageRoles: cleanPayload.messages?.map(m => m.role) ?? [],
          lastMessage: cleanPayload.messages?.[cleanPayload.messages.length - 1],
        },
        "Azure Anthropic request payload structure",
      );
    }


    if (steps === 1 && config.historyCompression?.enabled !== false) {
      try {
        if (historyCompression.needsCompression(cleanPayload.messages)) {
          const originalMessages = cleanPayload.messages;
          cleanPayload.messages = historyCompression.compressHistory(originalMessages, {
            keepRecentTurns: config.historyCompression?.keepRecentTurns ?? 10,
            summarizeOlder: config.historyCompression?.summarizeOlder ?? true,
            enabled: true,
            contextWindowTokens,
          });

          if (cleanPayload.messages !== originalMessages) {
            const stats = historyCompression.calculateCompressionStats(originalMessages, cleanPayload.messages);
            logger.debug({
              sessionId: session?.id ?? null,
              ...stats
            }, 'History compression applied');
          }
        }
      } catch (err) {
        logger.warn({ err, sessionId: session?.id }, 'History compression failed, continuing with full history');
      }
    }

    // === MEMORY RETRIEVAL (Titans-inspired long-term memory) ===
    if (config.memory?.enabled !== false && steps === 1) {
      try {
        const memoryRetriever = require('../memory/retriever');

        // Get last user message for query
        const lastUserMessage = cleanPayload.messages
          ?.filter(m => m.role === 'user')
          ?.pop();

        if (lastUserMessage) {
          const query = memoryRetriever.extractQueryFromMessage(lastUserMessage);

          if (query) {
            const relevantMemories = memoryRetriever.retrieveRelevantMemories(query, {
              limit: config.memory.retrievalLimit ?? 5,
              sessionId: session?.id,
              includeGlobal: config.memory.includeGlobalMemories !== false,
            });

            if (relevantMemories.length > 0) {
              logger.debug({
                sessionId: session?.id ?? null,
                memoriesRetrieved: relevantMemories.length,
              }, 'Injecting long-term memories into context');

              // Inject memories into system prompt
              const injectedSystem = memoryRetriever.injectMemoriesIntoSystem(
                cleanPayload.system,
                relevantMemories,
                config.memory.injectionFormat ?? 'system',
                cleanPayload.messages // Pass recent messages for deduplication
              );

              if (typeof injectedSystem === 'string') {
                cleanPayload.system = injectedSystem;
              } else if (injectedSystem.system) {
                cleanPayload.system = injectedSystem.system;
              }
            }
          }
        }
      } catch (err) {
        logger.warn({ err, sessionId: session?.id }, 'Memory retrieval failed, continuing without memories');
      }
    }

    // [CONTEXT_FLOW] Log after memory injection
    logger.debug({
      sessionId: session?.id ?? null,
      phase: "after_memory",
      systemPromptLength: cleanPayload.system?.length ?? 0,
      messageCount: cleanPayload.messages?.length ?? 0,
      toolCount: cleanPayload.tools?.length ?? 0
    }, '[CONTEXT_FLOW] After memory injection');

    if (steps === 1 && (config.systemPrompt?.mode === 'dynamic' || config.systemPrompt?.toolDescriptions === 'minimal')) {
      try {
        // Compress tool descriptions if configured
        if (cleanPayload.tools && cleanPayload.tools.length > 0 && config.systemPrompt?.toolDescriptions === 'minimal') {
          const originalTools = cleanPayload.tools;
          cleanPayload.tools = systemPrompt.compressToolDescriptions(originalTools, 'minimal');

          const originalSize = JSON.stringify(originalTools).length;
          const compressedSize = JSON.stringify(cleanPayload.tools).length;
          const saved = originalSize - compressedSize;

          if (saved > 100) {
            logger.debug({
              sessionId: session?.id ?? null,
              toolCount: cleanPayload.tools.length,
              originalChars: originalSize,
              compressedChars: compressedSize,
              saved,
              percentage: ((saved / originalSize) * 100).toFixed(1)
            }, 'Tool descriptions compressed');
          }
        }

        // Optimize system prompt if configured
        if (cleanPayload.system && config.systemPrompt?.mode === 'dynamic') {
          const originalSystem = cleanPayload.system;
          const optimizedSystem = systemPrompt.optimizeSystemPrompt(
            originalSystem,
            {
              tools: cleanPayload.tools,
              messages: cleanPayload.messages
            },
            'dynamic'
          );

          if (optimizedSystem !== originalSystem) {
            const savings = systemPrompt.calculateSavings(originalSystem, optimizedSystem);
            cleanPayload.system = optimizedSystem;

            if (savings.tokensSaved > 50) {
              logger.debug({
                sessionId: session?.id ?? null,
                ...savings
              }, 'System prompt optimized');
            }
          }
        }
      } catch (err) {
        logger.warn({ err, sessionId: session?.id }, 'System prompt optimization failed, continuing with original');
      }
    }

    // Inject agent delegation instructions when Task tool is available (for all models)
    if (steps === 1 && config.agents?.enabled !== false) {
      try {
        const injectedSystem = systemPrompt.injectAgentInstructions(
          cleanPayload.system || '',
          cleanPayload.tools
        );
        if (injectedSystem !== cleanPayload.system) {
          cleanPayload.system = injectedSystem;
          logger.debug({
            sessionId: session?.id ?? null,
            hasTaskTool: true
          }, 'Agent delegation instructions injected into system prompt');
        }
      } catch (err) {
        logger.warn({ err, sessionId: session?.id }, 'Agent instructions injection failed, continuing without');
      }
    }

    // Inject tool termination instructions for non-Claude models
    // This helps models know when to stop calling tools and provide a text response
    if (steps === 1 && providerType !== 'databricks' && providerType !== 'azure-anthropic') {
      const toolTerminationInstruction = `

IMPORTANT TOOL USAGE RULES:
- After receiving tool results, you MUST provide a text response summarizing the results for the user.
- Do NOT call the same tool repeatedly with the same or similar parameters.
- If a tool returns results, use those results to answer the user's question.
- If a tool fails or returns unexpected results, explain this to the user instead of retrying.
- Maximum 2-3 tool calls per user request. After that, provide your best answer based on available information.
`;
      cleanPayload.system = (cleanPayload.system || '') + toolTerminationInstruction;
      logger.debug({ sessionId: session?.id ?? null }, 'Tool termination instructions injected for non-Claude model');
    }

    if (steps === 1 && config.tokenBudget?.enforcement !== false) {
      try {
        const budgetCheck = tokenBudget.checkBudget(cleanPayload);

        if (budgetCheck.atWarning) {
          logger.warn({
            sessionId: session?.id ?? null,
            totalTokens: budgetCheck.totalTokens,
            warningThreshold: budgetCheck.warningThreshold,
            maxThreshold: budgetCheck.maxThreshold,
            overMax: budgetCheck.overMax
          }, 'Approaching or exceeding token budget');

          if (budgetCheck.overMax) {
            // Apply adaptive compression to fit within budget
            const enforcement = tokenBudget.enforceBudget(cleanPayload, {
              warningThreshold: config.tokenBudget?.warning,
              maxThreshold: config.tokenBudget?.max,
              enforcement: true
            });

            if (enforcement.compressed) {
              cleanPayload = enforcement.payload;
              logger.info({
                sessionId: session?.id ?? null,
                strategy: enforcement.strategy,
                initialTokens: enforcement.stats.initialTokens,
                finalTokens: enforcement.stats.finalTokens,
                saved: enforcement.stats.saved,
                percentage: enforcement.stats.percentage,
                nowWithinBudget: !enforcement.finalBudget.overMax
              }, 'Token budget enforcement applied');
            }
          }
        }
      } catch (err) {
        logger.warn({ err, sessionId: session?.id }, 'Token budget enforcement failed, continuing without enforcement');
      }
    }

    // Track estimated token usage before model call
  console.log('[TOKEN DEBUG] About to track token usage - step:', steps);
  const estimatedTokens = config.tokenTracking?.enabled !== false
    ? tokens.countPayloadTokens(cleanPayload)
    : null;

  if (estimatedTokens && config.tokenTracking?.enabled !== false) {
    logger.debug({
      sessionId: session?.id ?? null,
      estimated: estimatedTokens,
      model: cleanPayload.model
    }, 'Estimated token usage before model call');
  }

  // Apply Headroom compression if enabled
  const headroomEstTokens = Math.ceil(JSON.stringify(cleanPayload.messages || []).length / 4);
  logger.info({
    headroomEnabled: isHeadroomEnabled(),
    messageCount: cleanPayload.messages?.length ?? 0,
    estimatedTokens: headroomEstTokens,
    threshold: config.headroom?.minTokens || 500,
    willCompress: isHeadroomEnabled() && headroomEstTokens >= (config.headroom?.minTokens || 500),
  }, 'Headroom compression check');

  if (isHeadroomEnabled() && cleanPayload.messages && cleanPayload.messages.length > 0) {
    try {
      const compressionResult = await headroomCompress(
        cleanPayload.messages,
        cleanPayload.tools || [],
        {
          mode: config.headroom?.mode,
          queryContext: cleanPayload.messages[cleanPayload.messages.length - 1]?.content,
        }
      );

      logger.info({
        compressed: compressionResult.compressed,
        tokensBefore: compressionResult.stats?.tokens_before,
        tokensAfter: compressionResult.stats?.tokens_after,
        savings: compressionResult.stats?.savings_percent ? `${compressionResult.stats.savings_percent}%` : 'N/A',
        reason: compressionResult.stats?.reason || compressionResult.stats?.transforms_applied?.join(', ') || 'none',
      }, 'Headroom compression result');

      if (compressionResult.compressed) {
        cleanPayload.messages = compressionResult.messages;
        if (compressionResult.tools) {
          cleanPayload.tools = compressionResult.tools;
        }
        logger.info({
          sessionId: session?.id ?? null,
          tokensBefore: compressionResult.stats?.tokens_before,
          tokensAfter: compressionResult.stats?.tokens_after,
          saved: compressionResult.stats?.tokens_saved,
          savingsPercent: compressionResult.stats?.savings_percent,
          transforms: compressionResult.stats?.transforms_applied,
        }, 'Headroom compression applied to request');
      } else {
        logger.debug({
          sessionId: session?.id ?? null,
          reason: compressionResult.stats?.reason,
        }, 'Headroom compression skipped');
      }
    } catch (headroomErr) {
      logger.warn({ err: headroomErr, sessionId: session?.id ?? null }, 'Headroom compression failed, using original messages');
    }
  }

  // Generate correlation ID for request/response pairing
  const correlationId = `req_${Date.now()}_${crypto.randomBytes(8).toString('hex')}`;

  // Log LLM request before invocation
  if (auditLogger.enabled) {
    auditLogger.logLlmRequest({
      correlationId,
      sessionId: session?.id ?? null,
      provider: providerType,
      model: cleanPayload.model,
      stream: cleanPayload.stream ?? false,
      destinationUrl: getDestinationUrl(providerType),
      userMessages: cleanPayload.messages,
      systemPrompt: cleanPayload.system,
      tools: cleanPayload.tools,
      maxTokens: cleanPayload.max_tokens,
    });
  }

  // Check if tools are in the request and determine provider routing
  const hasTools = Array.isArray(cleanPayload.tools) && cleanPayload.tools.length > 0;

  // Check if last message is a tool result
  const lastMessage = cleanPayload.messages?.[cleanPayload.messages.length - 1];
  const hasToolResults = lastMessage?.role === 'tool';

  let shouldUseToolProvider = false;
  let providerForThisCall = providerType;

  // DEBUG: Log the condition check
  logger.info({
    sessionId: session?.id ?? null,
    hasTools,
    toolCount: cleanPayload.tools?.length || 0,
    hasToolResults,
    lastMessageRole: lastMessage?.role,
    configToolExecutionProvider: config.toolExecutionProvider,
    providerType,
    willTrigger: hasTools && !hasToolResults && hasDedicatedToolModel(providerType)
  }, "Tool execution provider condition check");

  // Only use tool execution provider if:
  // 1. We have tools available
  // 2. We DON'T have tool results (not processing results from a previous call)
  // 3. A dedicated tool model is configured (different provider OR same provider with different model)
  if (hasTools && !hasToolResults && hasDedicatedToolModel(providerType)) {
    shouldUseToolProvider = true;
    providerForThisCall = config.toolExecutionProvider;

    logger.info({
      sessionId: session?.id ?? null,
      conversationProvider: providerType,
      toolProvider: config.toolExecutionProvider,
      toolModel: config.toolExecutionModel || 'default',
      toolCount: cleanPayload.tools.length,
      compareMode: config.toolExecutionCompareMode
    }, "Using tool execution provider for tool calling decision");
  } else if (hasToolResults) {
    // When a dedicated tool model handles tool calling, strip tools from the
    // result-processing payload. The conversation model only needs to summarize
    // the result — if it wants to make more tool calls, the next iteration will
    // route back to the tool model anyway.
    if (hasDedicatedToolModel(providerType) && hasTools) {
      const strippedCount = cleanPayload.tools?.length || 0;
      delete cleanPayload.tools;
      delete cleanPayload.tool_choice;
      logger.info({
        sessionId: session?.id ?? null,
        provider: providerType,
        conversationModel: providerType === 'ollama' ? config.ollama?.model : config.openrouter?.model,
        strippedToolCount: strippedCount
      }, "Stripped tools from tool-results call - dedicated tool model handles tool decisions");
    }
    logger.info({
      sessionId: session?.id ?? null,
      provider: providerType
    }, "Processing tool results - using conversation provider");
  }

  let databricksResponse;
  let conversationResponse = null;

  // Emit model invocation started event
  const modelInvocationStartTime = Date.now();

  // Determine the actual model being invoked (not the CLI-side model)
  const effectiveModel = providerType === 'ollama'
    ? (config.ollama?.model || requestedModel)
    : requestedModel;

  progress.modelInvocationStarted({
    sessionId: session?.id ?? null,
    agentId,
    step: steps,
    model: effectiveModel,
    providerType,
    estimatedTokens: cleanPayload._estimatedTokens,
  });

  try {
    if (shouldUseToolProvider) {
      // Build request for tool execution provider
      const toolExecutionPayload = {
        ...cleanPayload,
        model: config.toolExecutionModel || cleanPayload.model,
        _requestMode: 'tool_execution',
      };

      try {
        // Call tool execution provider
        databricksResponse = await invokeModel(toolExecutionPayload, {
          forceProvider: config.toolExecutionProvider,
          callPurpose: 'tool_execution'
        });

        // If compare mode enabled, also call conversation provider
        if (config.toolExecutionCompareMode) {
          logger.info({ sessionId: session?.id ?? null },
            "Compare mode enabled - calling conversation provider too");

          try {
            conversationResponse = await invokeModel(cleanPayload, {
              forceProvider: providerType,
              callPurpose: 'conversation'
            });
          } catch (convErr) {
            logger.warn({ error: convErr.message },
              "Conversation provider call failed in compare mode");
          }
        }
      } catch (toolProviderError) {
        logger.error({
          error: toolProviderError.message,
          toolProvider: config.toolExecutionProvider
        }, "Tool execution provider failed, falling back to conversation provider");

        // Fallback to conversation provider
        databricksResponse = await invokeModel(cleanPayload, {
          forceProvider: providerType,
          callPurpose: 'conversation'
        });
      }
    } else {
      // Normal flow - use conversation provider
      databricksResponse = await invokeModel(cleanPayload);
    }
  } catch (modelError) {
    // Check for Ollama-specific model errors first
    if (providerType === 'ollama' && modelError.message) {
      const errorMsg = modelError.message.toLowerCase();

      // Model not loaded or not found
      if (errorMsg.includes('model') && (errorMsg.includes('not found') || errorMsg.includes('not loaded') || errorMsg.includes('unavailable'))) {
        logger.error({
          provider: providerType,
          model: config.ollama?.model,
          error: modelError.message
        }, "Ollama model unavailable");

        return {
          response: {
            status: 503,
            body: {
              error: {
                type: "model_unavailable",
                message: modelError.message,
              },
            },
            terminationReason: "model_unavailable",
          },
          steps,
          durationMs: Date.now() - start,
          terminationReason: "model_unavailable",
        };
      }

      // Check if Ollama service is unreachable (specific check for Ollama)
      if (errorMsg.includes('unreachable') || errorMsg.includes('is it running')) {
        logger.error({
          provider: providerType,
          endpoint: config.ollama?.endpoint ?? config.ollama?.cloudEndpoint,
          error: modelError.message
        }, "Ollama service unreachable");

        return {
          response: {
            status: 503,
            body: {
              error: {
                type: "provider_unreachable",
                message: modelError.message,
              },
            },
            terminationReason: "provider_unreachable",
          },
          steps,
          durationMs: Date.now() - start,
          terminationReason: "provider_unreachable",
        };
      }
    }

    // Generic connection error check (for all providers)
    const isConnectionError = modelError.cause?.code === 'ECONNREFUSED'
      || modelError.message?.includes('fetch failed')
      || modelError.code === 'ECONNREFUSED';

    if (isConnectionError) {
      const endpoint = config[providerType]?.endpoint || config[providerType]?.url || 'unknown';
      logger.error({
        provider: providerType,
        endpoint,
        error: modelError.message
      }, `Provider ${providerType} connection refused`);

      return {
        response: {
          status: 503,
          body: {
            error: {
              type: "provider_unreachable",
              message: `Provider ${providerType} is unreachable at ${endpoint}. Is the service running?`,
            },
          },
          terminationReason: "provider_unreachable",
        },
        steps,
        durationMs: Date.now() - start,
        terminationReason: "provider_unreachable",
      };
    }

    throw modelError;
  }

  // Extract and log actual token usage
  const actualUsage = databricksResponse.ok && config.tokenTracking?.enabled !== false
    ? tokens.extractUsageFromResponse(databricksResponse.json)
    : null;

  if (estimatedTokens && actualUsage && config.tokenTracking?.enabled !== false) {
    tokens.logTokenUsage('model_invocation', estimatedTokens, actualUsage);

    // Record in session metadata
    if (session) {
      tokens.recordTokenUsage(session, steps, estimatedTokens, actualUsage, cleanPayload.model);
    }
  }

  // Emit model invocation completed event
  const modelInvocationDurationMs = Date.now() - modelInvocationStartTime;
  progress.modelInvocationCompleted({
    sessionId: session?.id ?? null,
    agentId,
    step: steps,
    model: requestedModel,
    providerType,
    inputTokens: actualUsage?.input_tokens ?? actualUsage?.prompt_tokens ?? null,
    outputTokens: actualUsage?.output_tokens ?? actualUsage?.completion_tokens ?? null,
    durationMs: modelInvocationDurationMs,
  });

  // Log LLM response after invocation
  if (auditLogger.enabled) {
    const latencyMs = Date.now() - start;

    if (databricksResponse.stream) {
      // Log streaming response (no content, just metadata)
      auditLogger.logLlmResponse({
        correlationId,
        sessionId: session?.id ?? null,
        provider: providerType,
        model: cleanPayload.model,
        stream: true,
        destinationUrl: getDestinationUrl(providerType),
        status: databricksResponse.status,
        latencyMs,
        streamingNote: 'Content streamed directly to client, not captured in audit log',
      });
    } else if (databricksResponse.ok && databricksResponse.json) {
      // Log successful non-streaming response
      const message = databricksResponse.json;
      const assistantMessage = message.content ?? message.choices?.[0]?.message;

      auditLogger.logLlmResponse({
        correlationId,
        sessionId: session?.id ?? null,
        provider: providerType,
        model: cleanPayload.model,
        stream: false,
        destinationUrl: getDestinationUrl(providerType),
        assistantMessage,
        stopReason: message.stop_reason ?? message.choices?.[0]?.finish_reason ?? null,
        requestTokens: actualUsage?.input_tokens ?? actualUsage?.prompt_tokens ?? null,
        responseTokens: actualUsage?.output_tokens ?? actualUsage?.completion_tokens ?? null,
        latencyMs,
        status: databricksResponse.status,
      });
    } else {
      // Log error response
      auditLogger.logLlmResponse({
        correlationId,
        sessionId: session?.id ?? null,
        provider: providerType,
        model: cleanPayload.model,
        stream: false,
        destinationUrl: getDestinationUrl(providerType),
        status: databricksResponse.status,
        latencyMs,
        error: databricksResponse.text ?? databricksResponse.json ?? 'Unknown error',
      });
    }
  }
    logger.info({
      messageContent: databricksResponse.json?.message?.content
        ? (typeof databricksResponse.json.message.content === 'string'
          ? databricksResponse.json.message.content.substring(0, 500)
          : JSON.stringify(databricksResponse.json.message.content).substring(0, 500))
        : 'NO_CONTENT',
      hasToolCalls: !!databricksResponse.json?.message?.tool_calls,
      toolCallCount: databricksResponse.json?.message?.tool_calls?.length || 0
    }, "=== RAW LLM RESPONSE CONTENT ===");

    // Handle streaming responses (pass through without buffering)
    if (databricksResponse.stream) {
      logger.debug(
        {
          sessionId: session?.id ?? null,
          status: databricksResponse.status,
        },
        "Streaming response received, passing through"
      );
      return {
        response: buildStreamingResponse(databricksResponse),
        steps,
        durationMs: Date.now() - start,
        terminationReason: "streaming",
      };
    }

    if (!databricksResponse.json) {
      appendTurnToSession(session, {
        role: "assistant",
        type: "error",
        status: databricksResponse.status,
        content: databricksResponse.text ?? "",
        metadata: { termination: "non_json_response" },
      });
      const response = buildNonJsonResponse(databricksResponse);
      logger.warn(
        {
          sessionId: session?.id ?? null,
          status: response.status,
          termination: response.terminationReason,
        },
        "Agent loop terminated without JSON",
      );
      return {
        response,
        steps,
        durationMs: Date.now() - start,
        terminationReason: response.terminationReason,
      };
    }

    if (!databricksResponse.ok) {
      appendTurnToSession(session, {
        role: "assistant",
        type: "error",
        status: databricksResponse.status,
        content: databricksResponse.json,
        metadata: { termination: "api_error" },
      });

      const response = buildErrorResponse(databricksResponse);
      logger.error(
        {
          sessionId: session?.id ?? null,
          status: response.status,
        },
        "Agent loop encountered API error",
      );
      return {
        response,
        steps,
        durationMs: Date.now() - start,
        terminationReason: response.terminationReason,
      };
    }

    // Extract message and tool calls based on provider response format
    let message = {};
    let toolCalls = [];

    // Detect Anthropic format: has 'content' array and 'stop_reason' at top level (no 'choices')
    // This handles azure-anthropic provider AND azure-openai Responses API (which we convert to Anthropic format)
    const isAnthropicFormat = providerType === "azure-anthropic" ||
      (Array.isArray(databricksResponse.json?.content) && databricksResponse.json?.stop_reason !== undefined && !databricksResponse.json?.choices);

    if (isAnthropicFormat) {
      // Anthropic format: { content: [{ type: "tool_use", ... }], stop_reason: "tool_use" }
      message = {
        content: databricksResponse.json?.content ?? [],
        stop_reason: databricksResponse.json?.stop_reason,
      };
      // Extract tool_use blocks from content array
      const contentArray = Array.isArray(databricksResponse.json?.content)
        ? databricksResponse.json.content
        : [];
      toolCalls = contentArray
        .filter(block => block?.type === "tool_use")
        .map(block => ({
          id: block.id,
          function: {
            name: block.name,
            arguments: JSON.stringify(block.input ?? {}),
          },
          // Keep original block for reference
          _anthropic_block: block,
        }));

      logger.info(
        {
          sessionId: session?.id ?? null,
          step: steps,
          contentBlocks: contentArray.length,
          toolCallsFound: toolCalls.length,
          toolNames: toolCalls.map(tc => tc.function?.name || tc.name),
          stopReason: databricksResponse.json?.stop_reason,
        },
        "Azure Anthropic response parsed",
      );
    } else if (providerType === "ollama") {
      // Ollama format: { message: { role, content, tool_calls }, done }
      message = databricksResponse.json?.message ?? {};
      toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];

      // FALLBACK: If no native tool_calls but text contains tool patterns,
      // extract them using per-model parser (model responded with text instead of tool call format)
      if (toolCalls.length === 0 && message.content && typeof message.content === 'string') {
        const { getParserForModel } = require("../parsers");
        const modelName = config.ollama?.model;
        const parser = getParserForModel(modelName);
        const extracted = parser.extractToolCallsFromText(message.content);
        if (extracted && extracted.length > 0) {
          logger.info({
            extractedCount: extracted.length,
            toolNames: extracted.map(tc => tc.function?.name),
            model: modelName,
            parser: parser.constructor.name,
            originalText: message.content.substring(0, 200),
          }, "[TOOL_EXTRACTION_FALLBACK] Extracted tool calls from Ollama text response (via parser)");
          toolCalls = extracted;
          // Clear text content to prevent double display (command text + tool result)
          message.content = "";
        }
      }

      logger.info({
        hasMessage: !!databricksResponse.json?.message,
        hasToolCalls: toolCalls.length > 0,
        toolCallCount: toolCalls.length,
        toolNames: toolCalls.map(tc => tc.function?.name),
        done: databricksResponse.json?.done,
        fullToolCalls: JSON.stringify(toolCalls),
        fullResponseMessage: JSON.stringify(databricksResponse.json?.message)
      }, "=== OLLAMA TOOL CALLS EXTRACTION ===");

      // Deduplicate tool calls for Ollama format
      if (toolCalls.length > 0) {
        const uniqueToolCalls = [];
        const seenSignatures = new Set();
        let duplicatesRemoved = 0;

        for (const call of toolCalls) {
          const signature = getToolCallSignature(call);
          if (!seenSignatures.has(signature)) {
            seenSignatures.add(signature);
            uniqueToolCalls.push(call);
          } else {
            duplicatesRemoved++;
            logger.warn({
              sessionId: session?.id ?? null,
              toolName: call.function?.name || call.name,
              toolId: call.id,
              signature: signature.substring(0, 32),
            }, "Duplicate tool call removed (same tool with identical parameters in single response)");
          }
        }

        toolCalls = uniqueToolCalls;

        logger.info(
          {
            sessionId: session?.id ?? null,
            step: steps,
            toolCallsFound: toolCalls.length,
            duplicatesRemoved,
            toolNames: toolCalls.map(tc => tc.function?.name || tc.name),
          },
          "LLM Response: Tool calls requested (after deduplication)",
        );
      }
    } else {
      // OpenAI/Databricks format: { choices: [{ message: { tool_calls: [...] } }] }
      const choice = databricksResponse.json?.choices?.[0];
      message = choice?.message ?? {};
      toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];

      // Deduplicate tool calls for OpenAI format too
      if (toolCalls.length > 0) {
        const uniqueToolCalls = [];
        const seenSignatures = new Set();
        let duplicatesRemoved = 0;

        for (const call of toolCalls) {
          const signature = getToolCallSignature(call);
          if (!seenSignatures.has(signature)) {
            seenSignatures.add(signature);
            uniqueToolCalls.push(call);
          } else {
            duplicatesRemoved++;
            logger.warn({
              sessionId: session?.id ?? null,
              toolName: call.function?.name || call.name,
              toolId: call.id,
              signature: signature.substring(0, 32),
            }, "Duplicate tool call removed (same tool with identical parameters in single response)");
          }
        }

        toolCalls = uniqueToolCalls;

        logger.info(
          {
            sessionId: session?.id ?? null,
            step: steps,
            toolCallsFound: toolCalls.length,
            duplicatesRemoved,
            toolNames: toolCalls.map(tc => tc.function?.name || tc.name),
          },
          "LLM Response: Tool calls requested (after deduplication)",
        );
      }
    }

    // Guard: drop hallucinated tool calls when no tools were sent to the model.
    // Some models (e.g. Llama 3.1) hallucinate tool_call blocks from conversation
    // history even when the request contained zero tool definitions.
    // For Ollama, the client injects STANDARD_TOOLS independently of cleanPayload.tools,
    // so only treat tool calls as hallucinated if _noToolInjection was explicitly set.
    const ollamaToolsInjected = providerType === 'ollama' && !cleanPayload._noToolInjection;
    const toolsWereSent = (Array.isArray(cleanPayload.tools) && cleanPayload.tools.length > 0) || ollamaToolsInjected;
    if (toolCalls.length > 0 && !toolsWereSent) {
      logger.warn({
        sessionId: session?.id ?? null,
        step: steps,
        hallucinated: toolCalls.map(tc => tc.function?.name || tc.name),
        noToolInjection: !!cleanPayload._noToolInjection,
      }, "Dropped hallucinated tool calls (no tools were sent to model)");
      toolCalls = [];
      // If there's also no text content, treat as empty response (handled below)
    }

    // If compare mode is enabled and we have both responses, compare tool calls
    let toolCallComparison = null;
    if (config.toolExecutionCompareMode && conversationResponse?.json && shouldUseToolProvider) {
      const conversationToolCalls = extractToolCallsFromResponse(
        conversationResponse.json,
        providerType
      );

      if (conversationToolCalls.length > 0 || toolCalls.length > 0) {
        const comparison = compareAndSelectToolCalls(
          conversationToolCalls,
          toolCalls,
          { sessionId: session?.id ?? null }
        );

        // Use selected tool calls
        toolCalls = comparison.toolCalls;
        toolCallComparison = comparison;

        // Log comparison result
        logger.info({
          sessionId: session?.id ?? null,
          selectedProvider: comparison.selectedProvider,
          reason: comparison.reason,
          scores: comparison.scores
        }, "Tool call comparison complete");
      }
    }

    // === EMPTY RESPONSE DETECTION (primary) ===
    // Check raw extracted message for empty content before tool handling or conversion
    const rawTextContent = (() => {
      if (typeof message.content === 'string') return message.content.trim();
      if (Array.isArray(message.content)) {
        return message.content
          .filter(b => b.type === 'text')
          .map(b => b.text || '')
          .join('')
          .trim();
      }
      return '';
    })();

    if (toolCalls.length === 0 && !rawTextContent) {
      console.log('[EMPTY RESPONSE] No text content and no tool calls - step:', steps, 'retried:', emptyResponseRetried);
      logger.warn({
        sessionId: session?.id ?? null,
        step: steps,
        messageKeys: Object.keys(message),
        contentType: typeof message.content,
        rawContentPreview: String(message.content || '').substring(0, 100),
      }, "Empty LLM response detected (no text, no tool calls)");

      // Retry once with a nudge
      if (steps < settings.maxSteps && !emptyResponseRetried) {
        emptyResponseRetried = true;
        cleanPayload.messages.push({
          role: "assistant",
          content: "",
        });
        cleanPayload.messages.push({
          role: "user",
          content: "Please provide a response to the user's message.",
        });
        logger.info({ sessionId: session?.id ?? null }, "Retrying after empty response with nudge");
        continue;
      }

      // Fallback after retry also returned empty
      logger.warn({ sessionId: session?.id ?? null, steps }, "Empty response persisted after retry");
      return {
        response: {
          status: 200,
          body: {
            id: `msg_${Date.now()}`,
            type: "message",
            role: "assistant",
            model: requestedModel,
            content: [{ type: "text", text: "I wasn't able to generate a response. Could you try rephrasing your message?" }],
            stop_reason: "end_turn",
            usage: { input_tokens: 0, output_tokens: 0 },
          },
          terminationReason: "empty_response_fallback",
        },
        steps,
        durationMs: Date.now() - start,
        terminationReason: "empty_response_fallback",
      };
    }

    // === "Invoking tool(s):" TEXT DETECTION ===
    // Some models (GLM-4.7, etc.) respond with "Invoking tool(s): Read, Read, Read" as TEXT
    // instead of actual tool_calls. Always detect and log this pattern — even when tool_calls
    // ARE present — so developers can diagnose tool dispatch issues across execution modes.
    // GLM-4.7 also leaks XML/think tags into the content (e.g. "Grep</arg_value>", "Glob</think>").
    const invokingToolMatch = rawTextContent &&
      /Invoking tool\(s\):\s*(.+)/im.exec(rawTextContent.trim());
    // Extract mentioned tools from "Invoking tool(s):" text (hoisted for use by auto-spawn below)
    let mentionedToolsRaw = [];
    if (invokingToolMatch) {
      // Clean garbled XML/think tags from tool names (GLM-4.7 leaks </arg_value>, </think>, etc.)
      mentionedToolsRaw = invokingToolMatch[1]
        .replace(/<\/?\w+[^>]*>/g, '')  // strip any XML/HTML tags
        .split(',')
        .map(t => t.trim())
        .filter(Boolean);
      const executionModeCurrent = config.toolExecutionMode || "server";
      const toolsStrippedBySmartSelection = !!cleanPayload._noToolInjection;
      const toolsInPayload = Array.isArray(cleanPayload.tools) ? cleanPayload.tools.length : 0;
      logger.warn({
        sessionId: session?.id ?? null,
        step: steps,
        mentionedTools: mentionedToolsRaw,   // Full list, no dedup (e.g. ["Read", "Read", "Read"])
        mentionedToolCount: mentionedToolsRaw.length,
        actualToolCallCount: toolCalls.length,
        hasActualToolCalls: toolCalls.length > 0,
        executionMode: executionModeCurrent,  // "server", "client", or "passthrough"
        toolsStrippedBySmartSelection,        // true = smart-selection removed tools from request
        toolsInPayload,                       // how many tool defs are currently in the payload
        invokeTextRetries,                    // how many retries we've done so far
        model: requestedModel,
        rawText: rawTextContent.substring(0, 300),
      }, `Model output 'Invoking tool(s):' as text — actualToolCalls=${toolCalls.length}, mode=${executionModeCurrent}, toolsStripped=${toolsStrippedBySmartSelection}, retry=${invokeTextRetries}/${MAX_INVOKE_TEXT_RETRIES}`);
    }

    // Handle "Invoking tool(s):" text with NO actual tool_calls:
    // 1. Try auto-spawning a subagent to fulfil the model's intent
    // 2. Fall back to nudge-retry if subagent is disabled or fails
    if (invokingToolMatch && toolCalls.length === 0 && steps < settings.maxSteps) {

      // --- Auto-spawn subagent ---
      if (config.agents?.enabled && config.agents?.autoSpawn !== false && autoSpawnAttempts < MAX_AUTO_SPAWN_ATTEMPTS) {
        autoSpawnAttempts++;
        const uniqueMentionedTools = [...new Set(mentionedToolsRaw)];
        const agentType = mapToolsToAgentType(uniqueMentionedTools);
        const userText = extractLastUserText(cleanPayload.messages);
        const prompt = buildSubagentPrompt(userText, rawTextContent, uniqueMentionedTools);

        logger.info({
          sessionId: session?.id ?? null,
          step: steps,
          agentType,
          mentionedTools: mentionedToolsRaw,
          autoSpawnAttempt: autoSpawnAttempts,
        }, `Auto-spawning ${agentType} subagent for 'Invoking tool(s):' text (attempt ${autoSpawnAttempts}/${MAX_AUTO_SPAWN_ATTEMPTS})`);

        try {
          const result = await spawnAgent(agentType, prompt, { sessionId: session?.id ?? null, mainContext: cleanPayload.messages });
          if (result.success) {
            // Inject model's text as assistant msg + subagent result as user msg
            cleanPayload.messages.push({ role: "assistant", content: rawTextContent });
            cleanPayload.messages.push({
              role: "user",
              content: `[Subagent ${agentType} completed]\n${result.result}`,
            });
            logger.info({
              sessionId: session?.id ?? null,
              step: steps,
              agentType,
              resultLength: result.result?.length ?? 0,
            }, "Subagent completed successfully — injecting result into conversation");
            continue; // Re-enter loop so the model can synthesize the subagent output
          }
          logger.warn({ sessionId: session?.id ?? null, step: steps, error: result.error }, "Subagent returned failure — falling through to nudge");
        } catch (err) {
          logger.warn({ sessionId: session?.id ?? null, step: steps, error: err.message }, "Subagent spawn failed — falling through to nudge");
        }
      }

      // --- Nudge-retry fallback ---
      if (invokeTextRetries < MAX_INVOKE_TEXT_RETRIES) {
        invokeTextRetries++;

        // === LONG-TERM ROBUSTNESS: Always keep core tools ===
        // Set flag to prevent smart-selection from stripping core tools on retry
        // Core tools (Read, Write, Edit, Bash, Grep, Glob) are essential for the agent to function
        // and should never be filtered out regardless of request classification.
        cleanPayload._invokeTextRetry = true;

        // Smart-selection may have stripped tools from this request (classified as "conversation").
        // The model clearly WANTS to use tools, so restore them for the retry.
        if (cleanPayload._noToolInjection || !Array.isArray(cleanPayload.tools) || cleanPayload.tools.length === 0) {
          const { STANDARD_TOOLS } = require('../clients/standard-tools');
          cleanPayload.tools = STANDARD_TOOLS;
          delete cleanPayload._noToolInjection;
          logger.info({
            sessionId: session?.id ?? null,
            step: steps,
            restoredToolCount: STANDARD_TOOLS.length,
          }, "Restored STANDARD_TOOLS for 'Invoking tool(s):' retry — smart-selection had stripped them");
        }

        // Feed the model's text back and tell it to use actual tool calls
        cleanPayload.messages.push({
          role: "assistant",
          content: rawTextContent,
        });
        cleanPayload.messages.push({
          role: "user",
          content: `You responded with tool invocation text instead of using actual tool calls (attempt ${invokeTextRetries}/${MAX_INVOKE_TEXT_RETRIES}). `
            + "Please use the tool_call format, not text. Call the tools now with the correct parameters.",
        });
        continue;
      }
    }

    // LLM-classifier route: ask the same model if this text indicates suppressed tool-call intent
    if (
      toolCalls.length === 0 &&
      rawTextContent &&
      classifierRetries < MAX_CLASSIFIER_RETRIES
    ) {
      try {
        const classifierPrompt =
          `You are a classifier. Answer only YES or NO.\n\n` +
          `Does the following model response indicate the model INTENDS to call a tool ` +
          `(e.g. "Let me read...", "I'll create...", "Now let me run...", "I need to check...") ` +
          `but did NOT actually emit a tool call?\n\n` +
          `Model response:\n"""\n${rawTextContent.slice(0, 500)}\n"""\n\n` +
          `Answer YES if narrating tool intent. Answer NO if it is a complete, informational, or conversational response.`;

        const classifierResponse = await invokeModel(
          {
            model:       cleanPayload.model,
            messages:    [{ role: 'user', content: classifierPrompt }],
            max_tokens:  10,
            temperature: 0,
          },
          { forceProvider: providerType, callPurpose: 'classifier' }
        );

        const classifierText = (
          classifierResponse.json?.message?.content ??
          classifierResponse.json?.choices?.[0]?.message?.content ??
          ''
        ).trim().toUpperCase();

        logger.info({
          sessionId: session?.id ?? null,
          step: steps,
          classifierModel: config.classifierModel,
          classifierAnswer: classifierText,
          rawTextPreview: rawTextContent.slice(0, 100),
          classifierRetries,
        }, `[CLASSIFIER] Intent-narration check: ${classifierText}`);

        if (classifierText.startsWith('YES')) {
          classifierRetries++;
          cleanPayload._invokeTextRetry = true;

          // Restore tools if smart-selection stripped them
          if (cleanPayload._noToolInjection || !Array.isArray(cleanPayload.tools) || cleanPayload.tools.length === 0) {
            const { STANDARD_TOOLS } = require('../clients/standard-tools');
            cleanPayload.tools = STANDARD_TOOLS;
            delete cleanPayload._noToolInjection;
            logger.info(
              { restoredToolCount: STANDARD_TOOLS.length },
              '[CLASSIFIER] Restored STANDARD_TOOLS for classifier retry'
            );
          }

          cleanPayload.messages.push({ role: 'assistant', content: rawTextContent });
          cleanPayload.messages.push({
            role: 'user',
            content: `Please stop narrating what you are about to do and just call the tools directly ` +
                     `(classifier retry ${classifierRetries}/${MAX_CLASSIFIER_RETRIES}).`,
          });

          logger.info({
            sessionId: session?.id ?? null,
            step: steps,
            variant: 'CLASSIFIER_RETRY',
            retryCount: classifierRetries,
          }, '[LET-ME] Executing: Classifier Retry (YES detected)');

          continue;
        }

        // ===== APPROACH 1 & 2: Smart narration pattern detection with tool generation =====
        // Match: "Let me...", "Now let me...", "First let me...", "I'll...", "I'm going to..."
        const narrationPatterns = [
          /^(?:Now\s+|First\s+)?Let me\s+(\w+)/i,
          /^I'll\s+(\w+)/i,
          /^I'm going to\s+(\w+)/i,
          /^Let me\s+(\w+)/i,
        ];

        let letMeMatch = null;
        for (const pattern of narrationPatterns) {
          letMeMatch = rawTextContent.match(pattern);
          if (letMeMatch) break;
        }

        if (letMeMatch && (!classifierText || classifierText.trim().length === 0)) {
          const action = letMeMatch[1].toLowerCase();

          logger.info({
            sessionId: session?.id ?? null,
            step: steps,
            detectedAction: action,
            classifierAnswer: classifierText || '(empty)',
            rawPreview: rawTextContent.slice(0, 100),
          }, `[LET-ME] Detected "Let me ${action}..." pattern`);

          // Attempt Approach 2: Generate synthetic tool calls for common actions
          const generatedToolCalls = attemptGenerateToolCallsFromAction(action, rawTextContent, cleanPayload);

          if (generatedToolCalls && generatedToolCalls.length > 0) {
            // Approach 2 succeeded - inject synthetic tool calls
            logger.info({
              sessionId: session?.id ?? null,
              step: steps,
              variant: 'AUTO_TOOL_GENERATION',
              action: action,
              generatedCount: generatedToolCalls.length,
              toolNames: generatedToolCalls.map(tc => tc.name || tc.function?.name),
            }, '[LET-ME] Executing: Auto Tool Generation (Approach 2)');

            // Inject the synthetic tool calls
            cleanPayload.messages.push({ role: 'assistant', content: rawTextContent });
            toolCalls = generatedToolCalls;
            // Skip the normal tool call processing and go straight to execution
            if (toolCalls.length > 0) {
              // Mark that we're using synthetic calls from "Let me..." pattern
              cleanPayload._letMeSynthetic = true;
            }
          } else {
            // Approach 2 failed or not applicable - fallback to Approach 1: Smart retry
            logger.info({
              sessionId: session?.id ?? null,
              step: steps,
              variant: 'SMART_RETRY',
              action: action,
            }, '[LET-ME] Executing: Smart Retry (Approach 1) - tool generation not possible');

            classifierRetries++;
            cleanPayload._invokeTextRetry = true;

            // Restore tools if smart-selection stripped them
            if (cleanPayload._noToolInjection || !Array.isArray(cleanPayload.tools) || cleanPayload.tools.length === 0) {
              const { STANDARD_TOOLS } = require('../clients/standard-tools');
              cleanPayload.tools = STANDARD_TOOLS;
              delete cleanPayload._noToolInjection;
            }

            cleanPayload.messages.push({ role: 'assistant', content: rawTextContent });
            cleanPayload.messages.push({
              role: 'user',
              content: `Don't narrate what you're about to do - actually execute the ${action} operation now by calling the appropriate tools directly.`,
            });

            continue;
          }
        }
      } catch (err) {
        logger.warn(
          { sessionId: session?.id ?? null, step: steps, err: err.message },
          '[CLASSIFIER] Classifier call failed — falling through to normal response'
        );
      }
    }

    if (toolCalls.length > 0) {
      // Convert OpenAI/OpenRouter format to Anthropic format for session storage
      let sessionContent;
      if (providerType === "azure-anthropic") {
        // Azure Anthropic already returns content in Anthropic
        sessionContent = databricksResponse.json?.content ?? [];
      } else {
        // Convert OpenAI/OpenRouter format to Anthropic content blocks
        const contentBlocks = [];

        // Add text content if present
        if (message.content && typeof message.content === 'string' && message.content.trim()) {
          contentBlocks.push({
            type: "text",
            text: message.content
          });
        }

        // Add tool_use blocks from tool_calls
        for (const toolCall of toolCalls) {
          const func = toolCall.function || {};
          let input = {};

          // Parse arguments string to object
          if (func.arguments) {
            try {
              input = typeof func.arguments === "string"
                ? JSON.parse(func.arguments)
                : func.arguments;
            } catch (err) {
              logger.warn({
                error: err.message,
                arguments: func.arguments
              }, "Failed to parse tool arguments for session storage");
              input = {};
            }
          }

          contentBlocks.push({
            type: "tool_use",
            id: toolCall.id || `toolu_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
            name: func.name || toolCall.name || "unknown",
            input
          });
        }

        sessionContent = contentBlocks;
      }

      appendTurnToSession(session, {
        role: "assistant",
        type: "tool_request",
        status: 200,
        content: sessionContent,
        metadata: {
          termination: "tool_use",
          toolCalls: toolCalls.map((call) => ({
            id: call.id,
            name: call.function?.name ?? call.name,
          })),
        },
      });

      let assistantToolMessage;
      if (providerType === "azure-anthropic") {
        // For Azure Anthropic, use the content array directly from the response
        // It already contains both text and tool_use blocks in the correct format
        assistantToolMessage = {
          role: "assistant",
          content: databricksResponse.json?.content ?? [],
        };
      } else {
        assistantToolMessage = {
          role: "assistant",
          content: message.content ?? "",
          tool_calls: message.tool_calls,
        };
      }

      // Only add fallback content for Databricks format (Azure already has content)
      if (
        providerType !== "azure-anthropic" &&
        (!assistantToolMessage.content ||
          (typeof assistantToolMessage.content === "string" &&
            assistantToolMessage.content.trim().length === 0)) &&
        toolCalls.length > 0
      ) {
        const toolNames = toolCalls
          .map((call) => call.function?.name ?? "tool")
          .join(", ");
        assistantToolMessage.content = `[tool-calls: ${toolNames}]`;
      }

      cleanPayload.messages.push(assistantToolMessage);

      // === UNIVERSAL TOOL CALL CLEANING (via per-model parser) ===
      // Clean all tool calls by extracting commands from markdown formatting
      // This runs for ALL providers, not just as an Ollama fallback
      if (toolCalls && toolCalls.length > 0) {
        const { cleanToolCalls } = require('../tools/tool-call-cleaner');
        toolCalls = cleanToolCalls(toolCalls, requestedModel);

        // Update assistantToolMessage if it was modified
        if (providerType !== "azure-anthropic" && assistantToolMessage.tool_calls) {
          assistantToolMessage.tool_calls = toolCalls;
        }
      }

      // Check if tool execution should happen on client side
      const executionMode = config.toolExecutionMode || "server";

      // IMPORTANT: Task tools (subagents) and Web Search tools ALWAYS execute server-side, regardless of execution mode to ensure reliability
      // Separate Server-side tools from Client-side tools
      const serverSideToolCalls = [];
      const clientSideToolCalls = [];

      const SERVER_SIDE_TOOLS = new Set(["task", "web_search", "web_fetch", "websearch", "webfetch"]);

      for (const call of toolCalls) {
        const toolName = (call.function?.name ?? call.name ?? "").toLowerCase();
        if (SERVER_SIDE_TOOLS.has(toolName)) {
          serverSideToolCalls.push(call);
        } else {
          clientSideToolCalls.push(call);
        }
      }

      // If in passthrough/client mode and there are client-side tools, return them to client
      // Server-side tools (Task, Web) will be executed below
      if ((executionMode === "passthrough" || executionMode === "client") && clientSideToolCalls.length > 0) {
        logger.info(
          {
            sessionId: session?.id ?? null,
            totalToolCount: toolCalls.length,
            serverToolCount: serverSideToolCalls.length,
            clientToolCount: clientSideToolCalls.length,
            executionMode,
            clientTools: clientSideToolCalls.map((c) => c.function?.name ?? c.name),
          },
          "Hybrid mode: returning non-Task tools to client, executing Task tools on server"
        );

        // Filter sessionContent to only include client-side tool_use blocks
        const clientContent = sessionContent.filter(block => {
          if (block.type !== "tool_use") return true; // Keep text blocks
          const toolName = (block.name ?? "").toLowerCase();
          return !SERVER_SIDE_TOOLS.has(toolName); // Keep client-side tool_use blocks
        });

        // Convert OpenRouter response to Anthropic format for CLI
        const anthropicResponse = {
          id: databricksResponse.json?.id || `msg_${Date.now()}`,
          type: "message",
          role: "assistant",
          content: clientContent,
          model: databricksResponse.json?.model || clean.model,
          stop_reason: "tool_use",
          usage: databricksResponse.json?.usage || {
            input_tokens: 0,
            output_tokens: 0,
          },
        };

        logger.debug(
          {
            sessionId: session?.id ?? null,
            clientContentLength: clientContent.length,
            clientContentTypes: clientContent.map(b => b.type),
          },
          "Passthrough: returning client-side tools to client"
        );

        // If there are server-side tools, we need to execute them server-side first
        // then continue the conversation loop. For now, let's fall through to execute server-side tools.
        if (serverSideToolCalls.length === 0) {
          // No server-side tools - pure passthrough
          return {
            response: {
              status: 200,
              body: anthropicResponse,
              terminationReason: "tool_use",
            },
            steps,
            durationMs: Date.now() - start,
            terminationReason: "tool_use",
          };
        }

        // Has Server-side tools - we need to execute them and continue
        // Override toolCalls to only include Server-side tools for server execution
        toolCalls = serverSideToolCalls;

        logger.info(
          {
            sessionId: session?.id ?? null,
            serverToolCount: serverSideToolCalls.length,
          },
          "Executing server-side tools in hybrid mode"
        );
      } else if (executionMode === "passthrough" || executionMode === "client") {
        // Only Server-side tools, no Client-side tools - execute all server-side
        logger.info(
          {
            sessionId: session?.id ?? null,
            serverToolCount: serverSideToolCalls.length,
          },
          "All tools are server-side tools - executing server-side"
        );
      }

      logger.debug(
        {
          sessionId: session?.id ?? null,
          toolCount: toolCalls.length,
          executionMode,
        },
        "Server mode: executing tools on server"
      );

      // Evaluate policy for all tools first (must be sequential for rate limiting)
      const toolCallsWithPolicy = [];
      for (const call of toolCalls) {
        const callId =
          call.id ??
          `tool_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        if (!call.id) {
          call.id = callId;
        }
        toolCallNames.set(
          callId,
          normaliseToolIdentifier(call.function?.name ?? call.name ?? "tool"),
        );
        const decision = policy.evaluateToolCall({
          call,
          toolCallsExecuted: toolCallsExecuted + toolCallsWithPolicy.length,
        });
        toolCallsWithPolicy.push({ call, decision });
      }

      // Identify Task tool calls for parallel execution
      const taskCalls = [];
      const nonTaskCalls = [];

      for (const item of toolCallsWithPolicy) {
        const toolName = (item.call.function?.name ?? item.call.name ?? "").toLowerCase();
        if (toolName === "task" && item.decision.allowed) {
          taskCalls.push(item);
        } else {
          nonTaskCalls.push(item);
        }
      }

      // Execute Task tools in parallel if multiple exist
      if (taskCalls.length > 1) {
        logger.info({
          taskCount: taskCalls.length,
          sessionId: session?.id
        }, "Executing multiple Task tools in parallel");

        try {
          // Execute all Task tools in parallel
          const taskExecutions = await Promise.all(
            taskCalls.map(({ call }) => executeToolCall(call, {
              session,
              cwd,
              requestMessages: cleanPayload.messages,
              providerType,
            }))
          );

          // Process results and add to messages
          taskExecutions.forEach((execution, index) => {
            const call = taskCalls[index].call;
            toolCallsExecuted += 1;

            let toolMessage;
            if (providerType === "azure-anthropic") {
              const parsedContent = parseExecutionContent(execution.content);
              const serialisedContent =
                typeof parsedContent === "string" || parsedContent === null
                  ? parsedContent ?? ""
                  : JSON.stringify(parsedContent);

              toolMessage = {
                role: "user",
                content: [
                  {
                    type: "tool_result",
                    tool_use_id: call.id ?? execution.id,
                    content: serialisedContent,
                    is_error: execution.ok === false,
                  },
                ],
              };

              toolCallNames.set(
                call.id ?? execution.id,
                normaliseToolIdentifier(
                  call.function?.name ?? call.name ?? execution.name ?? "tool",
                ),
              );
            } else {
              // OpenAI format: tool_call_id MUST match the id from assistant's tool_call
              toolMessage = {
                role: "tool",
                tool_call_id: call.id ?? execution.id,
                name: call.function?.name ?? call.name ?? execution.name,
                content: execution.content,
              };
            }

            cleanPayload.messages.push(toolMessage);

            logger.info(
              {
                toolName: execution.name,
                content: typeof toolMessage.content === 'string'
                ? toolMessage.content.substring(0, 500)
                : JSON.stringify(toolMessage.content).substring(0, 500)
              }, "Tool result content sent to LLM",
            );

            // Convert to Anthropic format for session storage
            let sessionToolResultContent;
            if (providerType === "azure-anthropic") {
              sessionToolResultContent = toolMessage.content;
            } else {
              sessionToolResultContent = [
                {
                  type: "tool_result",
                  tool_use_id: toolMessage.tool_call_id,
                  content: toolMessage.content,
                  is_error: execution.ok === false,
                },
              ];
            }

            appendTurnToSession(session, {
              role: "tool",
              type: "tool_result",
              status: execution.status,
              content: sessionToolResultContent,
              metadata: {
                tool: execution.name,
                ok: execution.ok,
                parallel: true,
                parallelIndex: index,
                totalParallel: taskExecutions.length
              },
            });
          });

          logger.info({
            completedTasks: taskExecutions.length,
            sessionId: session?.id
          }, "Completed parallel Task execution");

          // Check if we've exceeded the max tool calls limit after parallel execution
          if (toolCallsExecuted > settings.maxToolCallsPerRequest) {
            logger.error(
              {
                sessionId: session?.id ?? null,
                toolCallsExecuted,
                maxToolCallsPerRequest: settings.maxToolCallsPerRequest,
                steps,
              },
              "Maximum tool calls per request (POLICY_MAX_TOOL_CALLS_PER_REQUEST) exceeded after parallel Task execution - terminating",
            );

            return {
              response: {
                status: 500,
                body: {
                  error: {
                    type: "max_tool_calls_exceeded",
                    message: `Maximum tool calls per request exceeded. The model attempted to execute ${toolCallsExecuted} tool calls, but the limit is ${settings.maxToolCallsPerRequest}. This may indicate a complex task that requires breaking down into smaller steps.

To increase the limit: Set POLICY_MAX_TOOL_CALLS_PER_REQUEST`,
                  },
                },
                terminationReason: "max_tool_calls_exceeded",
              },
              steps,
              durationMs: Date.now() - start,
              terminationReason: "max_tool_calls_exceeded",
            };
          }
        } catch (error) {
          logger.error({
            error: error.message,
            taskCount: taskCalls.length
          }, "Error in parallel Task execution");

          // Fall back to sequential execution on error
          taskCalls.forEach(item => nonTaskCalls.push(item));
        }
      } else if (taskCalls.length === 1) {
        // Single Task tool - add back to non-task calls for normal processing
        nonTaskCalls.push(...taskCalls);
      }

      // Now process results (sequential for non-Task tools or blocked tools)
      for (const { call, decision } of nonTaskCalls) {

        if (!decision.allowed) {
          policy.logPolicyDecision(decision, {
            sessionId: session?.id ?? null,
            toolCall: call,
          });

          const denialContent = JSON.stringify(
            {
              error: decision.code ?? "tool_blocked",
              message: decision.reason ?? "Tool invocation blocked by policy.",
            },
            null,
            2,
          );

          let toolResultMessage;
          if (providerType === "azure-anthropic") {
            // Anthropic format: tool_result in user message content array
            toolResultMessage = {
              role: "user",
              content: [
                {
                  type: "tool_result",
                  tool_use_id: call.id ?? `${call.function?.name ?? "tool"}_${Date.now()}`,
                  content: denialContent,
                  is_error: true,
                },
              ],
            };
          } else {
            // OpenAI format
            toolResultMessage = {
              role: "tool",
              tool_call_id: call.id ?? `${call.function?.name ?? "tool"}_${Date.now()}`,
              name: call.function?.name ?? call.name,
              content: denialContent,
            };
          }

          cleanPayload.messages.push(toolResultMessage);

          // Convert to Anthropic format for session storage
          let sessionToolResult;
          if (providerType === "azure-anthropic") {
            sessionToolResult = toolResultMessage.content;
          } else {
            // Convert OpenRouter tool message to Anthropic format
            sessionToolResult = [
              {
                type: "tool_result",
                tool_use_id: toolResultMessage.tool_call_id,
                content: toolResultMessage.content,
                is_error: true,
              },
            ];
          }

          appendTurnToSession(session, {
            role: "tool",
            type: "tool_result",
            status: decision.status ?? 403,
            content: sessionToolResult,
            metadata: {
              tool: toolResultMessage.name,
              ok: false,
              blocked: true,
              reason: decision.reason ?? "Policy violation",
            },
          });
          continue;
        }

        toolCallsExecuted += 1;

        // Check if we've exceeded the max tool calls limit
        if (toolCallsExecuted > settings.maxToolCallsPerRequest) {
          logger.error(
            {
              sessionId: session?.id ?? null,
              toolCallsExecuted,
              maxToolCallsPerRequest: settings.maxToolCallsPerRequest,
              steps,
            },
            "Maximum tool calls per request (POLICY_MAX_TOOL_CALLS_PER_REQUEST) exceeded - terminating",
          );

          return {
            response: {
              status: 500,
              body: {
                error: {
                  type: "max_tool_calls_exceeded",
                  message: `Maximum tool calls per request exceeded. The model attempted to execute ${toolCallsExecuted} tool calls, but the limit is ${settings.maxToolCallsPerRequest}. This may indicate a complex task that requires breaking down into smaller steps.

To increase the limit: Set POLICY_MAX_TOOL_CALLS_PER_REQUEST`,
                },
              },
              terminationReason: "max_tool_calls_exceeded",
            },
            steps,
            durationMs: Date.now() - start,
            terminationReason: "max_tool_calls_exceeded",
          };
        }

        const toolName = call.function?.name ?? call.name ?? "unknown";

        // Helper to get first 200 chars of any value
        const getPreview = (val, maxChars = 200) => {
          if (!val) return null;
          const str = typeof val === 'string' ? val : JSON.stringify(val);
          if (str.length > maxChars) return str.substring(0, maxChars) + '...';
          return str;
        };

        const requestPreview = getPreview(call.arguments ?? call.function?.arguments);
        progress.toolExecutionStarted({
          sessionId: session?.id ?? null,
          agentId,
          step: steps,
          toolName,
          toolId: call.id,
          requestPreview,
        });

        const _toolExecStart = Date.now();
        const execution = await executeToolCall(call, {
          session,
          cwd,
          requestMessages: cleanPayload.messages,
          providerType,
        });

        const responsePreview = getPreview(execution.content);
        progress.toolExecutionCompleted({
          sessionId: session?.id ?? null,
          agentId,
          step: steps,
          toolName,
          toolId: call.id,
          ok: execution.ok !== false,
          durationMs: Date.now() - _toolExecStart,
          responsePreview,
        });

        logger.debug(
          {
            id: execution.id ?? null,
            name: execution.name ?? null,
            arguments: execution.arguments ?? null,
            content: execution.content ?? null,
            is_error: execution.ok === false,
          }, "executeToolCall response" );

        let toolMessage;
        if (providerType === "azure-anthropic") {
          const parsedContent = parseExecutionContent(execution.content);
          const serialisedContent =
            typeof parsedContent === "string" || parsedContent === null
              ? parsedContent ?? ""
              : JSON.stringify(parsedContent);
          let contentForToolResult = serialisedContent;
          if (execution.ok) {
            const toolIdentifier = normaliseToolIdentifier(
              call.function?.name ?? call.name ?? execution.name ?? "tool",
            );
            if (WEB_SEARCH_NORMALIZED.has(toolIdentifier)) {
              const summary = buildWebSearchSummary(parsedContent, {
                maxItems: options?.webSearchSummaryLimit ?? 5,
              });
              if (summary) {
                try {
                  const structured =
                    typeof parsedContent === "object" && parsedContent !== null
                      ? { ...parsedContent, summary }
                      : { raw: serialisedContent, summary };
                  contentForToolResult = JSON.stringify(structured, null, 2);
                } catch {
                  contentForToolResult = `${serialisedContent}\n\nSummary:\n${summary}`;
                }
              }
            }
          }
          toolMessage = {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: call.id ?? execution.id,
                content: contentForToolResult,
                is_error: execution.ok === false,
              },
            ],
          };
          toolCallNames.set(
            call.id ?? execution.id,
            normaliseToolIdentifier(
              call.function?.name ?? call.name ?? execution.name ?? "tool",
            ),
          );

        } else {
          // OpenAI format: tool_call_id MUST match the id from assistant's tool_call
          toolMessage = {
            role: "tool",
            tool_call_id: call.id ?? execution.id,
            name: call.function?.name ?? call.name ?? execution.name,
            content: execution.content,
          };
        }

        cleanPayload.messages.push(toolMessage);

        // Convert to Anthropic format for session storage
        let sessionToolResultContent;
        if (providerType === "azure-anthropic") {
          // Azure Anthropic already has content in correct format
          sessionToolResultContent = toolMessage.content;
        } else {
          // Convert OpenRouter tool message to Anthropic format
          sessionToolResultContent = [
            {
              type: "tool_result",
              tool_use_id: toolMessage.tool_call_id,
              content: toolMessage.content,
              is_error: execution.ok === false,
            },
          ];
        }

        appendTurnToSession(session, {
          role: "tool",
          type: "tool_result",
          status: execution.status,
          content: sessionToolResultContent,
          metadata: {
            tool: execution.name,
            ok: execution.ok,
            registered: execution.metadata?.registered ?? null,
          },
        });

        if (execution.ok) {
          logger.debug(
            {
              sessionId: session?.id ?? null,
              tool: execution.name,
              toolCallId: execution.id,
            },
            "Tool executed successfully",
          );
        } else {
          logger.warn(
            {
              sessionId: session?.id ?? null,
              tool: execution.name,
              toolCallId: execution.id,
              status: execution.status,
            },
            "Tool execution returned an error response",
          );
        }
      }

      // === TOOL CALL LOOP DETECTION ===
      // Track tool calls to detect infinite loops where the model calls the same tool
      // repeatedly with identical parameters
      for (const call of toolCalls) {
        const signature = getToolCallSignature(call);
        const count = (toolCallHistory.get(signature) || 0) + 1;
        toolCallHistory.set(signature, count);

        const toolName = call.function?.name ?? call.name ?? 'unknown';

        if (count === 3 && !loopWarningInjected) {
          logger.warn(
            {
              sessionId: session?.id ?? null,
              correlationId: options?.correlationId,
              tool: toolName,
              loopCount: count,
              signature: signature,
              action: 'warning_injected',
              totalSteps: steps,
              remainingSteps: settings.maxSteps - steps,
            },
            "Tool call loop detected - same tool called 3 times with identical parameters",
          );

          // Inject warning message to model
          loopWarningInjected = true;
          const warningMessage = {
            role: "user",
            content: "⚠️ System Warning: You have called the same tool with identical parameters 3 times in this request. This may indicate an infinite loop. Please provide a final answer to the user instead of calling the same tool again, or explain why you need to continue retrying with the same parameters.",
          };

          cleanPayload.messages.push(warningMessage);

          if (session) {
            appendTurnToSession(session, {
              role: "user",
              type: "system_warning",
              status: 200,
              content: warningMessage.content,
              metadata: {
                reason: "tool_call_loop_warning",
                toolName,
                loopCount: count,
              },
            });
          }
        } else if (count > 3) {
          // Force termination after 3 identical calls
          // Log FULL context for debugging why the loop occurred
          logger.error(
            {
              sessionId: session?.id ?? null,
              correlationId: options?.correlationId,
              tool: toolName,
              loopCount: count,
              signature: signature,
              action: 'request_terminated',
              totalSteps: steps,
              maxSteps: settings.maxSteps,
              // FULL CONTEXT for debugging
              myPrompt: cleanPayload.messages, // Full conversation sent to LLM
              systemPrompt: cleanPayload.system, // Full system prompt
              llmResponse: databricksResponse?.data || databricksResponse?.json, // Full LLM response that triggered loop
              repeatedToolCalls: toolCalls, // The actual repeated tool calls
              toolCallHistory: Array.from(toolCallHistory.entries()), // Full history of all tool calls in this request
            },
            "Tool call loop limit exceeded - forcing termination (FULL CONTEXT CAPTURED)",
          );

          return {
            response: {
              status: 500,
              body: {
                error: {
                  type: "tool_call_loop_detected",
                  message: `Tool call loop detected: The model called the same tool ("${toolName}") with identical parameters ${count} times. This indicates an infinite loop and execution has been terminated. Please try rephrasing your request or provide different parameters.`,
                },
              },
              terminationReason: "tool_call_loop",
            },
            steps,
            durationMs: Date.now() - start,
            terminationReason: "tool_call_loop",
          };
        }
      }

      logger.info({
        sessionId: session?.id ?? null,
        step: steps,
        toolCallsExecuted: toolCallsExecuted,
        totalToolCallsInThisStep: toolCalls.length,
        messageCount: cleanPayload.messages.length,
        lastMessageRole: cleanPayload.messages[cleanPayload.messages.length - 1]?.role,
      }, "Tool execution complete");

      continue; // Loop back to invoke model with tool results in context
    }

    let anthropicPayload;
    // Use actualProvider from invokeModel for hybrid routing support
    const actualProvider = databricksResponse.actualProvider || providerType;

    if (actualProvider === "bedrock") {
      // Bedrock with Claude models returns native Anthropic format
      // Other models are already converted by bedrock-utils
      anthropicPayload = databricksResponse.json;
      if (Array.isArray(anthropicPayload?.content)) {
        anthropicPayload.content = policy.sanitiseContent(anthropicPayload.content);
      }
    } else if (actualProvider === "azure-anthropic") {
      anthropicPayload = databricksResponse.json;
      if (Array.isArray(anthropicPayload?.content)) {
        anthropicPayload.content = policy.sanitiseContent(anthropicPayload.content);
      }
    } else if (actualProvider === "ollama") {
      anthropicPayload = ollamaToAnthropicResponse(
        databricksResponse.json,
        requestedModel,
      );
      anthropicPayload.content = policy.sanitiseContent(anthropicPayload.content);
    } else if (actualProvider === "openrouter") {
      const { convertOpenRouterResponseToAnthropic } = require("../clients/openrouter-utils");

      // Validate OpenRouter response has choices array before conversion
      if (!databricksResponse.json?.choices?.length) {
        logger.warn({
          json: databricksResponse.json,
          status: databricksResponse.status
        }, "OpenRouter response missing choices array");

        appendTurnToSession(session, {
          role: "assistant",
          type: "error",
          status: databricksResponse.status,
          content: databricksResponse.json,
          metadata: { termination: "malformed_response" },
        });

        const response = buildErrorResponse(databricksResponse);
        return {
          response,
          steps,
          durationMs: Date.now() - start,
          terminationReason: response.terminationReason,
        };
      }

      anthropicPayload = convertOpenRouterResponseToAnthropic(
        databricksResponse.json,
        requestedModel,
      );
      anthropicPayload.content = policy.sanitiseContent(anthropicPayload.content);
    } else if (actualProvider === "azure-openai") {
      const { convertOpenRouterResponseToAnthropic } = require("../clients/openrouter-utils");

      // Check if response is already in Anthropic format (Azure AI Foundry Responses API)
      const isAnthropicFormat = databricksResponse.json?.type === "message" &&
                                 Array.isArray(databricksResponse.json?.content) &&
                                 databricksResponse.json?.stop_reason !== undefined;

      if (isAnthropicFormat) {
        // Azure AI Foundry Responses API returns Anthropic format directly
        logger.info({
          format: "anthropic",
          contentBlocks: databricksResponse.json.content?.length || 0,
          contentTypes: databricksResponse.json.content?.map(c => c.type) || [],
          stopReason: databricksResponse.json.stop_reason,
          hasToolUse: databricksResponse.json.content?.some(c => c.type === 'tool_use')
        }, "=== AZURE RESPONSES API (ANTHROPIC FORMAT) ===");

        // Use response directly - it's already in Anthropic format
        anthropicPayload = {
          id: databricksResponse.json.id,
          type: "message",
          role: databricksResponse.json.role || "assistant",
          content: databricksResponse.json.content,
          model: databricksResponse.json.model || requestedModel,
          stop_reason: databricksResponse.json.stop_reason,
          stop_sequence: databricksResponse.json.stop_sequence || null,
          usage: databricksResponse.json.usage || { input_tokens: 0, output_tokens: 0 }
        };

        anthropicPayload.content = policy.sanitiseContent(anthropicPayload.content);
      } else if (!databricksResponse.json?.choices?.length) {
        // Not Anthropic format and no choices array - malformed response
        logger.warn({
          json: databricksResponse.json,
          status: databricksResponse.status
        }, "Azure OpenAI response missing choices array and not in Anthropic format");

        appendTurnToSession(session, {
          role: "assistant",
          type: "error",
          status: databricksResponse.status,
          content: databricksResponse.json,
          metadata: { termination: "malformed_response" },
        });

        const response = buildErrorResponse(databricksResponse);
        return {
          response,
          steps,
          durationMs: Date.now() - start,
          terminationReason: response.terminationReason,
        };
      } else {
        // Standard OpenAI format with choices array
        logger.info({
          format: "openai",
          hasChoices: !!databricksResponse.json?.choices,
          choiceCount: databricksResponse.json?.choices?.length || 0,
          firstChoice: databricksResponse.json?.choices?.[0],
          hasToolCalls: !!databricksResponse.json?.choices?.[0]?.message?.tool_calls,
          toolCallCount: databricksResponse.json?.choices?.[0]?.message?.tool_calls?.length || 0,
          finishReason: databricksResponse.json?.choices?.[0]?.finish_reason
        }, "=== AZURE OPENAI (STANDARD FORMAT) ===");

        // Convert OpenAI format to Anthropic format (reuse OpenRouter utility)
        anthropicPayload = convertOpenRouterResponseToAnthropic(
          databricksResponse.json,
          requestedModel,
        );

        logger.info({
          contentBlocks: anthropicPayload.content?.length || 0,
          contentTypes: anthropicPayload.content?.map(c => c.type) || [],
          stopReason: anthropicPayload.stop_reason,
          hasToolUse: anthropicPayload.content?.some(c => c.type === 'tool_use')
        }, "=== CONVERTED ANTHROPIC RESPONSE ===");

        anthropicPayload.content = policy.sanitiseContent(anthropicPayload.content);
      }
    } else if (actualProvider === "openai") {
      const { convertOpenRouterResponseToAnthropic } = require("../clients/openrouter-utils");

      // Validate OpenAI response has choices array before conversion
      if (!databricksResponse.json?.choices?.length) {
        logger.warn({
          json: databricksResponse.json,
          status: databricksResponse.status
        }, "OpenAI response missing choices array");

        appendTurnToSession(session, {
          role: "assistant",
          type: "error",
          status: databricksResponse.status,
          content: databricksResponse.json,
          metadata: { termination: "malformed_response" },
        });

        const response = buildErrorResponse(databricksResponse);
        return {
          response,
          steps,
          durationMs: Date.now() - start,
          terminationReason: response.terminationReason,
        };
      }

      // Log OpenAI raw response
      logger.info({
        hasChoices: !!databricksResponse.json?.choices,
        choiceCount: databricksResponse.json?.choices?.length || 0,
        hasToolCalls: !!databricksResponse.json?.choices?.[0]?.message?.tool_calls,
        toolCallCount: databricksResponse.json?.choices?.[0]?.message?.tool_calls?.length || 0,
        finishReason: databricksResponse.json?.choices?.[0]?.finish_reason
      }, "=== OPENAI RAW RESPONSE ===");

      // Convert OpenAI format to Anthropic format (reuse OpenRouter utility)
      anthropicPayload = convertOpenRouterResponseToAnthropic(
        databricksResponse.json,
        requestedModel,
      );

      logger.info({
        contentBlocks: anthropicPayload.content?.length || 0,
        contentTypes: anthropicPayload.content?.map(c => c.type) || [],
        stopReason: anthropicPayload.stop_reason,
        hasToolUse: anthropicPayload.content?.some(c => c.type === 'tool_use')
      }, "=== CONVERTED ANTHROPIC RESPONSE (OpenAI) ===");

      anthropicPayload.content = policy.sanitiseContent(anthropicPayload.content);
    } else if (actualProvider === "llamacpp") {
      const { convertOpenRouterResponseToAnthropic } = require("../clients/openrouter-utils");

      // Validate llama.cpp response has choices array before conversion
      if (!databricksResponse.json?.choices?.length) {
        logger.warn({
          json: databricksResponse.json,
          status: databricksResponse.status
        }, "llama.cpp response missing choices array");

        appendTurnToSession(session, {
          role: "assistant",
          type: "error",
          status: databricksResponse.status,
          content: databricksResponse.json,
          metadata: { termination: "malformed_response" },
        });

        const response = buildErrorResponse(databricksResponse);
        return {
          response,
          steps,
          durationMs: Date.now() - start,
          terminationReason: response.terminationReason,
        };
      }

      // Log llama.cpp raw response
      logger.info({
        hasChoices: !!databricksResponse.json?.choices,
        choiceCount: databricksResponse.json?.choices?.length || 0,
        hasToolCalls: !!databricksResponse.json?.choices?.[0]?.message?.tool_calls,
        toolCallCount: databricksResponse.json?.choices?.[0]?.message?.tool_calls?.length || 0,
        finishReason: databricksResponse.json?.choices?.[0]?.finish_reason
      }, "=== LLAMA.CPP RAW RESPONSE ===");

      // Convert llama.cpp format to Anthropic format (reuse OpenRouter utility)
      anthropicPayload = convertOpenRouterResponseToAnthropic(
        databricksResponse.json,
        requestedModel,
      );

      logger.info({
        contentBlocks: anthropicPayload.content?.length || 0,
        contentTypes: anthropicPayload.content?.map(c => c.type) || [],
        stopReason: anthropicPayload.stop_reason,
        hasToolUse: anthropicPayload.content?.some(c => c.type === 'tool_use')
      }, "=== CONVERTED ANTHROPIC RESPONSE (llama.cpp) ===");

      anthropicPayload.content = policy.sanitiseContent(anthropicPayload.content);
    } else if (actualProvider === "zai") {
      // Z.AI responses are already converted to Anthropic format in invokeZai
      logger.info({
        hasJson: !!databricksResponse.json,
        jsonContent: JSON.stringify(databricksResponse.json?.content)?.substring(0, 200),
      }, "=== ZAI ORCHESTRATOR DEBUG ===");
      anthropicPayload = databricksResponse.json;
      if (Array.isArray(anthropicPayload?.content)) {
        anthropicPayload.content = policy.sanitiseContent(anthropicPayload.content);
      }
    } else if (actualProvider === "vertex") {
      // Vertex AI responses are already in Anthropic format
      anthropicPayload = databricksResponse.json;
      if (Array.isArray(anthropicPayload?.content)) {
        anthropicPayload.content = policy.sanitiseContent(anthropicPayload.content);
      }
    } else {
      anthropicPayload = toAnthropicResponse(
        databricksResponse.json,
        requestedModel,
        wantsThinking,
      );
      anthropicPayload.content = policy.sanitiseContent(anthropicPayload.content);
    }

    // === EMPTY RESPONSE DETECTION (safety net — post-conversion) ===
    // Primary detection is earlier (before tool handling). This catches edge cases
    // where conversion produces empty content from non-empty raw data.
    const hasTextContent = (() => {
      if (Array.isArray(anthropicPayload.content)) {
        return anthropicPayload.content.some(b => b.type === "text" && b.text?.trim());
      }
      if (typeof anthropicPayload.content === "string") {
        return anthropicPayload.content.trim().length > 0;
      }
      return false;
    })();

    const hasToolUseBlocks = Array.isArray(anthropicPayload.content) &&
      anthropicPayload.content.some(b => b.type === "tool_use");

    if (!hasToolUseBlocks && !hasTextContent) {
      logger.warn({
        sessionId: session?.id ?? null,
        step: steps,
        messageKeys: Object.keys(anthropicPayload),
        contentType: typeof anthropicPayload.content,
        contentLength: Array.isArray(anthropicPayload.content) ? anthropicPayload.content.length : String(anthropicPayload.content || "").length,
      }, "Empty LLM response detected (no text, no tool calls)");

      // Retry once with a nudge
      if (steps < settings.maxSteps && !emptyResponseRetried) {
        emptyResponseRetried = true;
        cleanPayload.messages.push({
          role: "assistant",
          content: "",
        });
        cleanPayload.messages.push({
          role: "user",
          content: "Please provide a response to the user's message.",
        });
        logger.info({ sessionId: session?.id ?? null }, "Retrying after empty response with nudge");
        continue;  // Go back to top of while loop
      }

      // If retry also returned empty, return a fallback message
      logger.warn({ sessionId: session?.id ?? null, steps }, "Empty response persisted after retry");
      return {
        response: {
          status: 200,
          body: {
            id: `msg_${Date.now()}`,
            type: "message",
            role: "assistant",
            model: requestedModel,
            content: [{ type: "text", text: "I wasn't able to generate a response. Could you try rephrasing your message?" }],
            stop_reason: "end_turn",
            usage: { input_tokens: 0, output_tokens: 0 },
          },
          terminationReason: "empty_response_fallback",
        },
        steps,
        durationMs: Date.now() - start,
        terminationReason: "empty_response_fallback",
      };
    }

    // Ensure content is an array before calling .find()
    const content = Array.isArray(anthropicPayload.content) ? anthropicPayload.content : [];
    const fallbackCandidate = content.find(
      (item) => item.type === "text" && needsWebFallback(item.text),
    );

    if (fallbackCandidate && !fallbackPerformed) {
      if (providerType === "azure-anthropic") {
        anthropicPayload.content.push({
          type: "text",
          text: "Automatic web fetch policy fallback is not supported with the Azure-hosted Anthropic provider.",
        });
        fallbackPerformed = true;
        continue;
      }
      const lastUserMessage = cleanPayload.messages
        .slice()
        .reverse()
        .find((msg) => msg.role === "user" && typeof msg.content === "string");

      let queryUrl = null;
      if (lastUserMessage) {
        const urlMatch = lastUserMessage.content.match(/(https?:\/\/[^\s"']+)/i);
        if (urlMatch) {
          queryUrl = urlMatch[1];
        }
      }

      if (!queryUrl) {
        const text = lastUserMessage?.content ?? "";
        queryUrl = `https://www.google.com/search?q=${encodeURIComponent(text)}`;
      }

      if (
        lastUserMessage &&
        /https?:\/\/[^\s"']+/.test(lastUserMessage.content) === false &&
        /price|stock|data|quote/i.test(lastUserMessage.content)
      ) {
        queryUrl = "https://query1.finance.yahoo.com/v8/finance/chart/NVDA";
      }

      logger.info(
        {
          sessionId: session?.id ?? null,
          queryUrl,
        },
        "Policy web fallback triggered",
      );

      const toolCallId = `policy_web_fetch_${Date.now()}`;
      const toolCall = {
        id: toolCallId,
        function: {
          name: "web_fetch",
          arguments: JSON.stringify({ url: queryUrl }),
        },
      };

      const decision = policy.evaluateToolCall({
        call: toolCall,
        toolCallsExecuted,
      });

      if (!decision.allowed) {
        anthropicPayload.content.push({
          type: "text",
          text: `Automatic web fetch was blocked: ${decision.reason ?? "policy denied."}`,
        });
      } else {
        const candidateUrls = extractWebSearchUrls(
          cleanPayload.messages,
          { max: 5 },
          toolCallNames,
        );
        const orderedCandidates = [];
        const seenCandidates = new Set();

        const pushCandidate = (url) => {
          if (typeof url !== "string") return;
          const trimmed = url.trim();
          if (!/^https?:\/\//i.test(trimmed)) return;
          if (seenCandidates.has(trimmed)) return;
          seenCandidates.add(trimmed);
          orderedCandidates.push(trimmed);
        };

        pushCandidate(queryUrl);
        for (const candidate of candidateUrls) {
          pushCandidate(candidate);
        }

        if (orderedCandidates.length === 0 && typeof queryUrl === "string") {
          pushCandidate(queryUrl);
        }

        if (orderedCandidates.length === 0) {
          anthropicPayload.content.push({
            type: "text",
            text: "Automatic web fetch was skipped: no candidate URLs were available.",
          });
          continue;
        }

        let attemptSucceeded = false;

        for (let attemptIndex = 0; attemptIndex < orderedCandidates.length; attemptIndex += 1) {
          const targetUrl = orderedCandidates[attemptIndex];
          const attemptId = `${toolCallId}_${attemptIndex}`;
          const attemptCall = {
            id: attemptId,
            function: {
              name: "web_fetch",
              arguments: JSON.stringify({ url: targetUrl }),
            },
          };
          toolCallNames.set(attemptId, "web_fetch");

          const assistantToolMessage = createFallbackAssistantMessage(providerType, {
            text: orderedCandidates.length > 1
              ? `Attempting to fetch data via web_fetch fallback (${attemptIndex + 1}/${orderedCandidates.length}).`
              : "Attempting to fetch data via web_fetch fallback.",
            toolCall: attemptCall,
          });

          cleanPayload.messages.push(assistantToolMessage);

          // Convert to Anthropic format for session storage
          let sessionFallbackContent;
          if (providerType === "azure-anthropic") {
            // Already in Anthropic format
            sessionFallbackContent = assistantToolMessage.content;
          } else {
            // Convert OpenRouter format to Anthropic format
            const contentBlocks = [];
            if (assistantToolMessage.content && typeof assistantToolMessage.content === 'string' && assistantToolMessage.content.trim()) {
              contentBlocks.push({
                type: "text",
                text: assistantToolMessage.content
              });
            }

            // Add tool_use blocks from tool_calls
            if (Array.isArray(assistantToolMessage.tool_calls)) {
              for (const tc of assistantToolMessage.tool_calls) {
                const func = tc.function || {};
                let input = {};
                if (func.arguments) {
                  try {
                    input = typeof func.arguments === "string" ? JSON.parse(func.arguments) : func.arguments;
                  } catch (err) {
                    logger.warn({ error: err.message }, "Failed to parse fallback tool arguments");
                    input = {};
                  }
                }

                contentBlocks.push({
                  type: "tool_use",
                  id: tc.id || `toolu_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                  name: func.name || "unknown",
                  input
                });
              }
            }

            sessionFallbackContent = contentBlocks;
          }

          appendTurnToSession(session, {
            role: "assistant",
            type: "tool_request",
            status: 200,
            content: sessionFallbackContent,
            metadata: {
              termination: "tool_use",
              toolCalls: [{ id: attemptCall.id, name: attemptCall.function.name }],
              fallback: true,
              query: targetUrl,
              attempt: attemptIndex + 1,
            },
          });

          const execution = await executeToolCall(attemptCall, {
            session,
            cwd,
            requestMessages: cleanPayload.messages,
            providerType,            
          });

          const toolResultMessage = createFallbackToolResultMessage(providerType, {
            toolCall: attemptCall,
            execution,
          });

          cleanPayload.messages.push(toolResultMessage);

          // Convert to Anthropic format for session storage
          let sessionFallbackToolResult;
          if (providerType === "azure-anthropic") {
            // Already in Anthropic format
            sessionFallbackToolResult = toolResultMessage.content;
          } else {
            // Convert OpenRouter tool message to Anthropic format
            sessionFallbackToolResult = [
              {
                type: "tool_result",
                tool_use_id: toolResultMessage.tool_call_id,
                content: toolResultMessage.content,
                is_error: execution.ok === false,
              },
            ];
          }

          appendTurnToSession(session, {
            role: "tool",
            type: "tool_result",
            status: execution.status,
            content: sessionFallbackToolResult,
            metadata: {
              tool: attemptCall.function.name,
              ok: execution.ok,
              registered: execution.metadata?.registered ?? true,
              fallback: true,
              query: targetUrl,
              attempt: attemptIndex + 1,
            },
          });

          toolCallsExecuted += 1;

          // Check if we've exceeded the max tool calls limit
          if (toolCallsExecuted > settings.maxToolCallsPerRequest) {
            logger.error(
              {
                sessionId: session?.id ?? null,
                toolCallsExecuted,
                maxToolCallsPerRequest: settings.maxToolCallsPerRequest,
                steps,
              },
              "Maximum tool calls per request (POLICY_MAX_TOOL_CALLS_PER_REQUEST) exceeded during fallback - terminating",
            );

            return {
              response: {
                status: 500,
                body: {
                  error: {
                    type: "max_tool_calls_exceeded",
                    message: `Maximum tool calls per request exceeded. The model attempted to execute ${toolCallsExecuted} tool calls, but the limit is ${settings.maxToolCallsPerRequest}. This may indicate a complex task that requires breaking down into smaller steps.

To increase the limit: Set POLICY_MAX_TOOL_CALLS_PER_REQUEST`,
                  },
                },
                terminationReason: "max_tool_calls_exceeded",
              },
              steps,
              durationMs: Date.now() - start,
              terminationReason: "max_tool_calls_exceeded",
            };
          }

          if (execution.ok) {
            fallbackPerformed = true;
            attemptSucceeded = true;
            break;
          }
        }

        if (!attemptSucceeded) {
          anthropicPayload.content.push({
            type: "text",
            text: "Automatic web fetch could not retrieve data from any candidate URLs.",
          });
        }
        continue;
      }
    }

    appendTurnToSession(session, {
      role: "assistant",
      type: "message",
      status: 200,
      content: anthropicPayload,
      metadata: { termination: "completion" },
    });

    if (cacheKey && steps === 1 && toolCallsExecuted === 0) {
      const storedKey = promptCache.storeResponse(cacheKey, databricksResponse);
      if (storedKey) {
        const promptTokens = databricksResponse.json?.usage?.prompt_tokens ?? 0;
        anthropicPayload.usage.cache_creation_input_tokens = promptTokens;
      }
    }

    // === MEMORY EXTRACTION (Titans-inspired long-term memory) ===
    if (config.memory?.enabled !== false && config.memory?.extraction?.enabled !== false) {
      setImmediate(async () => {
        try {
          const memoryExtractor = require('../memory/extractor');

          const extractedMemories = await memoryExtractor.extractMemories(
            anthropicPayload,
            cleanPayload.messages,
            { sessionId: session?.id }
          );

          if (extractedMemories.length > 0) {
            logger.debug({
              sessionId: session?.id,
              memoriesExtracted: extractedMemories.length,
            }, 'Extracted and stored long-term memories');
          }
        } catch (err) {
          logger.warn({ err, sessionId: session?.id }, 'Memory extraction failed');
        }
      });
    }

    const finalDurationMs = Date.now() - start;

    // === LIMIT PROXIMITY WARNING ===
    // If the response completed but we're at/near a limit, append a warning
    // so the user knows the response may be truncated.
    const limitWarnings = [];
    if (steps >= settings.maxSteps - 1) {
      limitWarnings.push(
        `Step limit reached (${steps}/${settings.maxSteps}). ` +
        `Increase with POLICY_MAX_STEPS (current: ${settings.maxSteps}).`
      );
    }
    if (toolCallsExecuted >= settings.maxToolCallsPerRequest - 1) {
      limitWarnings.push(
        `Tool call limit reached (${toolCallsExecuted}/${settings.maxToolCallsPerRequest}). ` +
        `Increase with POLICY_MAX_TOOL_CALLS_PER_REQUEST (current: ${settings.maxToolCallsPerRequest}).`
      );
    }
    const durationPct = finalDurationMs / settings.maxDurationMs;
    if (durationPct >= 0.9) {
      limitWarnings.push(
        `Duration limit nearly reached (${Math.round(finalDurationMs / 1000)}s/${Math.round(settings.maxDurationMs / 1000)}s). ` +
        `Increase with POLICY_MAX_DURATION_MS (current: ${settings.maxDurationMs}).`
      );
    }

    if (limitWarnings.length > 0) {
      const warningText = `\n\n---\n**Agent loop limit warning:** ${limitWarnings.join(' ')} The response above may be incomplete.`;
      logger.warn({
        sessionId: session?.id ?? null,
        steps,
        toolCallsExecuted,
        durationMs: finalDurationMs,
        limits: {
          maxSteps: settings.maxSteps,
          maxToolCallsPerRequest: settings.maxToolCallsPerRequest,
          maxDurationMs: settings.maxDurationMs,
        },
        warnings: limitWarnings,
      }, "Agent loop completed near limits — appending warning to response");

      // Append warning text block to the response content
      if (Array.isArray(anthropicPayload?.content)) {
        anthropicPayload.content.push({ type: "text", text: warningText });
      }
    }

    logger.info(
      {
        sessionId: session?.id ?? null,
        steps,
        toolCallsExecuted,
        uniqueToolSignatures: toolCallHistory.size,
        toolCallLoopWarnings: loopWarningInjected ? 1 : 0,
        durationMs: finalDurationMs,
        avgDurationPerStep: steps > 0 ? Math.round(finalDurationMs / steps) : 0,
        limitWarnings: limitWarnings.length > 0 ? limitWarnings : undefined,
      },
      "Agent loop completed successfully",
    );

    // DIAGNOSTIC: Log response being returned
    logger.info({
      sessionId: session?.id ?? null,
      status: 200,
      hasBody: !!anthropicPayload,
      bodyKeys: anthropicPayload ? Object.keys(anthropicPayload) : [],
      contentType: anthropicPayload?.content ? (Array.isArray(anthropicPayload.content) ? 'array' : typeof anthropicPayload.content) : 'none',
      contentLength: anthropicPayload?.content ? (Array.isArray(anthropicPayload.content) ? anthropicPayload.content.length : String(anthropicPayload.content).length) : 0,
      stopReason: anthropicPayload?.stop_reason
    }, "=== RETURNING RESPONSE TO CLIENT ===");

    progress.agentLoopCompleted({
      sessionId: session?.id ?? null,
      agentId,
      steps,
      toolCallsExecuted,
      durationMs: finalDurationMs,
      terminationReason: "completion",
    });

    return {
      response: {
        status: 200,
        body: anthropicPayload,
        terminationReason: "completion",
        toolCallComparison,
      },
      steps,
      durationMs: finalDurationMs,
      terminationReason: "completion",
      toolCallComparison,
    };
  }

  const finalDurationMs = Date.now() - start;

  // Determine which specific limit was hit
  const hitLimits = [];
  if (steps >= settings.maxSteps) {
    hitLimits.push(`Step limit reached (${steps}/${settings.maxSteps}). Increase with POLICY_MAX_STEPS.`);
  }
  if (finalDurationMs >= settings.maxDurationMs) {
    hitLimits.push(`Duration limit reached (${Math.round(finalDurationMs / 1000)}s/${Math.round(settings.maxDurationMs / 1000)}s). Increase with POLICY_MAX_DURATION_MS.`);
  }
  if (toolCallsExecuted >= settings.maxToolCallsPerRequest) {
    hitLimits.push(`Tool call limit reached (${toolCallsExecuted}/${settings.maxToolCallsPerRequest}). Increase with POLICY_MAX_TOOL_CALLS_PER_REQUEST.`);
  }
  const limitMessage = hitLimits.length > 0
    ? `Agent loop limit exceeded: ${hitLimits.join(' ')}`
    : "Reached agent loop limits without producing a response.";

  appendTurnToSession(session, {
    role: "assistant",
    type: "error",
    status: 504,
    content: {
      error: "max_steps_exceeded",
      message: limitMessage,
      limits: {
        maxSteps: settings.maxSteps,
        maxDurationMs: settings.maxDurationMs,
        maxToolCallsPerRequest: settings.maxToolCallsPerRequest,
      },
    },
    metadata: { termination: "max_steps" },
  });
  logger.warn(
    {
      sessionId: session?.id ?? null,
      steps,
      toolCallsExecuted,
      uniqueToolSignatures: toolCallHistory.size,
      durationMs: finalDurationMs,
      maxSteps: settings.maxSteps,
      maxDurationMs: settings.maxDurationMs,
      maxToolCallsPerRequest: settings.maxToolCallsPerRequest,
      hitLimits,
    },
    "Agent loop exceeded limits",
  );

  progress.agentLoopCompleted({
    sessionId: session?.id ?? null,
    agentId,
    steps,
    toolCallsExecuted,
    durationMs: finalDurationMs,
    terminationReason: "max_steps",
  });

  return {
    response: {
      status: 504,
      body: {
        error: "max_steps_exceeded",
        message: limitMessage,
        limits: {
          maxSteps: settings.maxSteps,
          maxDurationMs: settings.maxDurationMs,
          maxToolCallsPerRequest: settings.maxToolCallsPerRequest,
        },
        metrics: {
          steps,
          toolCallsExecuted,
          durationMs: finalDurationMs,
        },
        hint: hitLimits,
      },
      terminationReason: "max_steps",
    },
    steps,
    durationMs: finalDurationMs,
    terminationReason: "max_steps",
  };
}

/**
 * Detect if the current request is a suggestion mode call.
 * Scans the last user message for the [SUGGESTION MODE: marker.
 * @param {Array} messages - The conversation messages
 * @returns {{ isSuggestionMode: boolean }}
 */
function detectSuggestionMode(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return { isSuggestionMode: false };
  }
  // Scan from the end to find the last user message
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg?.role !== 'user') continue;
    const content = typeof msg.content === 'string'
      ? msg.content
      : Array.isArray(msg.content)
        ? msg.content.map(b => b.text || '').join(' ')
        : '';
    if (content.includes('[SUGGESTION MODE:')) {
      return { isSuggestionMode: true };
    }
    // Only check the last user message
    break;
  }
  return { isSuggestionMode: false };
}

/**
 * Detect if the current request is a topic detection/classification call.
 * These requests typically have a system prompt asking to classify conversation
 * topics, with no tools and very short messages. They waste GPU time on large
 * models (30-90s just to classify a topic).
 *
 * Detection heuristics:
 *  1. System prompt contains topic classification instructions
 *  2. No tools in the payload (topic detection never needs tools)
 *  3. Short message count (typically 1-3 messages)
 *
 * @param {Object} payload - The request payload
 * @returns {{ isTopicDetection: boolean }}
 */
function detectTopicDetection(payload) {
  if (!payload) return { isTopicDetection: false };

  // Topic detection requests have no tools
  if (Array.isArray(payload.tools) && payload.tools.length > 0) {
    return { isTopicDetection: false };
  }

  // Check system prompt for topic classification patterns
  const systemText = typeof payload.system === 'string'
    ? payload.system
    : Array.isArray(payload.system)
      ? payload.system.map(b => b.text || '').join(' ')
      : '';

  // Also check first message if system prompt is embedded there
  let firstMsgText = '';
  if (Array.isArray(payload.messages) && payload.messages.length > 0) {
    const first = payload.messages[0];
    if (first?.role === 'user' || first?.role === 'system') {
      firstMsgText = typeof first.content === 'string'
        ? first.content
        : Array.isArray(first.content)
          ? first.content.map(b => b.text || '').join(' ')
          : '';
    }
  }

  const combined = systemText + ' ' + firstMsgText;
  const lc = combined.toLowerCase();

  // Match patterns that Claude Code uses for topic detection
  const topicPatterns = [
    'new conversation topic',
    'topic change',
    'classify the topic',
    'classify this message',
    'conversation topic',
    'topic classification',
    'determines the topic',
    'determine the topic',
    'categorize the topic',
    'what topic',
    'identify the topic',
  ];

  const hasTopicPattern = topicPatterns.some(p => lc.includes(p));

  if (hasTopicPattern) {
    return { isTopicDetection: true };
  }

  // Additional heuristic: very short payload with no tools and system prompt
  // mentioning "topic" or "classify"
  if (
    !payload.tools &&
    Array.isArray(payload.messages) &&
    payload.messages.length <= 3 &&
    (lc.includes('topic') || lc.includes('classify'))
  ) {
    return { isTopicDetection: true };
  }

  return { isTopicDetection: false };
}

async function processMessage({ payload, headers, session, cwd, options = {} }) {
  const requestedModel =
    payload?.model ??
    config.modelProvider?.defaultModel ??
    "claude-3-unknown";
  const wantsThinking =
    typeof headers?.["anthropic-beta"] === "string" &&
    headers["anthropic-beta"].includes("interleaved-thinking");

  // === SUGGESTION MODE: Early return when SUGGESTION_MODE_MODEL=none ===
  const { isSuggestionMode } = detectSuggestionMode(payload?.messages);
  const suggestionModelConfig = config.modelProvider?.suggestionModeModel ?? "default";
  if (isSuggestionMode && suggestionModelConfig.toLowerCase() === "none") {
    logger.info('Suggestion mode: skipping LLM call (SUGGESTION_MODE_MODEL=none)');
    if (session) session._pendingUserInput = null;
    return {
      response: {
        body: {
          id: `msg_suggestion_skip_${Date.now()}`,
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "" }],
          model: requestedModel,
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
        ok: true,
        status: 200,
      },
      steps: 0,
      durationMs: 0,
      terminationReason: "suggestion_mode_skip",
    };
  }

  // === TOOL LOOP GUARD (EARLY CHECK) ===
  // Check BEFORE sanitization since sanitizePayload removes conversation history
  const toolLoopThreshold = config.policy?.toolLoopThreshold ?? 3;
  const { toolResultCount, toolUseCount } = countToolCallsInHistory(payload?.messages);

  console.log('[ToolLoopGuard EARLY] Checking ORIGINAL messages:', {
    messageCount: payload?.messages?.length,
    toolResultCount,
    toolUseCount,
    threshold: toolLoopThreshold,
  });

  if (toolResultCount >= toolLoopThreshold) {
    logger.error({
      toolResultCount,
      toolUseCount,
      threshold: toolLoopThreshold,
      sessionId: session?.id ?? null,
    }, "[ToolLoopGuard] FORCE TERMINATING - too many tool calls in conversation");

    // Extract tool results ONLY from CURRENT TURN (after last user text message)
    // This prevents showing old results from previous questions
    let toolResultsSummary = "";
    const messages = payload?.messages || [];

    // Find the last user text message index (same logic as countToolCallsInHistory)
    let lastUserTextIndex = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg?.role !== 'user') continue;
      if (typeof msg.content === 'string' && msg.content.trim().length > 0) {
        lastUserTextIndex = i;
        break;
      }
      if (Array.isArray(msg.content)) {
        const hasText = msg.content.some(block =>
          (block?.type === 'text' && block?.text?.trim?.().length > 0) ||
          (block?.type === 'input_text' && block?.input_text?.trim?.().length > 0)
        );
        if (hasText) {
          lastUserTextIndex = i;
          break;
        }
      }
    }

    // Only extract tool results AFTER the last user text message
    const startIndex = lastUserTextIndex >= 0 ? lastUserTextIndex : 0;
    for (let i = startIndex; i < messages.length; i++) {
      const msg = messages[i];
      if (!msg || !Array.isArray(msg.content)) continue;
      for (const block of msg.content) {
        if (block?.type === 'tool_result' && block?.content) {
          const content = typeof block.content === 'string'
            ? block.content
            : JSON.stringify(block.content);
          if (content && !content.includes('Found 0')) {
            toolResultsSummary += content + "\n";
          }
        }
      }
    }

    // Build response text based on actual results from CURRENT turn only
    let responseText = `Based on the tool results, here's what I found:\n\n`;
    if (toolResultsSummary.trim()) {
      responseText += toolResultsSummary.trim();
    } else {
      responseText += `The tools executed but didn't return clear results. Please check the tool output above or try a different command.`;
    }

    // Force return a response instead of continuing the loop
    const forcedResponse = {
      id: `msg_forced_${Date.now()}`,
      type: "message",
      role: "assistant",
      content: [
        {
          type: "text",
          text: responseText,
        },
      ],
      model: requestedModel || "unknown",
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: {
        input_tokens: 0,
        output_tokens: 100,
      },
    };

    if (session) session._pendingUserInput = null;
    return {
      status: 200,
      body: forcedResponse,
      terminationReason: "tool_loop_guard",
    };
  }

  // === INPUT CLEANUP: Strip interrupted request prefix ===
  if (session && payload?.messages) {
    cleanInterruptedInput(session, payload.messages);
  }

  // Set pending input flag (will be cleared on completion)
  const userText = extractLastUserText(payload?.messages);
  if (session && userText) {
    session._pendingUserInput = userText;
  }

  const cleanPayload = await sanitizePayload(payload);

  // Proactively load tools based on prompt content (lazy loading)
  try {
    const { loaded } = lazyLoader.ensureToolsForPrompt(cleanPayload.messages);
    if (loaded.length > 0) {
      logger.debug({ loaded }, "Proactively loaded tool categories for prompt");
    }
  } catch (err) {
    logger.debug({ error: err.message }, "Lazy tool loading check failed");
  }

  appendTurnToSession(session, {
    role: "user",
    content: {
      raw: payload?.messages ?? [],
      normalized: cleanPayload.messages,
    },
    type: "message",
  });

  let cacheKey = null;
  let cachedResponse = null;
  if (promptCache.isEnabled()) {
    // cleanPayload is already a deep clone from sanitizePayload, no need to clone again
    const { key, entry } = promptCache.lookup(cleanPayload);
    cacheKey = key;
    if (entry?.value) {
      try {
        // Use worker pool for large cached responses
        cachedResponse = await asyncClone(entry.value);
      } catch {
        cachedResponse = entry.value;
      }
    }
  }

  if (cachedResponse) {
    const anthropicPayload = toAnthropicResponse(
      cachedResponse.json,
      requestedModel,
      wantsThinking,
    );
    anthropicPayload.content = policy.sanitiseContent(anthropicPayload.content);

    const promptTokens = cachedResponse.json?.usage?.prompt_tokens ?? 0;
    const completionTokens = cachedResponse.json?.usage?.completion_tokens ?? 0;
    anthropicPayload.usage.input_tokens = promptTokens;
    anthropicPayload.usage.output_tokens = completionTokens;
    anthropicPayload.usage.cache_read_input_tokens = promptTokens;
    anthropicPayload.usage.cache_creation_input_tokens = 0;

    appendTurnToSession(session, {
      role: "assistant",
      type: "message",
      status: 200,
      content: anthropicPayload,
      metadata: { termination: "completion", cacheHit: true },
    });

    logger.info(
      {
        sessionId: session?.id ?? null,
        cacheKey,
      },
      "Agent response served from prompt cache",
    );

    if (session) session._pendingUserInput = null;
    return {
      status: 200,
      body: anthropicPayload,
      terminationReason: "completion",
    };
  }

  // Semantic cache lookup (fuzzy matching based on embedding similarity)
  let semanticLookupResult = null;
  const semanticCache = getSemanticCache();
  if (semanticCache.isEnabled()) {
    try {
      semanticLookupResult = await semanticCache.lookup(cleanPayload.messages);

      if (semanticLookupResult.hit) {
        const cachedBody = semanticLookupResult.response;
        logger.info({
          sessionId: session?.id ?? null,
          similarity: semanticLookupResult.similarity?.toFixed(4),
        }, "Agent response served from semantic cache");

        appendTurnToSession(session, {
          role: "assistant",
          type: "message",
          status: 200,
          content: cachedBody,
          metadata: {
            termination: "completion",
            semanticCacheHit: true,
            similarity: semanticLookupResult.similarity,
          },
        });

        if (session) session._pendingUserInput = null;
        return {
          status: 200,
          body: cachedBody,
          terminationReason: "completion",
        };
      }
    } catch (err) {
      logger.debug({ error: err.message }, "Semantic cache lookup failed, continuing without");
    }
  }

  // NOTE: Tool loop guard moved to BEFORE sanitizePayload() since sanitization
  // removes conversation history (consecutive same-role messages)

  const loopResult = await runAgentLoop({
    cleanPayload,
    requestedModel,
    wantsThinking,
    session,
    cwd,
    options,
    cacheKey,
    providerType: config.modelProvider?.type ?? "databricks",
    headers,
  });

  // Clear pending input flag - request completed
  if (session) {
    session._pendingUserInput = null;
  }

  // Store successful responses in semantic cache for future fuzzy matching
  if (semanticCache.isEnabled() && semanticLookupResult && !semanticLookupResult.hit) {
    if (loopResult.response?.status === 200 && loopResult.response?.body) {
      try {
        await semanticCache.store(semanticLookupResult, loopResult.response.body);
      } catch (err) {
        logger.debug({ error: err.message }, "Semantic cache store failed");
      }
    }
  }

  return loopResult.response;
}

module.exports = {
  processMessage,
};
