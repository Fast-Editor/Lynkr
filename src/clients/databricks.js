const config = require("../config");
const http = require("http");
const https = require("https");
const { withRetry } = require("./retry");
const { getCircuitBreakerRegistry } = require("./circuit-breaker");
const { getMetricsCollector } = require("../observability/metrics");
const logger = require("../logger");
const { STANDARD_TOOLS } = require("./standard-tools");

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

  // Inject standard tools if client didn't send any (passthrough mode)
  if (!Array.isArray(body.tools) || body.tools.length === 0) {
    body.tools = STANDARD_TOOLS;
    logger.info({
      injectedToolCount: STANDARD_TOOLS.length,
      injectedToolNames: STANDARD_TOOLS.map(t => t.name),
      reason: "Client did not send tools (passthrough mode)"
    }, "=== INJECTING STANDARD TOOLS (Databricks) ===");
  }

  const headers = {
    Authorization: `Bearer ${config.databricks.apiKey}`,
    "Content-Type": "application/json",
  };
  return performJsonRequest(config.databricks.url, { headers, body }, "Databricks");
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

  const ollamaBody = {
    model: config.ollama.model,
    messages: convertedMessages,
    stream: body.stream ?? false,
    options: {
      temperature: body.temperature ?? 0.7,
      num_predict: body.max_tokens ?? 4096,
      top_p: body.top_p ?? 1.0,
    },
  };

  // Inject standard tools if client didn't send any (passthrough mode)
  let toolsToSend = body.tools;
  let toolsInjected = false;

  if (!Array.isArray(toolsToSend) || toolsToSend.length === 0) {
    toolsToSend = STANDARD_TOOLS;
    toolsInjected = true;
    logger.info({
      injectedToolCount: STANDARD_TOOLS.length,
      injectedToolNames: STANDARD_TOOLS.map(t => t.name),
      reason: "Client did not send tools (passthrough mode)"
    }, "=== INJECTING STANDARD TOOLS (Ollama) ===");
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

async function invokeAzureOpenAI(body) {
  if (!config.azureOpenAI?.endpoint || !config.azureOpenAI?.apiKey) {
    throw new Error("Azure OpenAI endpoint or API key is not configured.");
  }

  const {
    convertAnthropicToolsToOpenRouter,
    convertAnthropicMessagesToOpenRouter
  } = require("./openrouter-utils");

  // Azure OpenAI URL format: {endpoint}/openai/deployments/{deployment}/chat/completions
  const endpoint = `${config.azureOpenAI.endpoint}/openai/deployments/${config.azureOpenAI.deployment}/chat/completions?api-version=${config.azureOpenAI.apiVersion}`;

  const headers = {
    "api-key": config.azureOpenAI.apiKey,  // Azure uses "api-key" not "Authorization"
    "Content-Type": "application/json",
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

  const azureBody = {
    messages,
    temperature: body.temperature ?? 0.3,  // Lower temperature for more deterministic, action-oriented behavior
    max_tokens: Math.min(body.max_tokens ?? 4096, 16384),  // Cap at Azure OpenAI's limit
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

  return performJsonRequest(endpoint, { headers, body: azureBody }, "Azure OpenAI");
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

module.exports = {
  invokeModel,
};
