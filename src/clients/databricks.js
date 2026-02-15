const config = require("../config");
const http = require("http");
const https = require("https");
const { withRetry } = require("./retry");
const { getCircuitBreakerRegistry } = require("./circuit-breaker");
const { getMetricsCollector } = require("../observability/metrics");
const { getHealthTracker } = require("../observability/health-tracker");
const logger = require("../logger");
const { STANDARD_TOOLS } = require("./standard-tools");
const { convertAnthropicToolsToOpenRouter } = require("./openrouter-utils");
const {
  detectModelFamily
} = require("./bedrock-utils");




if (typeof fetch !== "function") {
  throw new Error("Node 18+ is required for the built-in fetch API.");
}

/**
 * Simple Semaphore for limiting concurrent requests
 * Used to prevent Z.AI rate limiting from parallel Claude Code CLI calls
 */
class Semaphore {
  constructor(maxConcurrent = 2) {
    this.maxConcurrent = maxConcurrent;
    this.current = 0;
    this.queue = [];
  }

  async acquire() {
    if (this.current < this.maxConcurrent) {
      this.current++;
      return;
    }

    // Wait in queue
    return new Promise((resolve) => {
      this.queue.push(resolve);
    });
  }

  release() {
    this.current--;
    if (this.queue.length > 0 && this.current < this.maxConcurrent) {
      this.current++;
      const next = this.queue.shift();
      next();
    }
  }

  async run(fn) {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}

// Z.AI request semaphore - limit concurrent requests to avoid rate limiting
// Configurable via ZAI_MAX_CONCURRENT env var (default: 2)
const zaiMaxConcurrent = parseInt(process.env.ZAI_MAX_CONCURRENT || '2', 10);
const zaiSemaphore = new Semaphore(zaiMaxConcurrent);
logger.info({ maxConcurrent: zaiMaxConcurrent }, "Z.AI semaphore initialized");



// HTTP connection pooling for better performance
const httpAgent = new http.Agent({
  keepAlive: true,
  maxSockets: 50,
  maxFreeSockets: 10,
  timeout: 60000,
  keepAliveMsecs: 30000,
});

const httpsAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 50,
  maxFreeSockets: 10,
  timeout: 60000,
  keepAliveMsecs: 30000,
});

async function performJsonRequest(url, { headers = {}, body }, providerLabel) {
  const agent = url.startsWith('https:') ? httpsAgent : httpAgent;
  const isStreaming = body.stream === true;

  // Streaming requests can't be retried, so handle them directly
  if (isStreaming) {
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      agent,
    });

    logger.debug({
      provider: providerLabel,
      status: response.status,
      streaming: true,
    }, `${providerLabel} API streaming response`);

    if (!response.ok) {
      const errorText = await response.text();
      logger.warn({
        provider: providerLabel,
        status: response.status,
        error: errorText.substring(0, 200),
      }, `${providerLabel} API streaming error`);
    }

    return {
      ok: response.ok,
      status: response.status,
      stream: response.body, // Return the readable stream
      contentType: response.headers.get("content-type"),
      headers: response.headers,
    };
  }

  // Non-streaming requests use retry logic
  return withRetry(async () => {
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      agent,
    });
    const text = await response.text();

    logger.debug({
      provider: providerLabel,
      status: response.status,
      responseLength: text.length,
    }, `${providerLabel} API response`);

    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }

    const result = {
      ok: response.ok,
      status: response.status,
      json,
      text,
      contentType: response.headers.get("content-type"),
      headers: response.headers,
    };

    // Log errors for retry logic
    if (!response.ok) {
      logger.warn({
        provider: providerLabel,
        status: response.status,
        error: json?.error || text.substring(0, 200),
      }, `${providerLabel} API error`);
    }

    return result;
  }, {
    maxRetries: config.apiRetry?.maxRetries || 3,
    initialDelay: config.apiRetry?.initialDelay || 1000,
    maxDelay: config.apiRetry?.maxDelay || 30000,
  });
}

async function invokeDatabricks(body) {
  if (!config.databricks?.url) {
    throw new Error("Databricks configuration is missing required URL.");
  }

  // Create a copy of body to avoid mutating the original
  const databricksBody = { ...body };

  // Inject standard tools if client didn't send any (passthrough mode)
  if (!Array.isArray(databricksBody.tools) || databricksBody.tools.length === 0) {
    databricksBody.tools = STANDARD_TOOLS;
    logger.info({
      injectedToolCount: STANDARD_TOOLS.length,
      injectedToolNames: STANDARD_TOOLS.map(t => t.name),
      reason: "Client did not send tools (passthrough mode)"
    }, "=== INJECTING STANDARD TOOLS (Databricks) ===");
  }

  // Convert Anthropic format tools to OpenAI format (Databricks uses OpenAI format)
  if (Array.isArray(databricksBody.tools) && databricksBody.tools.length > 0) {
    // Check if tools are already in OpenAI format (have type: "function")
    const alreadyConverted = databricksBody.tools[0]?.type === "function";

    if (!alreadyConverted) {
      databricksBody.tools = convertAnthropicToolsToOpenRouter(databricksBody.tools);
      logger.debug({
        convertedToolCount: databricksBody.tools.length,
        convertedToolNames: databricksBody.tools.map(t => t.function?.name),
      }, "Converted tools to OpenAI format for Databricks");
    } else {
      logger.debug({
        toolCount: databricksBody.tools.length,
        toolNames: databricksBody.tools.map(t => t.function?.name),
      }, "Tools already in OpenAI format, skipping conversion");
    }
  }

  const headers = {
    Authorization: `Bearer ${config.databricks.apiKey}`,
    "Content-Type": "application/json",
  };
  return performJsonRequest(config.databricks.url, { headers, body: databricksBody }, "Databricks");
}

async function invokeAzureAnthropic(body) {
  if (!config.azureAnthropic?.endpoint) {
    throw new Error("Azure Anthropic endpoint is not configured.");
  }

  // Inject standard tools if client didn't send any (passthrough mode)
  if (!Array.isArray(body.tools) || body.tools.length === 0) {
    body.tools = STANDARD_TOOLS;
    logger.info({
      injectedToolCount: STANDARD_TOOLS.length,
      injectedToolNames: STANDARD_TOOLS.map(t => t.name),
      reason: "Client did not send tools (passthrough mode)"
    }, "=== INJECTING STANDARD TOOLS (Azure Anthropic) ===");
  }

  const headers = {
    "Content-Type": "application/json",
    "x-api-key": config.azureAnthropic.apiKey,
    "anthropic-version": config.azureAnthropic.version ?? "2023-06-01",
  };
  return performJsonRequest(
    config.azureAnthropic.endpoint,
    { headers, body },
    "Azure Anthropic",
  );
}

