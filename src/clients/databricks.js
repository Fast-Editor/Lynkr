const config = require("../config");
const http = require("http");
const https = require("https");
const { withRetry } = require("./retry");
const { getCircuitBreakerRegistry } = require("./circuit-breaker");
const { getMetricsCollector } = require("../observability/metrics");
const logger = require("../logger");
const { STANDARD_TOOLS } = require("./standard-tools");
const { convertAnthropicToolsToOpenRouter } = require("./openrouter-utils");
const {
  detectModelFamily,
  convertAnthropicToBedrockFormat,
  convertBedrockResponseToAnthropic
} = require("./bedrock-utils");




if (typeof fetch !== "function") {
  throw new Error("Node 18+ is required for the built-in fetch API.");
}



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

  const { convertAnthropicToolsToOllama } = require("./ollama-utils");

  const endpoint = `${config.ollama.endpoint}/api/chat`;
  const headers = { "Content-Type": "application/json" };

  // Convert Anthropic messages format to Ollama format
  // Ollama expects content as string, not content blocks array
  const convertedMessages = (body.messages || []).map(msg => {
    let content = msg.content;

    // Convert content blocks array to simple string
    if (Array.isArray(content)) {
      content = content
        .filter(block => block.type === 'text')
        .map(block => block.text || '')
        .join('\n');
    }

    return {
      role: msg.role,
      content: content || ''
    };
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
    model: config.ollama.model,
    messages: deduplicated,
    stream: false,  // Force non-streaming for Ollama - streaming format conversion not yet implemented
    options: {
      temperature: body.temperature ?? 0.7,
      num_predict: body.max_tokens ?? 4096,
      top_p: body.top_p ?? 1.0,
    },
  };

  // Inject standard tools if client didn't send any (passthrough mode)
  let toolsToSend = body.tools;
  let toolsInjected = false;

  const injectToolsOllama = process.env.INJECT_TOOLS_OLLAMA !== "false";
  if (injectToolsOllama && (!Array.isArray(toolsToSend) || toolsToSend.length === 0)) {
    toolsToSend = STANDARD_TOOLS;
    toolsInjected = true;
    logger.info({
      injectedToolCount: STANDARD_TOOLS.length,
      injectedToolNames: STANDARD_TOOLS.map(t => t.name),
      reason: "Client did not send tools (passthrough mode)"
    }, "=== INJECTING STANDARD TOOLS (Ollama) ===");
  } else if (!injectToolsOllama) {
    logger.info({}, "Tool injection disabled for Ollama (INJECT_TOOLS_OLLAMA=false)");
  }

  // Add tools if present (for tool-capable models)
  if (Array.isArray(toolsToSend) && toolsToSend.length > 0) {
    ollamaBody.tools = convertAnthropicToolsToOllama(toolsToSend);
    logger.info({
      toolCount: toolsToSend.length,
      toolNames: toolsToSend.map(t => t.name),
      toolsInjected
    }, "Sending tools to Ollama");
  }

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
    model: config.openrouter.model,
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
    model: config.azureOpenAI.deployment
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
    azureBody.max_completion_tokens = azureBody.max_tokens;
    delete azureBody.max_tokens;
    delete azureBody.temperature;
    delete azureBody.top_p;
    return performJsonRequest(endpoint, { headers, body: azureBody }, "Azure OpenAI");
  }
  else {
    throw new Error(`Unsupported Azure OpenAI endpoint format: ${format}`);
  }
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
    model: config.openai.model || "gpt-4o",
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

async function invokeModel(body, options = {}) {
  const { determineProvider, isFallbackEnabled, getFallbackProvider } = require("./routing");
  const metricsCollector = getMetricsCollector();
  const registry = getCircuitBreakerRegistry();

  // Determine provider based on routing logic
  const initialProvider = options.forceProvider ?? determineProvider(body);
  const preferOllama = config.modelProvider?.preferOllama ?? false;

  logger.debug({
    initialProvider,
    preferOllama,
    fallbackEnabled: isFallbackEnabled(),
    toolCount: Array.isArray(body?.tools) ? body.tools.length : 0,
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
      }
      return await invokeDatabricks(body);
    });

    // Record success metrics
    const latency = Date.now() - startTime;
    metricsCollector.recordProviderSuccess(initialProvider, latency);
    metricsCollector.recordDatabricksRequest(true, retries);

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

    // Return result with provider info for proper response conversion
    return {
      ...result,
      actualProvider: initialProvider
    };

  } catch (err) {
    // Record failure
    metricsCollector.recordProviderFailure(initialProvider);

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
        }
        return await invokeDatabricks(body);
      });

      const fallbackLatency = Date.now() - fallbackStart;

      // Record fallback success
      metricsCollector.recordFallbackSuccess(fallbackLatency);
      metricsCollector.recordDatabricksRequest(true, retries);

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

      // Return result with actual provider used (fallback provider)
      return {
        ...fallbackResult,
        actualProvider: fallbackProvider
      };

    } catch (fallbackErr) {
      // Both providers failed
      metricsCollector.recordFallbackFailure();
      metricsCollector.recordDatabricksRequest(false, retries);

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
