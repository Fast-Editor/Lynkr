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
const { classifyRequestType, selectToolsSmartly } = require("../tools/smart-selection");
const { compressMessages: headroomCompress, isEnabled: isHeadroomEnabled } = require("../headroom");
const { createAuditLogger } = require("../logger/audit-logger");
const { getResolvedIp, runWithDnsContext } = require("../clients/dns-logger");
const { getShuttingDown } = require("../api/health");
const crypto = require("crypto");
const { asyncClone, asyncTransform, getPoolStats } = require("../workers/helpers");
const { getSemanticCache, isSemanticCacheEnabled } = require("../cache/semantic");
const lazyLoader = require("../tools/lazy-loader");
const { isGPTProvider, getGPTToolLoopThreshold, areSimilarToolCalls } = require("../clients/gpt-utils");

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
      return config.ollama?.endpoint ?? 'unknown';
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
        const parsed = JSON.parse(trimmed);
        // Handle Anthropic content blocks array - extract text
        if (Array.isArray(parsed)) {
          const textParts = parsed
            .filter(block => block && typeof block === 'object')
            .map(block => {
              if (block.type === 'text' && typeof block.text === 'string') {
                return block.text;
              }
              // Handle other block types gracefully
              if (block.text) return block.text;
              if (block.content) return typeof block.content === 'string' ? block.content : JSON.stringify(block.content);
              return null;
            })
            .filter(text => text !== null);

          if (textParts.length > 0) {
            return textParts.join('\n');
          }
        }
        return parsed;
      } catch {
        return content;
      }
    }
    return content;
  }
  // Handle content that's already an array (content blocks)
  if (Array.isArray(content)) {
    const textParts = content
      .filter(block => block && typeof block === 'object')
      .map(block => {
        if (block.type === 'text' && typeof block.text === 'string') {
          return block.text;
        }
        if (block.text) return block.text;
        if (block.content) return typeof block.content === 'string' ? block.content : JSON.stringify(block.content);
        return null;
      })
      .filter(text => text !== null);

    if (textParts.length > 0) {
      return textParts.join('\n');
    }
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
 * Strip thinking-style reasoning from Ollama model outputs
 * Patterns to remove:
 * - Lines starting with bullet points (●, •, -, *)
 * - Explanatory reasoning before the actual response
 * - Multiple newlines used to separate thinking from response
 */
function stripThinkingBlocks(text) {
  if (typeof text !== "string") return text;

  // Split into lines
  const lines = text.split("\n");
  const cleanedLines = [];
  let inThinkingBlock = false;
  let consecutiveEmptyLines = 0;

  for (const line of lines) {
    const trimmed = line.trim();

    // Detect thinking block markers (bullet points followed by reasoning)
    if (/^[●•\-\*]\s/.test(trimmed)) {
      inThinkingBlock = true;
      continue;
    }

    // Empty lines might separate thinking from response
    if (trimmed === "") {
      consecutiveEmptyLines++;
      // If we've seen 2+ empty lines, likely end of thinking block
      if (consecutiveEmptyLines >= 2) {
        inThinkingBlock = false;
      }
      continue;
    }

    // Reset empty line counter
    consecutiveEmptyLines = 0;

    // Skip lines that are part of thinking block
    if (inThinkingBlock) {
      continue;
    }

    // Keep this line
    cleanedLines.push(line);
  }

  return cleanedLines.join("\n").trim();
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
    const cleanedContent = stripThinkingBlocks(rawContent);
    if (cleanedContent) {
      contentItems.push({ type: "text", text: cleanedContent });
    }
  }

  // Add tool calls if present
  if (Array.isArray(toolCalls) && toolCalls.length > 0) {
    const { buildAnthropicResponseFromOllama } = require("../clients/ollama-utils");
    // Use the utility function for tool call conversion
    return buildAnthropicResponseFromOllama(ollamaResponse, requestedModel);
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

function sanitizePayload(payload) {
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
    // Ollama format conversion
    // Check if model supports tools
    const { modelNameSupportsTools } = require("../clients/ollama-utils");
    const modelSupportsTools = modelNameSupportsTools(config.ollama?.model);

    if (!modelSupportsTools) {
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
    // Check if model supports tools
    const { modelNameSupportsTools } = require("../clients/ollama-utils");
    const modelSupportsTools = modelNameSupportsTools(config.ollama?.model);

    // Check if this is a simple conversational message (no tools needed)
    const isConversational = (() => {
      if (!Array.isArray(clean.messages) || clean.messages.length === 0) {
        return false;
      }
      const lastMessage = clean.messages[clean.messages.length - 1];
      if (lastMessage?.role !== "user") {
        return false;
      }

      const content = typeof lastMessage.content === "string"
        ? lastMessage.content
        : "";

      const trimmed = content.trim().toLowerCase();

      // Simple greetings
      if (/^(hi|hello|hey|good morning|good afternoon|good evening|howdy|greetings)[\s\.\!\?]*$/.test(trimmed)) {
        return "greeting";
      }

      // Very short messages (< 20 chars) without code/technical keywords
      if (trimmed.length < 20 && !/code|file|function|error|bug|fix|write|read|create/.test(trimmed)) {
        return "short_message";
      }

      return false;
    })();

    if (isConversational) {
      // Strip all tools for simple conversational messages
      delete clean.tools;
      delete clean.tool_choice;
      logger.debug({
        model: config.ollama?.model,
        reason: isConversational,
      }, "Ollama conversational mode - tools removed");
    } else if (modelSupportsTools && Array.isArray(clean.tools) && clean.tools.length > 0) {
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
        "WebFetch"
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
      // Remove tools for models without tool support
      delete clean.tools;
      delete clean.tool_choice;
    }
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
    const { modelNameSupportsTools } = require("../clients/ollama-utils");
    const modelSupportsTools = modelNameSupportsTools(config.ollama?.model);

    if (!modelSupportsTools) {
      delete clean.tool_choice;
    }
    // For tool-capable models, Ollama doesn't support tool_choice, so remove it
    delete clean.tool_choice;
  } else if (clean.tool_choice === undefined || clean.tool_choice === null) {
    delete clean.tool_choice;
  }

  // Smart tool selection (universal, applies to all providers)
  if (config.smartToolSelection?.enabled && Array.isArray(clean.tools) && clean.tools.length > 0) {
    const classification = classifyRequestType(clean);
    const selectedTools = selectToolsSmartly(clean.tools, classification, {
      provider: providerType,
      tokenBudget: config.smartToolSelection.tokenBudget,
      config: config.smartToolSelection
    });

    // Only log if tools were actually filtered (avoid logging overhead)
    if (selectedTools.length !== clean.tools.length) {
      logger.info({
        requestType: classification.type,
        originalCount: clean.tools.length,
        selectedCount: selectedTools.length,
        provider: providerType
      }, "Smart tool selection applied");
    }

    clean.tools = selectedTools.length > 0 ? selectedTools : undefined;
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
      logger.debug({
        originalCount: clean.messages.length,
        mergedCount: merged.length,
        reduced: clean.messages.length - merged.length
      }, 'Merged consecutive messages with same role');
    }

    clean.messages = merged;
  }

  logger.debug({
    providerType: config.modelProvider?.type ?? "databricks",
    messageCount: clean.messages?.length ?? 0,
    toolCount: clean.tools?.length ?? 0
  }, 'After sanitizePayload');

  // === Suggestion mode: tag request and override model if configured ===
  const { isSuggestionMode: isSuggestion } = detectSuggestionMode(clean.messages);
  clean._requestMode = isSuggestion ? "suggestion" : "main";
  const smConfig = config.modelProvider?.suggestionModeModel ?? "default";
  if (isSuggestion && smConfig.toLowerCase() !== "default" && smConfig.toLowerCase() !== "none") {
    clean.model = smConfig;
    clean._suggestionModeModel = smConfig;
  }

  return clean;
}

const DEFAULT_LOOP_OPTIONS = {
  maxSteps: config.policy.maxStepsPerTurn ?? 6,
  maxDurationMs: 120000,
  maxToolCallsPerRequest: config.policy.maxToolCallsPerRequest ?? 20, // Prevent runaway tool calling
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
  logger.debug({ providerType, messageCount: cleanPayload.messages?.length }, 'runAgentLoop entered');
  const settings = resolveLoopOptions(options);
  // Initialize audit logger (no-op if disabled)
  const auditLogger = createAuditLogger(config.audit);
  const start = Date.now();
  let steps = 0;
  let toolCallsExecuted = 0;
  let fallbackPerformed = false;
  const toolCallNames = new Map();
  const toolCallHistory = new Map(); // Track tool calls to detect loops: signature -> count
  let loopWarningInjected = false; // Track if we've already warned about loops

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

    // Trim messages when they grow too large to prevent OOM.
    // Keep the first message (system/user) and the last MAX_LOOP_MESSAGES.
    const MAX_LOOP_MESSAGES = 40;
    if (cleanPayload.messages && cleanPayload.messages.length > MAX_LOOP_MESSAGES) {
      const excess = cleanPayload.messages.length - MAX_LOOP_MESSAGES;
      // Keep first 2 messages (system context + initial user) and trim from the middle
      cleanPayload.messages.splice(2, excess);
      logger.debug(
        { trimmed: excess, remaining: cleanPayload.messages.length },
        "Trimmed intermediate messages to prevent memory growth",
      );
    }

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
            enabled: true
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

    logger.debug({
      sessionId: session?.id ?? null,
      messageCount: cleanPayload.messages?.length ?? 0,
      toolCount: cleanPayload.tools?.length ?? 0
    }, 'After memory injection');

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

      if (compressionResult.compressed) {
        cleanPayload.messages = compressionResult.messages;
        if (compressionResult.tools) {
          cleanPayload.tools = compressionResult.tools;
        }
      }

      logger.debug({
        sessionId: session?.id ?? null,
        outcome: compressionResult.compressed ? 'applied' : 'skipped',
        tokensBefore: compressionResult.stats?.tokens_before,
        tokensAfter: compressionResult.stats?.tokens_after,
        savingsPercent: compressionResult.stats?.savings_percent,
        reason: compressionResult.stats?.reason || compressionResult.stats?.transforms_applied?.join(', ') || 'none',
      }, 'Headroom compression');
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

  let databricksResponse;
  try {
    databricksResponse = await invokeModel(cleanPayload);
  } catch (modelError) {
    const isConnectionError = modelError.cause?.code === 'ECONNREFUSED'
      || modelError.message?.includes('fetch failed')
      || modelError.code === 'ECONNREFUSED';
    if (isConnectionError) {
      logger.error(`Provider ${providerType} is unreachable (connection refused). Is it running?`);
      return {
        response: {
          status: 503,
          body: {
            error: {
              type: "provider_unreachable",
              message: `Provider ${providerType} is unreachable. Is the service running?`,
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

      logger.debug(
        {
          sessionId: session?.id ?? null,
          contentBlocks: contentArray.length,
          toolCallsFound: toolCalls.length,
          stopReason: databricksResponse.json?.stop_reason,
        },
        "Azure Anthropic response parsed",
      );
    } else {
      // OpenAI/Databricks format: { choices: [{ message: { tool_calls: [...] } }] }
      const choice = databricksResponse.json?.choices?.[0];
      message = choice?.message ?? {};
      toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    }

    // Guard: drop hallucinated tool calls when no tools were sent to the model.
    // Some models (e.g. Llama 3.1) hallucinate tool_call blocks from conversation
    // history even when the request contained zero tool definitions.
    const toolsWereSent = Array.isArray(cleanPayload.tools) && cleanPayload.tools.length > 0;
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
        assistantToolMessage.content = `Invoking tool(s): ${toolNames}`;
      }

      cleanPayload.messages.push(assistantToolMessage);

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
        logger.debug(
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

        logger.debug(
          {
            sessionId: session?.id ?? null,
            serverToolCount: serverSideToolCalls.length,
          },
          "Executing server-side tools in hybrid mode"
        );
      } else if (executionMode === "passthrough" || executionMode === "client") {
        // Only Server-side tools, no Client-side tools - execute all server-side
        logger.debug(
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
              provider: providerType,  // Pass provider for GPT-specific formatting
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
              "Maximum tool calls per request exceeded after parallel Task execution - terminating",
            );

            return {
              response: {
                status: 500,
                body: {
                  error: {
                    type: "max_tool_calls_exceeded",
                    message: `Maximum tool calls per request exceeded. The model attempted to execute ${toolCallsExecuted} tool calls, but the limit is ${settings.maxToolCallsPerRequest}. This may indicate a complex task that requires breaking down into smaller steps.`,
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
            "Maximum tool calls per request exceeded - terminating",
          );

          return {
            response: {
              status: 500,
              body: {
                error: {
                  type: "max_tool_calls_exceeded",
                  message: `Maximum tool calls per request exceeded. The model attempted to execute ${toolCallsExecuted} tool calls, but the limit is ${settings.maxToolCallsPerRequest}. This may indicate a complex task that requires breaking down into smaller steps.`,
                },
              },
              terminationReason: "max_tool_calls_exceeded",
            },
            steps,
            durationMs: Date.now() - start,
            terminationReason: "max_tool_calls_exceeded",
          };
        }

        const execution = await executeToolCall(call, {
          session,
          cwd,
          requestMessages: cleanPayload.messages,
          provider: providerType,  // Pass provider for GPT-specific formatting
        });

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
      // GPT models get stricter thresholds (2 vs 3) and similarity-based detection
      const isGPT = isGPTProvider(providerType);
      const loopThreshold = isGPT ? getGPTToolLoopThreshold() : 3;

      for (const call of toolCalls) {
        const signature = getToolCallSignature(call);
        const existingEntry = toolCallHistory.get(signature);
        let count = (existingEntry?.count || 0) + 1;
        toolCallHistory.set(signature, { count, call });

        const toolName = call.function?.name ?? call.name ?? 'unknown';

        // For GPT models, also check for similar (not just identical) tool calls
        // This catches cases where GPT slightly varies parameters but is essentially looping
        if (isGPT) {
          for (const [existingSig, existingData] of toolCallHistory.entries()) {
            if (existingSig !== signature && areSimilarToolCalls(call, existingData.call)) {
              // Found a similar call - increase count to trigger loop detection earlier
              count = Math.max(count, existingData.count + 1);
              logger.debug({
                tool: toolName,
                currentSignature: signature,
                similarSignature: existingSig,
                combinedCount: count,
              }, "GPT similar tool call detected - combining counts");
            }
          }
        }

        if (count === loopThreshold && !loopWarningInjected) {
          logger.warn(
            {
              sessionId: session?.id ?? null,
              correlationId: options?.correlationId,
              tool: toolName,
              loopCount: count,
              loopThreshold,
              isGPT,
              signature: signature,
              action: 'warning_injected',
              totalSteps: steps,
              remainingSteps: settings.maxSteps - steps,
            },
            `Tool call loop detected - same tool called ${loopThreshold} times with identical/similar parameters`,
          );

          // Inject warning message to model - GPT gets a more explicit message
          loopWarningInjected = true;
          const warningMessage = {
            role: "user",
            content: isGPT
              ? `⚠️ CRITICAL SYSTEM WARNING: You have called the "${toolName}" tool ${count} times with identical or similar parameters. This IS an infinite loop. STOP calling this tool immediately. You MUST now provide a direct text response to the user based on the results you have received. If the tool returned "no results" or empty output, that IS the final answer - do not retry. Summarize your findings and respond.`
              : `⚠️ System Warning: You have called the same tool with identical parameters ${count} times in this request. This may indicate an infinite loop. Please provide a final answer to the user instead of calling the same tool again, or explain why you need to continue retrying with the same parameters.`,
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
                isGPT,
                loopThreshold,
              },
            });
          }
        } else if (count > loopThreshold) {
          // Force termination after threshold exceeded
          // Log FULL context for debugging why the loop occurred
          logger.error(
            {
              sessionId: session?.id ?? null,
              correlationId: options?.correlationId,
              tool: toolName,
              loopCount: count,
              loopThreshold,
              isGPT,
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
                  message: `Tool call loop detected: The model called the same tool ("${toolName}") with identical parameters ${count} times (threshold: ${loopThreshold}). This indicates an infinite loop and execution has been terminated. Please try rephrasing your request or provide different parameters.`,
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

      continue;
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
            provider: providerType,  // Pass provider for GPT-specific formatting
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
              "Maximum tool calls per request exceeded during fallback - terminating",
            );

            return {
              response: {
                status: 500,
                body: {
                  error: {
                    type: "max_tool_calls_exceeded",
                    message: `Maximum tool calls per request exceeded. The model attempted to execute ${toolCallsExecuted} tool calls, but the limit is ${settings.maxToolCallsPerRequest}. This may indicate a complex task that requires breaking down into smaller steps.`,
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
    logger.info(
      {
        sessionId: session?.id ?? null,
        steps,
        toolCallsExecuted,
        uniqueToolSignatures: toolCallHistory.size,
        toolCallLoopWarnings: loopWarningInjected ? 1 : 0,
        durationMs: finalDurationMs,
        avgDurationPerStep: steps > 0 ? Math.round(finalDurationMs / steps) : 0,
      },
      "Agent loop completed successfully",
    );
    return {
      response: {
        status: 200,
        body: anthropicPayload,
        terminationReason: "completion",
      },
      steps,
      durationMs: finalDurationMs,
      terminationReason: "completion",
    };
  }

  appendTurnToSession(session, {
    role: "assistant",
    type: "error",
    status: 504,
    content: {
      error: "max_steps_exceeded",
      message: "Reached agent loop limits without producing a response.",
      limits: {
        maxSteps: settings.maxSteps,
        maxDurationMs: settings.maxDurationMs,
      },
    },
    metadata: { termination: "max_steps" },
  });
  const finalDurationMs = Date.now() - start;
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
    },
    "Agent loop exceeded limits",
  );

  return {
    response: {
      status: 504,
      body: {
        error: "max_steps_exceeded",
        message: "Reached agent loop limits without producing a response.",
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
    return {
      response: {
        json: {
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
  // GPT models get a lower threshold (2) to catch loops earlier
  const providerType = config.modelProvider?.type ?? "databricks";
  const isGPT = isGPTProvider(providerType);
  const toolLoopThreshold = isGPT
    ? getGPTToolLoopThreshold()  // Hardcoded: 2 for GPT
    : (config.policy?.toolLoopThreshold ?? 3);
  const { toolResultCount, toolUseCount } = countToolCallsInHistory(payload?.messages);

  // Temporarily increase threshold in client mode to allow tool execution flow
  const effectiveThreshold = config.toolExecutionMode === 'client' ? 10 : toolLoopThreshold;

  if (toolResultCount >= effectiveThreshold) {
    logger.error({
      toolResultCount,
      toolUseCount,
      threshold: effectiveThreshold,
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

    return {
      status: 200,
      body: forcedResponse,
      terminationReason: "tool_loop_guard",
    };
  }

  const cleanPayload = sanitizePayload(payload);

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