async function invokeOllama(body) {
  if (!config.ollama?.endpoint) {
    throw new Error("Ollama endpoint is not configured.");
  }

  const { convertAnthropicToolsToOllama, checkOllamaToolSupport } = require("./ollama-utils");

  const endpoint = `${config.ollama.endpoint}/api/chat`;
  const headers = { "Content-Type": "application/json" };

  // Convert Anthropic messages format to Ollama format
  // Ollama expects content as string, not content blocks array
  const convertedMessages = [];

  // Handle system prompt (same pattern as other providers)
  if (body.system && typeof body.system === "string" && body.system.trim().length > 0) {
    convertedMessages.push({
      role: "system",
      content: body.system.trim()
    });
  }

  // Add user/assistant messages
  (body.messages || []).forEach(msg => {
    let content = msg.content;

    // Convert content blocks array to simple string
    if (Array.isArray(content)) {
      content = content
        .filter(block => block.type === 'text')
        .map(block => block.text || '')
        .join('\n');
    }

    convertedMessages.push({
      role: msg.role,
      content: content || ''
    });
  });

  // FIX: Deduplicate consecutive messages with same role (Ollama may reject this)
  const deduplicated = [];
  let lastRole = null;
  for (const msg of convertedMessages) {
    if (msg.role === lastRole) {
      logger.debug({
        skippedRole: msg.role,
        contentPreview: msg.content.substring(0, 50)
      }, 'Ollama: Skipping duplicate consecutive message with same role');
      continue;
    }
    deduplicated.push(msg);
    lastRole = msg.role;
  }

  if (deduplicated.length !== convertedMessages.length) {
    logger.info({
      originalCount: convertedMessages.length,
      deduplicatedCount: deduplicated.length,
      removed: convertedMessages.length - deduplicated.length,
      messageRoles: convertedMessages.map(m => m.role).join(' → '),
      deduplicatedRoles: deduplicated.map(m => m.role).join(' → ')
    }, 'Ollama: Removed consecutive duplicate roles from message sequence');
  }

  const ollamaBody = {
    model: body._suggestionModeModel || config.ollama.model,
    messages: deduplicated,
    stream: false,  // Force non-streaming for Ollama - streaming format conversion not yet implemented
    options: {
      temperature: body.temperature ?? 0.7,
      num_predict: body.max_tokens ?? 4096,
      top_p: body.top_p ?? 1.0,
    },
  };

  // Add keep_alive if configured (controls how long model stays loaded)
  // Accepts: duration strings ("10m", "24h"), numbers (seconds), -1 (permanent), 0 (immediate unload)
  if (config.ollama.keepAlive !== undefined) {
    const keepAlive = config.ollama.keepAlive;
    // Parse as number if it looks like one, otherwise use string
    ollamaBody.keep_alive = /^-?\d+$/.test(keepAlive)
      ? parseInt(keepAlive, 10)
      : keepAlive;
    logger.debug({ keepAlive: ollamaBody.keep_alive }, "Ollama keep_alive configured");
  }

  // Check if model supports tools FIRST (before wasteful injection)
  const supportsTools = await checkOllamaToolSupport(config.ollama.model);

  // Inject standard tools if client didn't send any (passthrough mode)
  let toolsToSend = body.tools;
  let toolsInjected = false;

  const injectToolsOllama = process.env.INJECT_TOOLS_OLLAMA !== "false";

  if (!supportsTools) {
    // Model doesn't support tools - don't inject them
    toolsToSend = null;
  } else if (injectToolsOllama && (!Array.isArray(toolsToSend) || toolsToSend.length === 0)) {
    // Model supports tools and none provided - inject them
    toolsToSend = STANDARD_TOOLS;
    toolsInjected = true;
  }

  // Add tools if present AND model supports them
  if (supportsTools && Array.isArray(toolsToSend) && toolsToSend.length > 0) {
    ollamaBody.tools = convertAnthropicToolsToOllama(toolsToSend);
  }

  // Single consolidated log message for all cases (easy to grep and compare across models)
  const toolCount = (supportsTools && Array.isArray(toolsToSend)) ? toolsToSend.length : 0;
  let logMessage;

  if (!supportsTools) {
    logMessage = `Tools not supported (0 tools)`;
  } else if (toolsInjected) {
    logMessage = `injected ${toolCount} tools`;
  } else if (Array.isArray(toolsToSend) && toolsToSend.length > 0) {
    logMessage = `Using client-provided tools (${toolCount} tools)`;
  } else if (!injectToolsOllama) {
    logMessage = `Tool injection disabled (0 tools)`;
  } else {
    logMessage = `No tools (0 tools)`;
  }

  logger.info({
    model: config.ollama.model,
    toolCount,
    toolsInjected,
    supportsTools,
    toolNames: (Array.isArray(toolsToSend) && toolsToSend.length > 0) ? toolsToSend.map(t => t.name) : []
  }, `=== Ollama STANDARD TOOLS INJECTION for ${config.ollama.model} === ${logMessage}`);

  return performJsonRequest(endpoint, { headers, body: ollamaBody }, "Ollama");
}

async function invokeOpenRouter(body) {
  if (!config.openrouter?.endpoint || !config.openrouter?.apiKey) {
    throw new Error("OpenRouter endpoint or API key is not configured.");
  }

  const {
    convertAnthropicToolsToOpenRouter,
    convertAnthropicMessagesToOpenRouter
  } = require("./openrouter-utils");

  const endpoint = config.openrouter.endpoint;
  const headers = {
    "Authorization": `Bearer ${config.openrouter.apiKey}`,
    "Content-Type": "application/json",
    "HTTP-Referer": "https://localhost:8080",
    "X-Title": "Claude-Ollama-Proxy"
  };

  // Convert messages and handle system message
  const messages = convertAnthropicMessagesToOpenRouter(body.messages || []);

  // Anthropic uses separate 'system' field, OpenAI needs it as first message
  if (body.system) {
    messages.unshift({
      role: "system",
      content: body.system
    });
  }

  const openRouterBody = {
    model: body._suggestionModeModel || config.openrouter.model,
    messages,
    temperature: body.temperature ?? 0.7,
    max_tokens: body.max_tokens ?? 4096,
    top_p: body.top_p ?? 1.0,
    stream: body.stream ?? false
  };

  // Add tools - inject standard tools if client didn't send any (passthrough mode)
  let toolsToSend = body.tools;
  let toolsInjected = false;

  if (!Array.isArray(toolsToSend) || toolsToSend.length === 0) {
    // Client didn't send tools (likely passthrough mode) - inject standard Claude Code tools
    toolsToSend = STANDARD_TOOLS;
    toolsInjected = true;
    logger.info({
      injectedToolCount: STANDARD_TOOLS.length,
      injectedToolNames: STANDARD_TOOLS.map(t => t.name),
      reason: "Client did not send tools (passthrough mode)"
    }, "=== INJECTING STANDARD TOOLS (OpenRouter) ===");
  }

  if (Array.isArray(toolsToSend) && toolsToSend.length > 0) {
    openRouterBody.tools = convertAnthropicToolsToOpenRouter(toolsToSend);
    logger.info({
      toolCount: toolsToSend.length,
      toolNames: toolsToSend.map(t => t.name),
      toolsInjected
    }, "Sending tools to OpenRouter");
  }

  return performJsonRequest(endpoint, { headers, body: openRouterBody }, "OpenRouter");
}

function detectAzureFormat(url) {
  if (url.includes("/openai/responses")) return "responses";
  if (url.includes("/models/")) return "models";
  if (url.includes("/openai/deployments")) return "deployments";
  throw new Error("Unknown Azure OpenAI endpoint");
}


