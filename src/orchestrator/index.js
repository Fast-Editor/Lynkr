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

    // Flatten system messages into the first user message
    const systemChunks = [];
    clean.messages = clean.messages.filter((msg) => {
      if (msg?.role === "system") {
        if (typeof msg.content === "string" && msg.content.trim().length > 0) {
          systemChunks.push(msg.content.trim());
        }
        return false;
      }
      return true;
    });

    // Prepend system content to first user message if present
    if (systemChunks.length > 0 && clean.messages.length > 0) {
      const systemContent = systemChunks.join("\n\n");
      const firstMsg = clean.messages[0];
      if (firstMsg.role === "user") {
        firstMsg.content = `${systemContent}\n\n${firstMsg.content}`;
      }
    }

    delete clean.system;
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
      if (trimmed.length < 20 && !/code|file|function|error|bug|fix|write|read|create/.test(trimmed)) {
        logger.debug({ matched: "short", trimmed, length: trimmed.length }, "Ollama conversational check - matched");
        return true;
      }

      logger.debug({ trimmed: trimmed.substring(0, 50), length: trimmed.length }, "Ollama conversational check - not matched");
      return false;
    })();

    if (isConversational) {
      // Strip all tools for simple conversational messages
      delete clean.tools;
      delete clean.tool_choice;
      logger.debug({
        model: config.ollama?.model,
        message: "Removed tools for conversational message"
      }, "Ollama conversational mode");
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

  // FIX: Prevent consecutive messages with the same role (causes llama.cpp 400 error)
  if (Array.isArray(clean.messages) && clean.messages.length > 0) {
    const deduplicated = [];
    let lastRole = null;

    for (const msg of clean.messages) {
      // Skip if this message has the same role as the previous one
      if (msg.role === lastRole) {
        logger.debug({
          skippedRole: msg.role,
          contentPreview: typeof msg.content === 'string'
            ? msg.content.substring(0, 50)
            : JSON.stringify(msg.content).substring(0, 50)
        }, 'Skipping duplicate consecutive message with same role');
        continue;
      }

      deduplicated.push(msg);
      lastRole = msg.role;
    }

    if (deduplicated.length !== clean.messages.length) {
      logger.info({
        originalCount: clean.messages.length,
        deduplicatedCount: deduplicated.length,
        removed: clean.messages.length - deduplicated.length
      }, 'Removed consecutive duplicate roles from message sequence');
    }

    clean.messages = deduplicated;
  }

  return clean;
}

const DEFAULT_LOOP_OPTIONS = {
  maxSteps: config.policy.maxStepsPerTurn ?? 6,
  maxDurationMs: 120000,
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
  return {
    ...DEFAULT_LOOP_OPTIONS,
    maxSteps,
    maxDurationMs,
  };
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
  options,
  cacheKey,
  providerType,
}) {
  const settings = resolveLoopOptions(options);
  const start = Date.now();
  let steps = 0;
  let toolCallsExecuted = 0;
  let fallbackPerformed = false;
  const toolCallNames = new Map();

  while (steps < settings.maxSteps) {
    if (Date.now() - start > settings.maxDurationMs) {
      break;
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

  const databricksResponse = await invokeModel(cleanPayload);

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

    if (providerType === "azure-anthropic") {
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

    if (toolCalls.length > 0) {
      // Convert OpenAI/OpenRouter format to Anthropic format for session storage
      let sessionContent;
      if (providerType === "azure-anthropic") {
        // Azure Anthropic already returns content in Anthropic format
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
              requestMessages: cleanPayload.messages,
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

        const execution = await executeToolCall(call, {
          session,
          requestMessages: cleanPayload.messages,
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

      // Validate Azure OpenAI response has choices array before conversion
      if (!databricksResponse.json?.choices?.length) {
        logger.warn({
          json: databricksResponse.json,
          status: databricksResponse.status
        }, "Azure OpenAI response missing choices array");

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

      // Log Azure OpenAI raw response
      logger.info({
        hasChoices: !!databricksResponse.json?.choices,
        choiceCount: databricksResponse.json?.choices?.length || 0,
        firstChoice: databricksResponse.json?.choices?.[0],
        hasToolCalls: !!databricksResponse.json?.choices?.[0]?.message?.tool_calls,
        toolCallCount: databricksResponse.json?.choices?.[0]?.message?.tool_calls?.length || 0,
        finishReason: databricksResponse.json?.choices?.[0]?.finish_reason
      }, "=== AZURE OPENAI RAW RESPONSE ===");

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
            requestMessages: cleanPayload.messages,
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

    logger.info(
      {
        sessionId: session?.id ?? null,
        steps,
        durationMs: Date.now() - start,
      },
      "Agent loop completed",
    );
    return {
      response: {
        status: 200,
        body: anthropicPayload,
        terminationReason: "completion",
      },
      steps,
      durationMs: Date.now() - start,
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
  logger.warn(
    {
      sessionId: session?.id ?? null,
      steps,
      durationMs: Date.now() - start,
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
        },
      },
      terminationReason: "max_steps",
    },
    steps,
    durationMs: Date.now() - start,
    terminationReason: "max_steps",
  };
}

async function processMessage({ payload, headers, session, options = {} }) {
  const requestedModel =
    payload?.model ??
    config.modelProvider?.defaultModel ??
    "claude-3-unknown";
  const wantsThinking =
    typeof headers?.["anthropic-beta"] === "string" &&
    headers["anthropic-beta"].includes("interleaved-thinking");

  const cleanPayload = sanitizePayload(payload);
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
    const cacheSeedPayload = JSON.parse(JSON.stringify(cleanPayload));
    const { key, entry } = promptCache.lookup(cacheSeedPayload);
    cacheKey = key;
    if (entry?.value) {
      try {
        cachedResponse = JSON.parse(JSON.stringify(entry.value));
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

  const loopResult = await runAgentLoop({
    cleanPayload,
    requestedModel,
    wantsThinking,
    session,
    options,
    cacheKey,
    providerType: config.modelProvider?.type ?? "databricks",
  });

  return loopResult.response;
}

module.exports = {
  processMessage,
};