async function invokeAzureOpenAI(body) {
  if (!config.azureOpenAI?.endpoint || !config.azureOpenAI?.apiKey) {
    throw new Error("Azure OpenAI endpoint or API key is not configured.");
  }

  const {
    convertAnthropicToolsToOpenRouter,
    convertAnthropicMessagesToOpenRouter
  } = require("./openrouter-utils");

  // Azure OpenAI URL format
  const endpoint = config.azureOpenAI.endpoint;
  const format = detectAzureFormat(endpoint);

  const headers = {
    "Content-Type": "application/json"
  };

  // Azure AI Foundry (services.ai.azure.com) uses Bearer auth
  // Standard Azure OpenAI (openai.azure.com) uses api-key header
  if (endpoint.includes("services.ai.azure.com")) {
    headers["Authorization"] = `Bearer ${config.azureOpenAI.apiKey}`;
  } else {
    headers["api-key"] = config.azureOpenAI.apiKey;
  }

  // Convert messages and handle system message
  const messages = convertAnthropicMessagesToOpenRouter(body.messages || []);

  // Anthropic uses separate 'system' field, OpenAI needs it as first message
  if (body.system) {
    messages.unshift({
      role: "system",
      content: body.system
    });
  }

  const azureBody = {
    messages,
    temperature: body.temperature ?? 0.3,  // Lower temperature for more deterministic, action-oriented behavior
    max_tokens: Math.min(body.max_tokens ?? 4096, 16384),  // Cap at Azure OpenAI's limit
    top_p: body.top_p ?? 1.0,
    stream: false,  // Force non-streaming for Azure OpenAI - streaming format conversion not yet implemented
    model: body._suggestionModeModel || config.azureOpenAI.deployment
  };

  // Add tools - inject standard tools if client didn't send any (passthrough mode)
  let toolsToSend = body.tools;
  let toolsInjected = false;

  if (!Array.isArray(toolsToSend) || toolsToSend.length === 0) {
    // Client didn't send tools (likely passthrough mode) - inject standard Claude Code tools
    toolsToSend = STANDARD_TOOLS;
    toolsInjected = true;
    logger.info({
      injectedToolCount: STANDARD_TOOLS.length,
      injectedToolNames: STANDARD_TOOLS.map(t => t.name),
      reason: "Client did not send tools (passthrough mode)"
    }, "=== INJECTING STANDARD TOOLS ===");
  }

  if (Array.isArray(toolsToSend) && toolsToSend.length > 0) {
    azureBody.tools = convertAnthropicToolsToOpenRouter(toolsToSend);
    azureBody.parallel_tool_calls = true;  // Enable parallel tool calling for better performance
    azureBody.tool_choice = "auto";  // Explicitly enable tool use (helps GPT models understand they should use tools)
    logger.info({
      toolCount: toolsToSend.length,
      toolNames: toolsToSend.map(t => t.name),
      toolsInjected,
      hasSystemMessage: !!body.system,
      messageCount: messages.length,
      temperature: azureBody.temperature,
      sampleTool: azureBody.tools[0] // Log first tool for inspection
    }, "=== SENDING TOOLS TO AZURE OPENAI ===");
  }

  logger.info({
    endpoint,
    hasTools: !!azureBody.tools,
    toolCount: azureBody.tools?.length || 0,
    temperature: azureBody.temperature,
    max_tokens: azureBody.max_tokens,
    tool_choice: azureBody.tool_choice
  }, "=== AZURE OPENAI REQUEST ===");

  if (format === "deployments" || format === "models") {
    return performJsonRequest(endpoint, { headers, body: azureBody }, "Azure OpenAI");
  }
  else if (format === "responses") {
    // Responses API uses 'input' instead of 'messages' and flat tool format
    // Convert tools from Chat Completions format to Responses API format
    const responsesTools = azureBody.tools?.map(tool => {
      if (tool.type === "function" && tool.function) {
        // Flatten: {type:"function", function:{name,description,parameters}} -> {type:"function", name, description, parameters}
        return {
          type: "function",
          name: tool.function.name,
          description: tool.function.description,
          parameters: tool.function.parameters
        };
      }
      return tool;
    });

    // Convert messages to Responses API input format
    // Responses API uses different structure for tool calls and results
    const responsesInput = [];
    // Track function call IDs for matching with outputs
    const pendingCallIds = [];

    for (const msg of azureBody.messages) {
      if (msg.role === "system") {
        // System messages become developer messages
        responsesInput.push({
          type: "message",
          role: "developer",
          content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)
        });
      } else if (msg.role === "user") {
        // Check if content contains tool_result blocks (Anthropic format)
        if (Array.isArray(msg.content)) {
          for (const block of msg.content) {
            if (block.type === "tool_result") {
              // Convert tool_result to function_call_output
              // Use tool_use_id if available, otherwise pop from pending call IDs
              const callId = block.tool_use_id || pendingCallIds.shift() || `call_${Date.now()}`;
              responsesInput.push({
                type: "function_call_output",
                call_id: callId,
                output: typeof block.content === 'string' ? block.content : JSON.stringify(block.content || "")
              });
            } else if (block.type === "text") {
              responsesInput.push({
                type: "message",
                role: "user",
                content: block.text || ""
              });
            }
          }
        } else {
          responsesInput.push({
            type: "message",
            role: "user",
            content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)
          });
        }
      } else if (msg.role === "assistant") {
        // Assistant messages - handle tool_calls (OpenAI format) and tool_use blocks (Anthropic format)
        if (msg.tool_calls && msg.tool_calls.length > 0) {
          // OpenAI format: tool_calls array
          for (const tc of msg.tool_calls) {
            const callId = tc.id || `call_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
            pendingCallIds.push(callId);
            responsesInput.push({
              type: "function_call",
              call_id: callId,
              name: tc.function?.name || tc.name,
              arguments: typeof tc.function?.arguments === 'string' ? tc.function.arguments : JSON.stringify(tc.function?.arguments || {})
            });
          }
        }
        // Handle content - could be string, array with tool_use blocks, or array with text blocks
        if (Array.isArray(msg.content)) {
          // Anthropic format: content is array of blocks
          for (const block of msg.content) {
            if (block.type === "tool_use") {
              const callId = block.id || `call_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
              pendingCallIds.push(callId);
              responsesInput.push({
                type: "function_call",
                call_id: callId,
                name: block.name,
                arguments: typeof block.input === 'string' ? block.input : JSON.stringify(block.input || {})
              });
            } else if (block.type === "text" && block.text) {
              responsesInput.push({
                type: "message",
                role: "assistant",
                content: block.text
              });
            }
          }
        } else if (msg.content) {
          // String content
          responsesInput.push({
            type: "message",
            role: "assistant",
            content: msg.content
          });
        }
      } else if (msg.role === "tool") {
        // Tool results become function_call_output
        // Use tool_call_id if available, otherwise pop from pending call IDs
        const callId = msg.tool_call_id || pendingCallIds.shift() || `call_${Date.now()}`;
        responsesInput.push({
          type: "function_call_output",
          call_id: callId,
          output: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)
        });
      }
    }

    const responsesBody = {
      input: responsesInput,
      model: azureBody.model,
      max_output_tokens: azureBody.max_tokens,
      tools: responsesTools,
      tool_choice: azureBody.tool_choice,
      stream: false
    };
    logger.info({
      format: "responses",
      inputCount: responsesBody.input?.length,
      model: responsesBody.model,
      hasTools: !!responsesBody.tools
    }, "Using Responses API format");

    const result = await performJsonRequest(endpoint, { headers, body: responsesBody }, "Azure OpenAI Responses");

    // Convert Responses API response to Chat Completions format
    if (result.ok && result.json?.output) {
      const outputArray = result.json.output || [];

      // Find message output (contains text content)
      const messageOutput = outputArray.find(o => o.type === "message");
      const textContent = messageOutput?.content?.find(c => c.type === "output_text")?.text || "";

      // Find function_call outputs (tool calls are separate items in output array)
      const toolCalls = outputArray
        .filter(o => o.type === "function_call")
        .map(tc => ({
          id: tc.call_id || tc.id || `call_${Date.now()}`,
          type: "function",
          function: {
            name: tc.name,
            arguments: typeof tc.arguments === 'string' ? tc.arguments : JSON.stringify(tc.arguments || {})
          }
        }));

      logger.info({
        outputTypes: outputArray.map(o => o.type),
        hasMessage: !!messageOutput,
        toolCallCount: toolCalls.length,
        toolCallNames: toolCalls.map(tc => tc.function.name)
      }, "Parsing Responses API output");

      // Convert to Chat Completions format
      result.json = {
        id: result.json.id,
        object: "chat.completion",
        created: result.json.created_at,
        model: result.json.model,
        choices: [{
          index: 0,
          message: {
            role: "assistant",
            content: textContent,
            tool_calls: toolCalls.length > 0 ? toolCalls : undefined
          },
          finish_reason: toolCalls.length > 0 ? "tool_calls" : "stop"
        }],
        usage: result.json.usage
      };

      logger.info({
        convertedContent: textContent?.substring(0, 100),
        hasToolCalls: toolCalls.length > 0,
        toolCallCount: toolCalls.length
      }, "Converted Responses API to Chat Completions format");

      // Now convert from Chat Completions format to Anthropic format
      const anthropicJson = convertOpenAIToAnthropic(result.json);
      logger.info({
        anthropicContentTypes: anthropicJson.content?.map(c => c.type),
        stopReason: anthropicJson.stop_reason
      }, "Converted to Anthropic format");

      return {
        ok: result.ok,
        status: result.status,
        json: anthropicJson,
        text: JSON.stringify(anthropicJson),
        contentType: "application/json",
        headers: result.headers,
      };
    }

    return result;
  }
  else {
    throw new Error(`Unsupported Azure OpenAI endpoint format: ${format}`);
  }
}

/**
 * Convert Azure Responses API response to Anthropic format
 */
function convertResponsesAPIToAnthropic(response, model) {
  const content = [];
  const outputArray = response.output || [];

  // Extract text content from message output
  const messageOutput = outputArray.find(o => o.type === "message");
  if (messageOutput?.content) {
    for (const item of messageOutput.content) {
      if (item.type === "output_text" && item.text) {
        content.push({ type: "text", text: item.text });
      }
    }
  }

  // Extract tool calls from function_call outputs
  const toolCalls = outputArray
    .filter(o => o.type === "function_call")
    .map(tc => ({
      type: "tool_use",
      id: tc.call_id || tc.id || `call_${Date.now()}`,
      name: tc.name,
      input: typeof tc.arguments === 'string' ? JSON.parse(tc.arguments || "{}") : (tc.arguments || {})
    }));

  content.push(...toolCalls);

  // Handle reasoning_content for thinking models
  if (content.length === 0 && response.reasoning_content) {
    content.push({ type: "text", text: response.reasoning_content });
  }

  // Ensure at least empty text if no content
  if (content.length === 0) {
    content.push({ type: "text", text: "" });
  }

  // Determine stop reason
  let stopReason = "end_turn";
  if (toolCalls.length > 0) {
    stopReason = "tool_use";
  } else if (response.status === "incomplete" && response.incomplete_details?.reason === "max_output_tokens") {
    stopReason = "max_tokens";
  }

  return {
    id: response.id || `msg_${Date.now()}`,
    type: "message",
    role: "assistant",
    content,
    model: model || response.model,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: response.usage?.input_tokens || 0,
      output_tokens: response.usage?.output_tokens || 0,
    }
  };
}

async function invokeOpenAI(body) {
  if (!config.openai?.apiKey) {
    throw new Error("OpenAI API key is not configured.");
  }

  const {
    convertAnthropicToolsToOpenRouter,
    convertAnthropicMessagesToOpenRouter
  } = require("./openrouter-utils");

  const endpoint = config.openai.endpoint || "https://api.openai.com/v1/chat/completions";
  const headers = {
    "Authorization": `Bearer ${config.openai.apiKey}`,
    "Content-Type": "application/json",
  };

  // Add organization header if configured
  if (config.openai.organization) {
    headers["OpenAI-Organization"] = config.openai.organization;
  }

  // Convert messages and handle system message
  const messages = convertAnthropicMessagesToOpenRouter(body.messages || []);

  // Anthropic uses separate 'system' field, OpenAI needs it as first message
  if (body.system) {
    messages.unshift({
      role: "system",
      content: body.system
    });
  }

  const openAIBody = {
    model: body._suggestionModeModel || config.openai.model || "gpt-4o",
    messages,
    temperature: body.temperature ?? 0.7,
    max_tokens: body.max_tokens ?? 4096,
    top_p: body.top_p ?? 1.0,
    stream: body.stream ?? false
  };

  // Add tools - inject standard tools if client didn't send any (passthrough mode)
  let toolsToSend = body.tools;
  let toolsInjected = false;

  if (!Array.isArray(toolsToSend) || toolsToSend.length === 0) {
    // Client didn't send tools (likely passthrough mode) - inject standard Claude Code tools
    toolsToSend = STANDARD_TOOLS;
    toolsInjected = true;
    logger.info({
      injectedToolCount: STANDARD_TOOLS.length,
      injectedToolNames: STANDARD_TOOLS.map(t => t.name),
      reason: "Client did not send tools (passthrough mode)"
    }, "=== INJECTING STANDARD TOOLS (OpenAI) ===");
  }

  if (Array.isArray(toolsToSend) && toolsToSend.length > 0) {
    openAIBody.tools = convertAnthropicToolsToOpenRouter(toolsToSend);
    openAIBody.parallel_tool_calls = true;  // Enable parallel tool calling
    openAIBody.tool_choice = "auto";  // Let the model decide when to use tools
    logger.info({
      toolCount: toolsToSend.length,
      toolNames: toolsToSend.map(t => t.name),
      toolsInjected
    }, "=== SENDING TOOLS TO OPENAI ===");
  }

  logger.info({
    endpoint,
    model: openAIBody.model,
    hasTools: !!openAIBody.tools,
    toolCount: openAIBody.tools?.length || 0,
    temperature: openAIBody.temperature,
    max_tokens: openAIBody.max_tokens,
  }, "=== OPENAI REQUEST ===");

  return performJsonRequest(endpoint, { headers, body: openAIBody }, "OpenAI");
}

async function invokeLlamaCpp(body) {
  if (!config.llamacpp?.endpoint) {
    throw new Error("llama.cpp endpoint is not configured.");
  }

  const {
    convertAnthropicToolsToOpenRouter,
    convertAnthropicMessagesToOpenRouter
  } = require("./openrouter-utils");

  const endpoint = `${config.llamacpp.endpoint}/v1/chat/completions`;
  const headers = {
    "Content-Type": "application/json",
  };

  // Add API key if configured (for secured llama.cpp servers)
  if (config.llamacpp.apiKey) {
    headers["Authorization"] = `Bearer ${config.llamacpp.apiKey}`;
  }

  // Convert messages to OpenAI format
  const messages = convertAnthropicMessagesToOpenRouter(body.messages || []);

  // Handle system message
  if (body.system) {
    messages.unshift({ role: "system", content: body.system });
  }

  // FIX: Deduplicate consecutive messages with same role (llama.cpp rejects this)
  const deduplicated = [];
  let lastRole = null;
  for (const msg of messages) {
    if (msg.role === lastRole) {
      logger.debug({
        skippedRole: msg.role,
        contentPreview: typeof msg.content === 'string'
          ? msg.content.substring(0, 50)
          : JSON.stringify(msg.content).substring(0, 50)
      }, 'llama.cpp: Skipping duplicate consecutive message with same role');
      continue;
    }
    deduplicated.push(msg);
    lastRole = msg.role;
  }

  if (deduplicated.length !== messages.length) {
    logger.info({
      originalCount: messages.length,
      deduplicatedCount: deduplicated.length,
      removed: messages.length - deduplicated.length,
      messageRoles: messages.map(m => m.role).join(' → '),
      deduplicatedRoles: deduplicated.map(m => m.role).join(' → ')
    }, 'llama.cpp: Removed consecutive duplicate roles from message sequence');
  }

  const llamacppBody = {
    messages: deduplicated,
    temperature: body.temperature ?? 0.7,
    max_tokens: body.max_tokens ?? 4096,
    top_p: body.top_p ?? 1.0,
    stream: body.stream ?? false
  };

  // Inject standard tools if client didn't send any
  let toolsToSend = body.tools;
  let toolsInjected = false;

  const injectToolsLlamacpp = process.env.INJECT_TOOLS_LLAMACPP !== "false";
  if (injectToolsLlamacpp && (!Array.isArray(toolsToSend) || toolsToSend.length === 0)) {
    toolsToSend = STANDARD_TOOLS;
    toolsInjected = true;
    logger.info({
      injectedToolCount: STANDARD_TOOLS.length,
      injectedToolNames: STANDARD_TOOLS.map(t => t.name),
      reason: "Client did not send tools (passthrough mode)"
    }, "=== INJECTING STANDARD TOOLS (llama.cpp) ===");
  } else if (!injectToolsLlamacpp) {
    logger.info({}, "Tool injection disabled for llama.cpp (INJECT_TOOLS_LLAMACPP=false)");
  }

  if (Array.isArray(toolsToSend) && toolsToSend.length > 0) {
    llamacppBody.tools = convertAnthropicToolsToOpenRouter(toolsToSend);
    llamacppBody.tool_choice = "auto";
    logger.info({
      toolCount: toolsToSend.length,
      toolNames: toolsToSend.map(t => t.name),
      toolsInjected
    }, "=== SENDING TOOLS TO LLAMA.CPP ===");
  }

  logger.info({
    endpoint,
    hasTools: !!llamacppBody.tools,
    toolCount: llamacppBody.tools?.length || 0,
    temperature: llamacppBody.temperature,
    max_tokens: llamacppBody.max_tokens,
    messageCount: llamacppBody.messages?.length || 0,
    messageRoles: llamacppBody.messages?.map(m => m.role).join(' → '),
    messages: llamacppBody.messages?.map((m, i) => ({
      index: i,
      role: m.role,
      hasContent: !!m.content,
      contentPreview: typeof m.content === 'string' ? m.content.substring(0, 100) : JSON.stringify(m.content).substring(0, 100),
      hasToolCalls: !!m.tool_calls,
      toolCallCount: m.tool_calls?.length || 0,
    }))
  }, "=== LLAMA.CPP REQUEST ===");

  return performJsonRequest(endpoint, { headers, body: llamacppBody }, "llama.cpp");
}

async function invokeLMStudio(body) {
  if (!config.lmstudio?.endpoint) {
    throw new Error("LM Studio endpoint is not configured.");
  }

  const {
    convertAnthropicToolsToOpenRouter,
    convertAnthropicMessagesToOpenRouter
  } = require("./openrouter-utils");

  const endpoint = `${config.lmstudio.endpoint}/v1/chat/completions`;
  const headers = {
    "Content-Type": "application/json",
  };

  // Add API key if configured (for secured LM Studio servers)
  if (config.lmstudio.apiKey) {
    headers["Authorization"] = `Bearer ${config.lmstudio.apiKey}`;
  }

  // Convert messages to OpenAI format
  const messages = convertAnthropicMessagesToOpenRouter(body.messages || []);

  // Handle system message
  if (body.system) {
    messages.unshift({ role: "system", content: body.system });
  }

  const lmstudioBody = {
    messages,
    temperature: body.temperature ?? 0.7,
    max_tokens: body.max_tokens ?? 4096,
    top_p: body.top_p ?? 1.0,
    stream: body.stream ?? false
  };

  // Inject standard tools if client didn't send any
  let toolsToSend = body.tools;
  let toolsInjected = false;

  if (!Array.isArray(toolsToSend) || toolsToSend.length === 0) {
    toolsToSend = STANDARD_TOOLS;
    toolsInjected = true;
    logger.info({
      injectedToolCount: STANDARD_TOOLS.length,
      injectedToolNames: STANDARD_TOOLS.map(t => t.name),
      reason: "Client did not send tools (passthrough mode)"
    }, "=== INJECTING STANDARD TOOLS (LM Studio) ===");
  }

  if (Array.isArray(toolsToSend) && toolsToSend.length > 0) {
    lmstudioBody.tools = convertAnthropicToolsToOpenRouter(toolsToSend);
    lmstudioBody.tool_choice = "auto";
    logger.info({
      toolCount: toolsToSend.length,
      toolNames: toolsToSend.map(t => t.name),
      toolsInjected
    }, "=== SENDING TOOLS TO LM STUDIO ===");
  }

  logger.info({
    endpoint,
    hasTools: !!lmstudioBody.tools,
    toolCount: lmstudioBody.tools?.length || 0,
    temperature: lmstudioBody.temperature,
    max_tokens: lmstudioBody.max_tokens,
  }, "=== LM STUDIO REQUEST ===");

  return performJsonRequest(endpoint, { headers, body: lmstudioBody }, "LM Studio");
}

async function invokeBedrock(body) {
  // 1. Validate Bearer token
  if (!config.bedrock?.apiKey) {
    throw new Error(
      "AWS Bedrock requires AWS_BEDROCK_API_KEY (Bearer token). " +
      "Generate from AWS Console → Bedrock → API Keys, then set AWS_BEDROCK_API_KEY in your .env file."
    );
  }

  const bearerToken = config.bedrock.apiKey;
  logger.info({ authMethod: "Bearer Token" }, "=== BEDROCK AUTH ===");

  // 2. Inject standard tools if needed
  let toolsToSend = body.tools;
  let toolsInjected = false;

  if (!Array.isArray(toolsToSend) || toolsToSend.length === 0) {
    toolsToSend = STANDARD_TOOLS;
    toolsInjected = true;
    logger.info({
      injectedToolCount: STANDARD_TOOLS.length,
      injectedToolNames: STANDARD_TOOLS.map(t => t.name),
      reason: "Client did not send tools (passthrough mode)"
    }, "=== INJECTING STANDARD TOOLS (Bedrock) ===");
  }

  const bedrockBody = { ...body, tools: toolsToSend };

  // 4. Detect model family and convert format
  const modelId = config.bedrock.modelId;
  const modelFamily = detectModelFamily(modelId);

  logger.info({
    modelId,
    modelFamily,
    hasTools: !!bedrockBody.tools,
    toolCount: bedrockBody.tools?.length || 0,
    streaming: body.stream || false,
  }, "=== BEDROCK REQUEST (FETCH) ===");

  // 5. Convert to Bedrock Converse API format (simpler, more universal)
  // Bedrock Converse API only allows 'user' and 'assistant' roles in messages array

  // Extract system messages from messages array (if any)
  const systemMessages = bedrockBody.messages.filter(msg => msg.role === 'system');

  const converseBody = {
    messages: bedrockBody.messages
      .filter(msg => msg.role !== 'system') // Filter out system messages
      .map(msg => ({
        role: msg.role,
        content: Array.isArray(msg.content)
          ? msg.content.map(c => ({ text: c.text || c.content || "" }))
          : [{ text: msg.content }]
      }))
  };

  // Add system prompt (from Anthropic system field OR extracted from messages)
  if (bedrockBody.system) {
    converseBody.system = [{ text: bedrockBody.system }];
  } else if (systemMessages.length > 0) {
    // If system messages were in the messages array, use the first one
    const systemContent = Array.isArray(systemMessages[0].content)
      ? systemMessages[0].content.map(c => c.text || c.content || "").join("\n")
      : systemMessages[0].content;
    converseBody.system = [{ text: systemContent }];
  }

  // Add inference config
  if (bedrockBody.max_tokens) {
    converseBody.inferenceConfig = {
      maxTokens: bedrockBody.max_tokens,
      temperature: bedrockBody.temperature,
      topP: bedrockBody.top_p,
    };
  }

  // Add tools if present
  if (bedrockBody.tools && bedrockBody.tools.length > 0) {
    converseBody.toolConfig = {
      tools: bedrockBody.tools.map(tool => ({
        toolSpec: {
          name: tool.name,
          description: tool.description,
          inputSchema: {
            json: tool.input_schema
          }
        }
      }))
    };
  }

  // 6. Construct Bedrock Converse API endpoint
  const path = `/model/${modelId}/converse`;
  const host = `bedrock-runtime.${config.bedrock.region}.amazonaws.com`;
  const endpoint = `https://${host}${path}`;

  logger.info({
    endpoint,
    authMethod: "Bearer Token",
    hasSystem: !!converseBody.system,
    hasTools: !!converseBody.toolConfig,
    messageCount: converseBody.messages.length
  }, "=== BEDROCK CONVERSE API REQUEST ===");

  // 7. Prepare request headers with Bearer token
  const requestHeaders = {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${bearerToken}`
  };

  // 8. Make the Converse API request
  try {
    const response = await performJsonRequest(endpoint, {
      headers: requestHeaders,
      body: converseBody  // Pass object, performJsonRequest will stringify it
    }, "Bedrock");  // Add provider label for logging

    if (!response.ok) {
      const errorText = response.text;  // Use property, not method
      logger.error({
        status: response.status,
        error: errorText
      }, "=== BEDROCK CONVERSE API ERROR ===");
      throw new Error(`Bedrock Converse API failed: ${response.status} ${errorText}`);
    }

    // Parse Converse API response (already parsed by performJsonRequest)
    const converseResponse = response.json;  // Use property, not method

    logger.info({
      stopReason: converseResponse.stopReason,
      inputTokens: converseResponse.usage?.inputTokens || 0,
      outputTokens: converseResponse.usage?.outputTokens || 0,
      hasToolUse: !!converseResponse.output?.message?.content?.some(c => c.toolUse)
    }, "=== BEDROCK CONVERSE API RESPONSE ===");

    // Convert Converse API response to Anthropic format
    const message = converseResponse.output.message;
    const anthropicResponse = {
      id: `bedrock-${Date.now()}`,
      type: "message",
      role: message.role,
      model: modelId,
      content: message.content.map(item => {
        if (item.text) {
          return { type: "text", text: item.text };
        } else if (item.toolUse) {
          return {
            type: "tool_use",
            id: item.toolUse.toolUseId,
            name: item.toolUse.name,
            input: item.toolUse.input
          };
        }
        return item;
      }),
      stop_reason: converseResponse.stopReason === "end_turn" ? "end_turn" :
                   converseResponse.stopReason === "tool_use" ? "tool_use" :
                   converseResponse.stopReason === "max_tokens" ? "max_tokens" : "end_turn",
      usage: {
        input_tokens: converseResponse.usage?.inputTokens || 0,
        output_tokens: converseResponse.usage?.outputTokens || 0,
      },
    };

    return {
      ok: true,
      status: 200,
      json: anthropicResponse,
      actualProvider: "bedrock",
      modelFamily,
    };
  } catch (e) {
    logger.error({
      error: e.message,
      modelId,
      region: config.bedrock.region,
      endpoint,
      stack: e.stack
    }, "=== BEDROCK CONVERSE API ERROR ===");
    throw e;
  }
}

/**
 * Z.AI (Zhipu) Provider
 *
 * Z.AI offers GLM models through an Anthropic-compatible API at ~1/7 the cost.
 * Minimal transformation needed - mostly passthrough with model mapping.
 */
async function invokeZai(body, providerOptions = {}) {
  const providerConfig = providerOptions.config || config.zai || {};
  const providerName = providerOptions.providerName || "Z.AI";
  const defaultEndpoint = providerOptions.defaultEndpoint || "https://api.z.ai/api/anthropic/v1/messages";
  const defaultModel = providerOptions.defaultModel || "glm-4.7";

  if (!providerConfig.apiKey) {
    throw new Error(`${providerName} API key is not configured.`);
  }

  const endpoint = providerConfig.endpoint || defaultEndpoint;
  const isOpenAIFormat = endpoint.includes("/chat/completions");

  // Model mapping: Anthropic names → Z.AI names (lowercase)
  const modelMap = providerOptions.modelMap || {
    "claude-sonnet-4-5-20250929": "glm-4.7",
    "claude-sonnet-4-5": "glm-4.7",
    "claude-sonnet-4.5": "glm-4.7",
    "claude-3-5-sonnet": "glm-4.7",
    "claude-haiku-4-5-20251001": "glm-4.5-air",
    "claude-haiku-4-5": "glm-4.5-air",
    "claude-3-haiku": "glm-4.5-air",
  };

  const requestedModel = body.model || providerConfig.model;
  // If operator explicitly sets provider model, honor it over Claude-name mapping.
  let mappedModel = providerConfig.model || modelMap[requestedModel] || defaultModel;
  mappedModel = mappedModel.toLowerCase();

  let zaiBody;
  let headers;

  if (isOpenAIFormat) {
    const {
      convertAnthropicToolsToOpenRouter,
      convertAnthropicMessagesToOpenRouter
    } = require("./openrouter-utils");

    // Convert messages using existing utility
    let messages = convertAnthropicMessagesToOpenRouter(body.messages || []);

    // Extract system content from body.system OR from system messages in the array
    let systemContent = "";
    if (body.system) {
      systemContent = Array.isArray(body.system)
        ? body.system.map(s => s.text || s).join("\n")
        : body.system;
    }

    // Filter out any system role messages (Z.AI doesn't support system role)
    // and collect their content
    const filteredMessages = [];
    for (const msg of messages) {
      if (msg.role === "system") {
        // Append system message content to systemContent
        if (msg.content) {
          systemContent = systemContent ? `${systemContent}\n${msg.content}` : msg.content;
        }
      } else {
        filteredMessages.push(msg);
      }
    }
    messages = filteredMessages;

    // Prepend system content to first user message ONLY if no tools
    // When tools are present, system instructions can confuse tool calling
    const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
    if (systemContent && messages.length > 0 && !hasTools) {
      const firstUserIdx = messages.findIndex(m => m.role === "user");
      if (firstUserIdx >= 0) {
        const firstUser = messages[firstUserIdx];
        firstUser.content = `[System Instructions]\n${systemContent}\n\n[User Message]\n${firstUser.content}`;
      } else {
        // No user message, add system as user message
        messages.unshift({ role: "user", content: systemContent });
      }
    } else if (systemContent && !hasTools) {
      // No messages at all, add system as user
      messages.push({ role: "user", content: systemContent });
    }

    // Convert tools if present
    let tools = undefined;
    if (Array.isArray(body.tools) && body.tools.length > 0) {
      tools = convertAnthropicToolsToOpenRouter(body.tools);
    }

    zaiBody = {
      model: mappedModel,
      messages,
      max_tokens: body.max_tokens || 4096,
      temperature: body.temperature ?? 0.7,
      stream: body.stream,
    };

    // Only add tools if present
    if (tools && tools.length > 0) {
      zaiBody.tools = tools;
      // Use "auto" to let the model decide when to use tools
      // "required" was forcing tools even for simple greetings
      zaiBody.tool_choice = "auto";
      // Also enable parallel tool calls
      zaiBody.parallel_tool_calls = true;
    }

    headers = {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${providerConfig.apiKey}`,
    };
  } else {
    // Anthropic format endpoint
    zaiBody = { ...body };
    zaiBody.model = mappedModel;

    const hasToolHistory = Array.isArray(zaiBody.messages)
      && zaiBody.messages.some((message) => {
        if (!message || !Array.isArray(message.content)) return false;
        return message.content.some((block) => (
          block?.type === "tool_use"
          || block?.type === "tool_result"
          || block?.type === "tool_reference"
        ));
      });

    // Inject standard tools if client didn't send any (passthrough mode)
    // IMPORTANT: do not inject on tool-followup turns, because the model
    // must continue against the exact previously-declared tool schema.
    if ((!Array.isArray(zaiBody.tools) || zaiBody.tools.length === 0) && !hasToolHistory) {
      zaiBody.tools = STANDARD_TOOLS;
      logger.info({
        injectedToolCount: STANDARD_TOOLS.length,
        injectedToolNames: STANDARD_TOOLS.map(t => t.name),
        reason: "Client did not send tools (passthrough mode)"
      }, `=== INJECTING STANDARD TOOLS (${providerName} Anthropic) ===`);
    } else if ((!Array.isArray(zaiBody.tools) || zaiBody.tools.length === 0) && hasToolHistory) {
      logger.info({
        reason: "Skipped tool injection on tool-followup turn",
      }, `=== TOOL INJECTION SKIPPED (${providerName} Anthropic) ===`);
    }

    headers = {
      "Content-Type": "application/json",
      "x-api-key": providerConfig.apiKey,
      "anthropic-version": "2023-06-01",
    };
  }

  logger.info({
    endpoint,
    format: isOpenAIFormat ? "openai" : "anthropic",
    model: zaiBody.model,
    originalModel: requestedModel,
    messageCount: zaiBody.messages?.length || 0,
    firstMessageRole: zaiBody.messages?.[0]?.role,
    firstMessageContent: typeof zaiBody.messages?.[0]?.content === 'string'
      ? zaiBody.messages[0].content.substring(0, 200)
      : JSON.stringify(zaiBody.messages?.[0]?.content)?.substring(0, 200),
    hasTools: !!zaiBody.tools,
    toolCount: zaiBody.tools?.length || 0,
    toolNames: zaiBody.tools?.map(t => t.function?.name || t.name),
    toolChoice: zaiBody.tool_choice,
    fullRequest: JSON.stringify(zaiBody).substring(0, 500),
  }, `=== ${providerName} REQUEST ===`);

  logger.debug({
    zaiBody: JSON.stringify(zaiBody).substring(0, 1000),
  }, `${providerName} request body (truncated)`);

  // Use semaphore to limit concurrent requests (prevents rate limiting)
  return zaiSemaphore.run(async () => {
    logger.debug({
      queueLength: zaiSemaphore.queue.length,
      currentConcurrent: zaiSemaphore.current,
    }, `${providerName} semaphore status`);

    const response = await performJsonRequest(endpoint, { headers, body: zaiBody }, providerName);

    logger.info({
      responseOk: response?.ok,
      responseStatus: response?.status,
      hasJson: !!response?.json,
      rawContent: response?.json?.choices?.[0]?.message?.content,
      hasReasoning: !!response?.json?.choices?.[0]?.message?.reasoning_content,
      isOpenAIFormat,
    }, `=== ${providerName} RAW RESPONSE ===`);

    // Convert OpenAI response back to Anthropic format if needed
    if (isOpenAIFormat && response?.ok && response?.json) {
      const anthropicJson = convertOpenAIToAnthropic(response.json);
      logger.info({
        convertedContent: JSON.stringify(anthropicJson.content).substring(0, 200),
      }, `=== ${providerName} CONVERTED RESPONSE ===`);
      // Return in the same format as other providers (with ok, status, json)
      return {
        ok: response.ok,
        status: response.status,
        json: anthropicJson,
        text: JSON.stringify(anthropicJson),
        contentType: "application/json",
        headers: response.headers,
      };
    }

    return response;
  });
}

async function invokeMoonshot(body) {
  const moonshotModelMap = {
    "claude-sonnet-4-5-20250929": "kimi-k2.5",
    "claude-sonnet-4-5": "kimi-k2.5",
    "claude-sonnet-4.5": "kimi-k2.5",
    "claude-3-5-sonnet": "kimi-k2.5",
    "claude-haiku-4-5-20251001": "kimi-k2.5",
    "claude-haiku-4-5": "kimi-k2.5",
    "claude-3-haiku": "kimi-k2.5",
  };

  return invokeZai(body, {
    providerName: "Moonshot",
    config: config.moonshot,
    defaultEndpoint: "https://api.moonshot.ai/anthropic/v1/messages",
    defaultModel: "kimi-k2.5",
    modelMap: moonshotModelMap,
  });
}



/**
 * Convert OpenAI response to Anthropic format
 */
function convertOpenAIToAnthropic(response) {
  if (!response.choices || !response.choices[0]) {
    return response; // Return as-is if unexpected format
  }

  const choice = response.choices[0];
  const message = choice.message || {};
  const content = [];

  // Add text content from message.content
  // Don't add placeholder text if there are tool_calls - tools are the actual response
  const hasToolCalls = Array.isArray(message.tool_calls) && message.tool_calls.length > 0;
  if (message.content) {
    content.push({ type: "text", text: message.content });
  } else if (message.reasoning_content && !message.content) {
    // Thinking models (Kimi-K2, o1, etc.) return response in reasoning_content
    content.push({ type: "text", text: message.reasoning_content });
  }

  // Convert tool calls
  if (Array.isArray(message.tool_calls)) {
    for (const toolCall of message.tool_calls) {
      content.push({
        type: "tool_use",
        id: toolCall.id,
        name: toolCall.function?.name,
        input: JSON.parse(toolCall.function?.arguments || "{}")
      });
    }
  }

  // Ensure there's at least some content
  if (content.length === 0) {
    content.push({ type: "text", text: "" });
  }

  // Determine stop reason
  let stopReason = "end_turn";
  if (choice.finish_reason === "tool_calls") {
    stopReason = "tool_use";
  } else if (choice.finish_reason === "length") {
    stopReason = "max_tokens";
  } else if (choice.finish_reason === "stop") {
    stopReason = "end_turn";
  }

  return {
    id: response.id || `msg_${Date.now()}`,
    type: "message",
    role: "assistant",
    content,
    model: response.model,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: response.usage?.prompt_tokens || 0,
      output_tokens: response.usage?.completion_tokens || 0,
    }
  };
}

/**
 * Sanitize JSON schema for Gemini API
 * Gemini doesn't support certain JSON Schema properties like additionalProperties
 */
function sanitizeSchemaForGemini(schema) {
  if (!schema || typeof schema !== 'object') {
    return schema;
  }

  const sanitized = { ...schema };

  // Remove unsupported properties
  delete sanitized.additionalProperties;
  delete sanitized.$schema;
  delete sanitized.definitions;
  delete sanitized.$ref;

  // Recursively sanitize nested properties
  if (sanitized.properties && typeof sanitized.properties === 'object') {
    const cleanProps = {};
    for (const [key, value] of Object.entries(sanitized.properties)) {
      cleanProps[key] = sanitizeSchemaForGemini(value);
    }
    sanitized.properties = cleanProps;
  }

  // Sanitize items in arrays
  if (sanitized.items) {
    sanitized.items = sanitizeSchemaForGemini(sanitized.items);
  }

  // Sanitize anyOf, oneOf, allOf
  for (const key of ['anyOf', 'oneOf', 'allOf']) {
    if (Array.isArray(sanitized[key])) {
      sanitized[key] = sanitized[key].map(item => sanitizeSchemaForGemini(item));
    }
  }

  return sanitized;
}

/**
 * Vertex AI (Google Cloud) Provider - Gemini Models
 *
 * Supports Google Gemini models through Vertex AI.
 * Converts Anthropic format to Gemini format and back.
 */
async function invokeVertex(body) {
  const apiKey = config.vertex?.apiKey;

  if (!apiKey) {
    throw new Error(
      "Vertex AI API key is not configured. Set VERTEX_API_KEY in your .env file."
    );
  }

  // Model mapping: Anthropic names → Gemini models
  const modelMap = {
    "claude-sonnet-4-5-20250929": "gemini-2.0-flash",
    "claude-sonnet-4-5": "gemini-2.0-flash",
    "claude-sonnet-4.5": "gemini-2.0-flash",
    "claude-3-5-sonnet": "gemini-2.0-flash",
    "claude-haiku-4-5-20251001": "gemini-2.0-flash-lite",
    "claude-haiku-4-5": "gemini-2.0-flash-lite",
    "claude-opus-4-5": "gemini-2.5-pro",
  };

  // Map model name
  const requestedModel = body.model || config.vertex.model;
  const geminiModel = modelMap[requestedModel] || config.vertex.model || "gemini-2.0-flash";

  // Construct Gemini API endpoint
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent?key=${apiKey}`;

  // Convert Anthropic messages to Gemini format
  const contents = convertAnthropicToGemini(body.messages || [], body.system);

  // Convert tools to Gemini format
  let tools = undefined;
  if (Array.isArray(body.tools) && body.tools.length > 0) {
    tools = [{
      functionDeclarations: body.tools.map(tool => ({
        name: tool.name,
        description: tool.description || "",
        parameters: sanitizeSchemaForGemini(tool.input_schema || { type: "object", properties: {} })
      }))
    }];
  }

  // Build Gemini request body
  const geminiBody = {
    contents,
    generationConfig: {
      temperature: body.temperature ?? 0.7,
      maxOutputTokens: body.max_tokens || 4096,
      topP: body.top_p ?? 1.0,
    }
  };

  // Add tools if present
  if (tools) {
    geminiBody.tools = tools;
    // Tell Gemini to use AUTO function calling mode
    geminiBody.toolConfig = {
      functionCallingConfig: {
        mode: "AUTO"
      }
    };
  }

  const headers = {
    "Content-Type": "application/json",
  };

  logger.info({
    endpoint: endpoint.replace(apiKey, "***"),
    model: geminiModel,
    originalModel: requestedModel,
    hasTools: !!tools,
    toolCount: body.tools?.length || 0,
    contentCount: contents.length,
  }, "=== VERTEX AI (GEMINI) REQUEST ===");

  const response = await performJsonRequest(endpoint, { headers, body: geminiBody }, "Vertex AI");

  // Log error details if request failed
  if (!response?.ok) {
    logger.error({
      status: response?.status,
      error: response?.json?.error || response?.text?.substring(0, 500),
      model: geminiModel,
    }, "=== VERTEX AI (GEMINI) ERROR ===");

    // Throw error to trigger circuit breaker correctly
    const errorMessage = response?.json?.error?.message || response?.text || `Gemini API error: ${response?.status}`;
    const err = new Error(errorMessage);
    err.status = response?.status;
    throw err;
  }

  // Convert Gemini response to Anthropic format
  if (response?.json) {
    const anthropicJson = convertGeminiToAnthropic(response.json, requestedModel);
    logger.info({
      convertedContent: JSON.stringify(anthropicJson.content).substring(0, 200),
    }, "=== VERTEX AI (GEMINI) CONVERTED RESPONSE ===");
    return {
      ok: response.ok,
      status: response.status,
      json: anthropicJson,
      text: JSON.stringify(anthropicJson),
      contentType: "application/json",
      headers: response.headers,
    };
  }

  return response;
}

/**
 * Convert Anthropic messages to Gemini format
 */
function convertAnthropicToGemini(messages, system) {
  const contents = [];

  // Add system as first user message if present
  // Also add Gemini-specific tool usage instructions
  const geminiToolInstructions = `
IMPORTANT TOOL USAGE RULES:
- To create or write files, use the Write tool with file_path and content parameters. Do NOT use Bash echo.
- To read files, use the Read tool. Do NOT use Bash cat.
- To search for files, use the Glob tool. Do NOT use Bash find.
- To search file contents, use the Grep tool. Do NOT use Bash grep.
- Always use the specific tool designed for the task.
- When you want to call a tool, use the function calling mechanism, not text output.
`;

  if (system) {
    const systemText = Array.isArray(system)
      ? system.map(s => s.text || s).join("\n")
      : system;
    contents.push({
      role: "user",
      parts: [{ text: `[System Instructions]\n${systemText}\n\n${geminiToolInstructions}` }]
    });
    contents.push({
      role: "model",
      parts: [{ text: "I understand. I will follow these instructions and use the proper tools." }]
    });
  } else {
    // Even without system, add tool instructions
    contents.push({
      role: "user",
      parts: [{ text: `[System Instructions]\n${geminiToolInstructions}` }]
    });
    contents.push({
      role: "model",
      parts: [{ text: "I understand. I will use the proper tools." }]
    });
  }

  for (const msg of messages) {
    // Map roles: user → user, assistant → model
    const role = msg.role === "assistant" ? "model" : "user";
    const parts = [];

    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === "text") {
          parts.push({ text: block.text });
        } else if (block.type === "tool_use") {
          // Assistant's tool call
          parts.push({
            functionCall: {
              name: block.name,
              args: block.input || {}
            }
          });
        } else if (block.type === "tool_result") {
          // Tool result - add as function response
          parts.push({
            functionResponse: {
              name: block.tool_use_id || "unknown",
              response: {
                result: typeof block.content === "string" ? block.content : JSON.stringify(block.content)
              }
            }
          });
        }
      }
    } else if (typeof msg.content === "string") {
      parts.push({ text: msg.content });
    }

    if (parts.length > 0) {
      contents.push({ role, parts });
    }
  }

  return contents;
}

/**
 * Convert Gemini response to Anthropic format
 */
function convertGeminiToAnthropic(response, requestedModel) {
  const candidate = response.candidates?.[0];
  if (!candidate) {
    return {
      id: `msg_${Date.now()}`,
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "" }],
      model: requestedModel,
      stop_reason: "end_turn",
      usage: { input_tokens: 0, output_tokens: 0 }
    };
  }

  const content = [];
  const parts = candidate.content?.parts || [];

  for (const part of parts) {
    if (part.text) {
      content.push({ type: "text", text: part.text });
    } else if (part.functionCall) {
      content.push({
        type: "tool_use",
        id: `toolu_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        name: part.functionCall.name,
        input: part.functionCall.args || {}
      });
    }
  }

  // Ensure at least empty text if no content
  if (content.length === 0) {
    content.push({ type: "text", text: "" });
  }

  // Determine stop reason
  let stopReason = "end_turn";
  if (content.some(c => c.type === "tool_use")) {
    stopReason = "tool_use";
  } else if (candidate.finishReason === "MAX_TOKENS") {
    stopReason = "max_tokens";
  }

  return {
    id: `msg_${Date.now()}`,
    type: "message",
    role: "assistant",
    content,
    model: requestedModel,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: response.usageMetadata?.promptTokenCount || 0,
      output_tokens: response.usageMetadata?.candidatesTokenCount || 0,
    }
  };
}

async function invokeModel(body, options = {}) {
  const { determineProvider, isFallbackEnabled, getFallbackProvider, analyzeComplexity } = require("./routing");
  const metricsCollector = getMetricsCollector();
  const registry = getCircuitBreakerRegistry();
  const healthTracker = getHealthTracker();

  // Analyze complexity and determine provider
  const complexityAnalysis = analyzeComplexity(body);
  const initialProvider = options.forceProvider ?? determineProvider(body);
  const preferOllama = config.modelProvider?.preferOllama ?? false;

  // Build routing decision object for response headers
  const routingDecision = {
    provider: initialProvider,
    score: complexityAnalysis.score,
    threshold: complexityAnalysis.threshold,
    mode: complexityAnalysis.mode,
    recommendation: complexityAnalysis.recommendation,
    method: complexityAnalysis.score !== undefined ? 'complexity' : 'static',
    taskType: complexityAnalysis.breakdown?.taskType?.reason,
  };

  logger.debug({
    initialProvider,
    preferOllama,
    fallbackEnabled: isFallbackEnabled(),
    toolCount: Array.isArray(body?.tools) ? body.tools.length : 0,
    complexityScore: complexityAnalysis.score,
    complexityThreshold: complexityAnalysis.threshold,
    recommendation: complexityAnalysis.recommendation,
  }, "Provider routing decision");

  metricsCollector.recordProviderRouting(initialProvider);

  // Get circuit breaker for initial provider
  const breaker = registry.get(initialProvider, {
    failureThreshold: 5,
    successThreshold: 2,
    timeout: 60000,
  });

  let retries = 0;
  const startTime = Date.now();

  // Record request start for health tracking
  healthTracker.recordRequestStart(initialProvider);

  try {
    // Try initial provider with circuit breaker
    const result = await breaker.execute(async () => {
      if (initialProvider === "azure-openai") {
        return await invokeAzureOpenAI(body);
      } else if (initialProvider === "azure-anthropic") {
        return await invokeAzureAnthropic(body);
      } else if (initialProvider === "ollama") {
        return await invokeOllama(body);
      } else if (initialProvider === "openrouter") {
        return await invokeOpenRouter(body);
      } else if (initialProvider === "openai") {
        return await invokeOpenAI(body);
      } else if (initialProvider === "llamacpp") {
        return await invokeLlamaCpp(body);
      } else if (initialProvider === "lmstudio") {
        return await invokeLMStudio(body);
      } else if (initialProvider === "bedrock") {
        return await invokeBedrock(body);
      } else if (initialProvider === "zai") {
        return await invokeZai(body);
      } else if (initialProvider === "moonshot") {
        return await invokeMoonshot(body);
      } else if (initialProvider === "vertex") {
        return await invokeVertex(body);
      }
      return await invokeDatabricks(body);
    });

    // Record success metrics
    const latency = Date.now() - startTime;
    metricsCollector.recordProviderSuccess(initialProvider, latency);
    metricsCollector.recordDatabricksRequest(true, retries);
    healthTracker.recordSuccess(initialProvider, latency);

    // Record tokens and cost savings
    if (result.json?.usage) {
      const inputTokens = result.json.usage.input_tokens || result.json.usage.prompt_tokens || 0;
      const outputTokens = result.json.usage.output_tokens || result.json.usage.completion_tokens || 0;
      metricsCollector.recordTokens(inputTokens, outputTokens);

      // Estimate cost savings if Ollama was used
      if (initialProvider === "ollama") {
        const savings = estimateCostSavings(inputTokens, outputTokens);
        metricsCollector.recordCostSavings(savings);
      }
    }

    // Return result with provider info and routing decision for headers
    return {
      ...result,
      actualProvider: initialProvider,
      routingDecision,
    };

  } catch (err) {
    // Record failure
    metricsCollector.recordProviderFailure(initialProvider);
    healthTracker.recordFailure(initialProvider, err, err.status);

    // Check if we should fallback
    const shouldFallback =
      preferOllama &&
      initialProvider === "ollama" &&
      isFallbackEnabled() &&
      !options.disableFallback;

    if (!shouldFallback) {
      metricsCollector.recordDatabricksRequest(false, retries);
      throw err;
    }

    // Determine failure reason
    const reason = categorizeFailure(err);
    const fallbackProvider = getFallbackProvider();

    logger.info({
      originalProvider: initialProvider,
      fallbackProvider,
      reason,
      error: err.message,
    }, "Ollama failed, attempting transparent fallback to cloud");

    metricsCollector.recordFallbackAttempt(initialProvider, fallbackProvider, reason);

    // Record fallback request start for health tracking
    healthTracker.recordRequestStart(fallbackProvider);

    try {
      // Get circuit breaker for fallback provider
      const fallbackBreaker = registry.get(fallbackProvider, {
        failureThreshold: 5,
        successThreshold: 2,
        timeout: 60000,
      });

      const fallbackStart = Date.now();

      // Execute fallback
      const fallbackResult = await fallbackBreaker.execute(async () => {
        if (fallbackProvider === "azure-openai") {
          return await invokeAzureOpenAI(body);
        } else if (fallbackProvider === "azure-anthropic") {
          return await invokeAzureAnthropic(body);
        } else if (fallbackProvider === "openrouter") {
          return await invokeOpenRouter(body);
        } else if (fallbackProvider === "openai") {
          return await invokeOpenAI(body);
        } else if (fallbackProvider === "llamacpp") {
          return await invokeLlamaCpp(body);
        } else if (fallbackProvider === "zai") {
          return await invokeZai(body);
        } else if (fallbackProvider === "moonshot") {
          return await invokeMoonshot(body);
        } else if (fallbackProvider === "vertex") {
          return await invokeVertex(body);
        }
        return await invokeDatabricks(body);
      });

      const fallbackLatency = Date.now() - fallbackStart;

      // Record fallback success
      metricsCollector.recordFallbackSuccess(fallbackLatency);
      metricsCollector.recordDatabricksRequest(true, retries);
      healthTracker.recordSuccess(fallbackProvider, fallbackLatency);

      // Record token usage
      if (fallbackResult.json?.usage) {
        metricsCollector.recordTokens(
          fallbackResult.json.usage.input_tokens || fallbackResult.json.usage.prompt_tokens || 0,
          fallbackResult.json.usage.output_tokens || fallbackResult.json.usage.completion_tokens || 0
        );
      }

      logger.info({
        originalProvider: initialProvider,
        fallbackProvider,
        fallbackLatency,
        totalLatency: Date.now() - startTime,
      }, "Fallback to cloud provider succeeded");

      // Return result with actual provider used (fallback provider) and routing decision
      return {
        ...fallbackResult,
        actualProvider: fallbackProvider,
        routingDecision: {
          ...routingDecision,
          provider: fallbackProvider,
          method: 'fallback',
          fallbackReason: reason,
        },
      };

    } catch (fallbackErr) {
      // Both providers failed
      metricsCollector.recordFallbackFailure();
      metricsCollector.recordDatabricksRequest(false, retries);
      healthTracker.recordFailure(fallbackProvider, fallbackErr, fallbackErr.status);

      logger.error({
        originalProvider: initialProvider,
        fallbackProvider,
        originalError: err.message,
        fallbackError: fallbackErr.message,
      }, "Both Ollama and fallback provider failed");

      // Return fallback error (more actionable than Ollama error)
      throw fallbackErr;
    }
  }
}

/**
 * Categorize failure for metrics
 */
function categorizeFailure(error) {
  if (error.name === "CircuitBreakerError" || error.code === "circuit_breaker_open") {
    return "circuit_breaker";
  }
  if (error.name === "AbortError" || error.code === "ETIMEDOUT") {
    return "timeout";
  }
  if (error.message?.includes("not configured") ||
    error.message?.includes("not available") ||
    error.code === "ECONNREFUSED") {
    return "service_unavailable";
  }
  if (error.message?.includes("tool") || error.message?.includes("function")) {
    return "tool_incompatible";
  }
  if (error.status === 429 || error.code === "RATE_LIMITED") {
    return "rate_limited";
  }
  return "error";
}

/**
 * Estimate cost savings from using Ollama
 */
function estimateCostSavings(inputTokens, outputTokens) {
  // Anthropic Claude Sonnet 4.5 pricing
  const INPUT_COST_PER_1M = 3.00;   // $3 per 1M input tokens
  const OUTPUT_COST_PER_1M = 15.00; // $15 per 1M output tokens

  const inputCost = (inputTokens / 1_000_000) * INPUT_COST_PER_1M;
  const outputCost = (outputTokens / 1_000_000) * OUTPUT_COST_PER_1M;

  return inputCost + outputCost;
}

/**
 * Destroy HTTP agents (for graceful shutdown)
 */
function destroyHttpAgents() {
  try {
    if (httpAgent) {
      httpAgent.destroy();
    }
    if (httpsAgent) {
      httpsAgent.destroy();
    }
    logger.info("HTTP agents destroyed");
  } catch (error) {
    logger.warn({ error }, "Failed to destroy HTTP agents");
  }
}

module.exports = {
  invokeModel,
  destroyHttpAgents,
};
