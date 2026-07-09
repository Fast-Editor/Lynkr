const crypto = require("crypto");
const config = require("../config");
const http = require("http");
const https = require("https");
const { withRetry } = require("./retry");
const { getCircuitBreakerRegistry } = require("./circuit-breaker");
const { getMetricsCollector } = require("../observability/metrics");
const { getHealthTracker } = require("../observability/health-tracker");
const { createBulkhead } = require("./resilience");
const logger = require("../logger");
const { STANDARD_TOOLS, STANDARD_TOOL_NAMES } = require("./standard-tools");
const { convertAnthropicToolsToOpenRouter } = require("./openrouter-utils");
const {
  detectModelFamily
} = require("./bedrock-utils");
const { getGPTSystemPromptAddendum } = require("./gpt-utils");
const telemetry = require("../routing/telemetry");
const { scoreResponseQuality } = require("../routing/quality-scorer");
const { getLatencyTracker } = require("../routing/latency-tracker");
// WS5.4 — feedback loop. `recordOutcome` runs on setImmediate and never
// throws; every failure is captured into the degradation registry.
const { recordOutcome: recordFeedbackOutcome } = require("../routing/feedback");




if (typeof fetch !== "function") {
  throw new Error("Node 18+ is required for the built-in fetch API.");
}

// Z.AI request bulkhead - limit concurrent requests to avoid rate limiting
// Configurable via ZAI_MAX_CONCURRENT env var (default: 2)
const zaiMaxConcurrent = parseInt(process.env.ZAI_MAX_CONCURRENT || '2', 10);
const zaiSemaphore = createBulkhead({ maxConcurrent: zaiMaxConcurrent, maxQueue: 50 });
logger.info({ maxConcurrent: zaiMaxConcurrent }, "Z.AI bulkhead initialized");



// HTTP connection pooling for better performance
// Increased maxSockets for high-concurrency team deployments (50+ devs)
const httpAgent = new http.Agent({
  keepAlive: true,
  maxSockets: 200,
  maxFreeSockets: 20,
  timeout: 120000,
  keepAliveMsecs: 30000,
});

const httpsAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 200,
  maxFreeSockets: 20,
  timeout: 120000,
  keepAliveMsecs: 30000,
});

/**
 * Strip Lynkr's internal underscore-prefixed fields from a body about to be
 * sent upstream. Every provider validates its request body (Anthropic and
 * Ollama Cloud both use Pydantic and reject unknown keys with "Extra inputs
 * are not permitted"), so any leak of _sessionId / _forceProvider / _tierModel
 * etc. into the outbound JSON hard-fails the request.
 *
 * This is a defense-in-depth strip at the last-hop chokepoint. Individual
 * invoke functions already whitelist their outbound bodies, but doing this
 * once here means no future codepath (or spread of `{...body}` in a new
 * provider) can regress the invariant.
 */
function _stripInternalFields(body) {
  if (!body || typeof body !== 'object') return body;
  let cleaned = null;
  for (const key of Object.keys(body)) {
    if (key.startsWith('_')) {
      if (!cleaned) cleaned = { ...body };
      delete cleaned[key];
    }
  }
  return cleaned || body;
}

async function performJsonRequest(url, { headers = {}, body, retryableStatusesOverride }, providerLabel) {
  const agent = url.startsWith('https:') ? httpsAgent : httpAgent;
  body = _stripInternalFields(body);
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
    ...(retryableStatusesOverride ? { retryableStatuses: retryableStatusesOverride } : {}),
  });
}

async function invokeDatabricks(body, incomingHeaders = {}) {
  if (!config.databricks?.url) {
    throw new Error("Databricks configuration is missing required URL.");
  }

  // Create a copy of body to avoid mutating the original
  const databricksBody = { ...body };

  // Inject standard tools if client didn't send any (passthrough mode)
  if (!Array.isArray(databricksBody.tools) || databricksBody.tools.length === 0) {
    databricksBody.tools = STANDARD_TOOLS;
    logger.debug({
      injectedToolCount: STANDARD_TOOLS.length,
      injectedToolNames: STANDARD_TOOL_NAMES,
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

async function invokeAzureAnthropic(body, incomingHeaders = {}) {
  if (!config.azureAnthropic?.endpoint) {
    throw new Error("Azure Anthropic endpoint is not configured.");
  }

  // Copy body so we don't mutate the caller's object across agent-loop iterations.
  const azureBody = { ...body };

  // Tier routing wins over whatever model Claude Code sent.
  if (azureBody._tierModel) {
    azureBody.model = azureBody._tierModel;
  }

  // Strip ALL Lynkr-internal fields (convention: leading underscore). Anthropic
  // rejects unknown top-level keys with "Extra inputs are not permitted", and
  // the orchestrator sprinkles fields like _requestMode, _tierModel, _workspace,
  // _sessionId, _tenantPolicy, _suggestionModeModel onto the payload.
  for (const key of Object.keys(azureBody)) {
    if (key.startsWith('_')) delete azureBody[key];
  }

  // Tier routing can dispatch here even when the orchestrator formatted the
  // payload for a different provider (the orchestrator picks format from the
  // static MODEL_PROVIDER, not the tier-resolved provider). Normalize OpenAI-style
  // shapes back to Anthropic format so the API doesn't reject the request.

  // 1) Tools: {type:"function", function:{...}} -> {name, description, input_schema}
  if (Array.isArray(azureBody.tools)) {
    azureBody.tools = azureBody.tools.map((tool) => {
      if (tool?.type === "function" && tool.function) {
        return {
          name: tool.function.name,
          description: tool.function.description,
          input_schema: tool.function.parameters ?? { type: "object", properties: {} },
        };
      }
      return tool;
    });
  }

  // Strip Lynkr's Caveman "[brevity] …" trailer from the system prompt — it
  // changes the prompt vs. what Claude Code would send to Anthropic directly,
  // and Anthropic's OAuth subscription anti-abuse is sensitive to that drift.
  const stripBrevity = (s) => {
    if (typeof s !== 'string') return s;
    const idx = s.indexOf('[brevity]');
    if (idx === -1) return s;
    return s.slice(0, idx).trimEnd();
  };
  if (typeof azureBody.system === 'string') {
    azureBody.system = stripBrevity(azureBody.system);
  } else if (Array.isArray(azureBody.system)) {
    azureBody.system = azureBody.system
      .map((block) => block && typeof block === 'object' && typeof block.text === 'string'
        ? { ...block, text: stripBrevity(block.text) }
        : block)
      .filter((block) => !(block && typeof block === 'object' && block.text === ''));
  }

  // 2) System prompt: Anthropic wants top-level `system`, not a system message.
  //    Promote any leading role:"system" messages into the top-level field.
  if (Array.isArray(azureBody.messages) && azureBody.messages.length > 0) {
    const systemMessages = [];
    while (azureBody.messages.length > 0 && azureBody.messages[0]?.role === "system") {
      systemMessages.push(azureBody.messages.shift());
    }
    if (systemMessages.length > 0) {
      const systemText = systemMessages
        .map((m) => (typeof m.content === "string"
          ? m.content
          : Array.isArray(m.content)
            ? m.content.map((b) => b?.text || "").join("\n")
            : ""))
        .filter(Boolean)
        .join("\n\n");
      // Merge with any existing top-level system (string or array).
      if (azureBody.system) {
        const existing = typeof azureBody.system === "string"
          ? azureBody.system
          : Array.isArray(azureBody.system)
            ? azureBody.system.map((s) => s?.text || s).join("\n")
            : "";
        azureBody.system = existing ? `${existing}\n\n${systemText}` : systemText;
      } else {
        azureBody.system = systemText;
      }
    }
  }

  // OAuth passthrough: prefer incoming Bearer token (Claude Pro/Max subscription)
  // over a configured API key.
  const incomingAuth = incomingHeaders?.authorization || incomingHeaders?.Authorization;

  // Headers Anthropic uses to verify client identity for subscription OAuth tokens.
  // If we strip these, Anthropic returns 429 rate_limit_error with no rate-limit
  // headers (its terse anti-proxy response). Forward every Anthropic-relevant
  // request header from Claude Code verbatim — anthropic-beta, anthropic-version,
  // user-agent, x-app, x-stainless-*, etc. Strip only hop-by-hop and proxy-control
  // headers that would confuse fetch or leak Lynkr's identity.
  const HOP_BY_HOP = new Set([
    'host', 'connection', 'keep-alive', 'transfer-encoding', 'upgrade',
    'proxy-authorization', 'proxy-authenticate', 'te', 'trailer',
    'content-length', 'accept-encoding',
  ]);
  const LYNKR_INTERNAL = new Set([
    'x-lynkr-tenant-id', 'x-lynkr-workspace', 'x-workspace-cwd',
    'x-session-id', 'x-request-id',
  ]);

  const headers = {};
  for (const [name, value] of Object.entries(incomingHeaders || {})) {
    if (value == null) continue;
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower)) continue;
    if (LYNKR_INTERNAL.has(lower)) continue;
    // Skip authorization here; we re-add it below with our preferred source.
    if (lower === 'authorization') continue;
    headers[name] = value;
  }

  // Always set these explicitly (override anything Claude Code sent that we
  // don't want to forward verbatim).
  headers["Content-Type"] = "application/json";
  if (!headers["anthropic-version"] && !headers["Anthropic-Version"]) {
    headers["anthropic-version"] = config.azureAnthropic.version ?? "2023-06-01";
  }

  if (incomingAuth && incomingAuth.startsWith('Bearer ')) {
    headers["Authorization"] = incomingAuth;

    // Claude Code OAuth Access Tokens (sk-ant-oat01-...) require the OAuth
    // anthropic-beta header to be accepted by api.anthropic.com. Without it
    // Anthropic responds 429 rate_limit_error with empty rate-limit headers
    // and message:"Error" — its terse anti-proxy response. Ensure it's set.
    const token = incomingAuth.slice('Bearer '.length);
    if (token.startsWith('sk-ant-oat')) {
      const existingBeta = headers['anthropic-beta'] || headers['Anthropic-Beta'];
      const oauthBeta = 'oauth-2025-04-20';
      if (!existingBeta) {
        headers['anthropic-beta'] = oauthBeta;
      } else if (!String(existingBeta).split(',').map(s => s.trim()).includes(oauthBeta)) {
        headers['anthropic-beta'] = `${existingBeta},${oauthBeta}`;
      }
    }
  } else if (config.azureAnthropic.apiKey) {
    headers["x-api-key"] = config.azureAnthropic.apiKey;
  } else {
    throw new Error("Azure Anthropic requires authentication (OAuth token or API key)");
  }

  logger.debug({
    forwardedHeaderKeys: Object.keys(headers),
    targetModel: azureBody.model,
  }, "Azure Anthropic: header forwarding");

  // Don't retry 429 for Anthropic OAuth subscription. Claude Code has its own
  // backoff and UI — retrying here just amplifies the burst and trips Anthropic's
  // anti-abuse, keeping us 429ed for longer. Still retry 5xx (server faults).
  const result = await performJsonRequest(
    config.azureAnthropic.endpoint,
    {
      headers,
      body: azureBody,
      retryableStatusesOverride: [500, 502, 503, 504],
    },
    "Azure Anthropic",
  );

  if (!result?.ok) {
    logger.warn({
      status: result?.status,
      error: result?.json?.error?.message || result?.text?.substring(0, 200),
      model: azureBody.model,
    }, "Azure Anthropic API error");
  }

  return result;
}

/**
 * Lift any <think>...</think> tags leaked into text content blocks into proper
 * Anthropic thinking content blocks. No-op if the response is already clean.
 * Operates on the response shape returned by performJsonRequest (object/string).
 */
function _liftLeakedThinkingBlocks(response) {
  // performJsonRequest may wrap the JSON body — find it.
  const payload = response?.json ?? response?.body ?? response;
  if (!payload || typeof payload !== "object" || !Array.isArray(payload.content)) {
    return response;
  }
  const thinkRegex = /<think>([\s\S]*?)<\/think>/g;
  const newContent = [];
  let lifted = 0;
  for (const block of payload.content) {
    if (block?.type === "text" && typeof block.text === "string" && block.text.includes("<think>")) {
      const thoughts = [];
      let m;
      while ((m = thinkRegex.exec(block.text)) !== null) thoughts.push(m[1].trim());
      thinkRegex.lastIndex = 0;
      const cleaned = block.text.replace(thinkRegex, "").trim();
      const merged = thoughts.filter(Boolean).join("\n\n");
      if (merged) {
        newContent.push({ type: "thinking", thinking: merged });
        lifted++;
      }
      if (cleaned) newContent.push({ type: "text", text: cleaned });
    } else {
      newContent.push(block);
    }
  }
  if (lifted > 0) {
    payload.content = newContent;
    logger.debug({ lifted }, "Ollama: lifted leaked <think> tags into thinking content blocks");
  }
  return response;
}

async function invokeOllama(body, incomingHeaders = {}) {
  if (!config.ollama?.endpoint) {
    throw new Error("Ollama endpoint is not configured.");
  }

  const { checkOllamaToolSupport, hasAnthropicEndpoint, convertAnthropicToolsToOllama } = require("./ollama-utils");

  const modelName = body._suggestionModeModel || body._tierModel || config.ollama.model;

  // Detect whether Ollama has the native Anthropic Messages API (v0.14.0+)
  const useAnthropicApi = await hasAnthropicEndpoint(config.ollama.endpoint);

  // Check if model supports tools FIRST (before wasteful injection)
  const supportsTools = await checkOllamaToolSupport(modelName);
  const injectToolsOllama = process.env.INJECT_TOOLS_OLLAMA !== "false";

  // Determine tools to send
  let toolsToSend = body.tools;
  let toolsInjected = false;

  if (!supportsTools) {
    toolsToSend = null;
  } else if (injectToolsOllama && (!Array.isArray(toolsToSend) || toolsToSend.length === 0)) {
    toolsToSend = STANDARD_TOOLS;
    toolsInjected = true;
  }

  // Consolidated tool injection log
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

  logger.debug({
    model: modelName,
    apiMode: useAnthropicApi ? "anthropic" : "legacy",
    toolCount,
    toolsInjected,
    supportsTools,
    toolNames: (Array.isArray(toolsToSend) && toolsToSend.length > 0) ? toolsToSend.map(t => t.name) : []
  }, `=== Ollama STANDARD TOOLS INJECTION for ${config.ollama.model} === ${logMessage}`);

  // ---- Anthropic-native path (Ollama v0.14.0+) ----
  if (useAnthropicApi) {
    const endpoint = `${config.ollama.endpoint}/v1/messages`;
    const headers = {
      "Content-Type": "application/json",
      "anthropic-version": "2023-06-01",
    };

    // Build body with only valid Anthropic Messages API fields
    const ollamaBody = {
      model: modelName,
      messages: body.messages,
      max_tokens: body.max_tokens || 16384,
      stream: body.stream ?? false,
    };

    if (body.system) ollamaBody.system = body.system;
    if (body.temperature !== undefined) ollamaBody.temperature = body.temperature;
    if (body.top_p !== undefined) ollamaBody.top_p = body.top_p;
    if (body.top_k !== undefined) ollamaBody.top_k = body.top_k;
    if (body.stop_sequences) ollamaBody.stop_sequences = body.stop_sequences;
    if (body.tool_choice) ollamaBody.tool_choice = body.tool_choice;
    if (body.metadata) ollamaBody.metadata = body.metadata;

    // Tools (already Anthropic format — no conversion needed)
    if (supportsTools && Array.isArray(toolsToSend) && toolsToSend.length > 0) {
      ollamaBody.tools = toolsToSend;
    }

    if (config.ollama.keepAlive !== undefined) {
      const keepAlive = config.ollama.keepAlive;
      ollamaBody.keep_alive = /^-?\d+$/.test(keepAlive)
        ? parseInt(keepAlive, 10)
        : keepAlive;
      logger.debug({ keepAlive: ollamaBody.keep_alive }, "Ollama keep_alive configured");
    }

    const response = await performJsonRequest(endpoint, { headers, body: ollamaBody }, "Ollama");
    // Even on the Anthropic-native path, Ollama Cloud's MiniMax M2.5 adapter
    // sometimes leaks <think>...</think> as raw text inside content blocks
    // instead of emitting a thinking content block (ollama/ollama#14220 was
    // patched server-side 2026-02-13 but coverage is incomplete). Sanitize:
    // pull leaked <think> tags out of text blocks and re-shape them as proper
    // Anthropic thinking blocks before returning to Claude Code, otherwise
    // Claude Code's loop sees stop_reason="end_turn" + empty text and halts.
    return _liftLeakedThinkingBlocks(response);
  }

  // ---- Legacy path (Ollama < v0.14.0, /api/chat with OpenAI format) ----
  const endpoint = `${config.ollama.endpoint}/api/chat`;
  const headers = { "Content-Type": "application/json" };

  // Convert Anthropic messages to Ollama format.
  //
  // CRITICAL for MiniMax M2/M2.5 and other interleaved-thinking models:
  // assistant `thinking` blocks MUST be preserved across turns (re-emitted as
  // <think>...</think> in content) and `tool_use` blocks MUST become OpenAI
  // tool_calls. Dropping these is the root cause of the 5-10-call stall — see
  // https://www.minimax.io/news/why-is-interleaved-thinking-important-for-m2
  // and HF model card: "Do not remove the <think>...</think> part, otherwise
  // the model's performance will be negatively affected."
  const convertedMessages = [];

  if (body.system && typeof body.system === "string" && body.system.trim().length > 0) {
    convertedMessages.push({ role: "system", content: body.system.trim() });
  }

  (body.messages || []).forEach(msg => {
    const content = msg.content;

    // Plain string content — pass through unchanged.
    if (typeof content === "string") {
      convertedMessages.push({ role: msg.role, content });
      return;
    }

    if (!Array.isArray(content)) {
      convertedMessages.push({ role: msg.role, content: "" });
      return;
    }

    // Block-array content. Separate by block type.
    if (msg.role === "assistant") {
      const textParts = [];
      const toolCalls = [];
      for (const block of content) {
        if (!block || typeof block !== "object") continue;
        if (block.type === "thinking" && typeof block.thinking === "string" && block.thinking.trim()) {
          // Re-emit thinking as <think>...</think> so MiniMax can re-read its own reasoning.
          textParts.push(`<think>${block.thinking}</think>`);
        } else if (block.type === "redacted_thinking" && typeof block.data === "string") {
          textParts.push(`<think>${block.data}</think>`);
        } else if (block.type === "text" && typeof block.text === "string") {
          textParts.push(block.text);
        } else if (block.type === "tool_use") {
          toolCalls.push({
            id: block.id,
            type: "function",
            function: {
              name: block.name,
              arguments: typeof block.input === "string" ? block.input : JSON.stringify(block.input ?? {}),
            },
          });
        }
      }
      const assistantMsg = { role: "assistant", content: textParts.join("\n") };
      if (toolCalls.length > 0) assistantMsg.tool_calls = toolCalls;
      convertedMessages.push(assistantMsg);
      return;
    }

    // role === "user" — may contain tool_result blocks that need to become
    // role:"tool" messages in OpenAI format (one per tool_result).
    const userTextParts = [];
    const toolResultMsgs = [];
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      if (block.type === "text" && typeof block.text === "string") {
        userTextParts.push(block.text);
      } else if (block.type === "tool_result") {
        let resultText = "";
        if (typeof block.content === "string") {
          resultText = block.content;
        } else if (Array.isArray(block.content)) {
          resultText = block.content
            .map(c => (c?.type === "text" ? (c.text || "") : ""))
            .join("\n");
        }
        toolResultMsgs.push({
          role: "tool",
          tool_call_id: block.tool_use_id,
          content: resultText,
        });
      }
    }
    if (userTextParts.length > 0) {
      convertedMessages.push({ role: "user", content: userTextParts.join("\n") });
    }
    for (const tm of toolResultMsgs) convertedMessages.push(tm);
  });

  // MERGE consecutive messages with same role (only user/assistant — never
  // touch tool messages, each tool_call_id needs its own response).
  //
  // Previous behavior silently DROPPED the second message, which destroyed
  // the user's prompt when Claude Code preceded it with a <system-reminder>
  // user message — symptom: model said "I don't see a specific path".
  const deduplicated = [];
  for (const msg of convertedMessages) {
    const prev = deduplicated[deduplicated.length - 1];
    if (prev && prev.role === msg.role && msg.role !== "tool" && !prev.tool_calls && !msg.tool_calls) {
      const merged = [prev.content, msg.content].filter(Boolean).join("\n\n");
      prev.content = merged;
      logger.debug({
        role: msg.role,
        mergedLen: merged.length,
      }, 'Ollama: Merged consecutive same-role messages');
      continue;
    }
    deduplicated.push(msg);
  }

  const ollamaBody = {
    model: modelName,
    messages: deduplicated,
    stream: body.stream ?? false,
    options: {
      temperature: body.temperature ?? 0.7,
      num_predict: body.max_tokens ?? 16384,
      top_p: body.top_p ?? 1.0,
    },
  };

  if (config.ollama.keepAlive !== undefined) {
    const keepAlive = config.ollama.keepAlive;
    ollamaBody.keep_alive = /^-?\d+$/.test(keepAlive)
      ? parseInt(keepAlive, 10)
      : keepAlive;
    logger.debug({ keepAlive: ollamaBody.keep_alive }, "Ollama keep_alive configured");
  }

  // Tools need conversion to OpenAI function-calling format for legacy endpoint
  if (supportsTools && Array.isArray(toolsToSend) && toolsToSend.length > 0) {
    ollamaBody.tools = convertAnthropicToolsToOllama(toolsToSend);
  }

  return performJsonRequest(endpoint, { headers, body: ollamaBody }, "Ollama");
}

async function invokeOpenRouter(body, incomingHeaders = {}) {
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
    model: body._suggestionModeModel || body._tierModel || config.openrouter.model,
    messages,
    temperature: body.temperature ?? 0.7,
    max_tokens: body.max_tokens ?? 16384,
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
    logger.debug({
      injectedToolCount: STANDARD_TOOLS.length,
      injectedToolNames: STANDARD_TOOL_NAMES,
      reason: "Client did not send tools (passthrough mode)"
    }, "=== INJECTING STANDARD TOOLS (OpenRouter) ===");
  }

  if (Array.isArray(toolsToSend) && toolsToSend.length > 0) {
    openRouterBody.tools = convertAnthropicToolsToOpenRouter(toolsToSend);
    logger.debug({
      toolCount: toolsToSend.length,
      toolNames: toolsToSend.map(t => t.name),
      toolsInjected
    }, "Sending tools to OpenRouter");
  }

  return performJsonRequest(endpoint, { headers, body: openRouterBody }, "OpenRouter");
}

// Eden AI is an OpenAI-compatible gateway (provider/model naming, EU/GDPR).
// It speaks the same wire format as OpenRouter, so this mirrors invokeOpenRouter
// and reuses the shared Anthropic<->OpenAI converters.
async function invokeEdenAI(body, incomingHeaders = {}) {
  if (!config.edenai?.endpoint || !config.edenai?.apiKey) {
    throw new Error("Eden AI endpoint or API key is not configured.");
  }

  const {
    convertAnthropicToolsToOpenRouter,
    convertAnthropicMessagesToOpenRouter
  } = require("./openrouter-utils");

  const endpoint = config.edenai.endpoint;
  const headers = {
    "Authorization": `Bearer ${config.edenai.apiKey}`,
    "Content-Type": "application/json"
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

  const edenAIBody = {
    model: body._suggestionModeModel || body._tierModel || config.edenai.model,
    messages,
    temperature: body.temperature ?? 0.7,
    max_tokens: body.max_tokens ?? 16384,
    top_p: body.top_p ?? 1.0,
    stream: body.stream ?? false
  };

  // Add tools - inject standard tools if client didn't send any (passthrough mode)
  let toolsToSend = body.tools;
  let toolsInjected = false;

  if (!Array.isArray(toolsToSend) || toolsToSend.length === 0) {
    toolsToSend = STANDARD_TOOLS;
    toolsInjected = true;
    logger.debug({
      injectedToolCount: STANDARD_TOOLS.length,
      injectedToolNames: STANDARD_TOOL_NAMES,
      reason: "Client did not send tools (passthrough mode)"
    }, "=== INJECTING STANDARD TOOLS (Eden AI) ===");
  }

  if (Array.isArray(toolsToSend) && toolsToSend.length > 0) {
    edenAIBody.tools = convertAnthropicToolsToOpenRouter(toolsToSend);
    logger.debug({
      toolCount: toolsToSend.length,
      toolNames: toolsToSend.map(t => t.name),
      toolsInjected
    }, "Sending tools to Eden AI");
  }

  return performJsonRequest(endpoint, { headers, body: edenAIBody }, "EdenAI");
}

function detectAzureFormat(url) {
  if (url.includes("/openai/responses")) return "responses";
  if (url.includes("/models/")) return "models";
  if (url.includes("/openai/deployments")) return "deployments";
  throw new Error("Unknown Azure OpenAI endpoint");
}


async function invokeAzureOpenAI(body, incomingHeaders = {}) {
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

  // System prompt injection disabled - breaks model response
  // Tool guidance now provided via tool descriptions instead

  const azureDeployment = body._suggestionModeModel || body._tierModel || config.azureOpenAI.deployment || "";
  const isGpt5 = /gpt-5/i.test(azureDeployment);
  const maxTokensKey = isGpt5 ? "max_completion_tokens" : "max_tokens";

  // gpt-5 family supports much larger output budgets than 16k. The previous
  // 16384 hard cap caused silent mid-stream truncations on long "explain this
  // codebase" responses (Azure returns finish_reason=length → Anthropic
  // stop_reason=max_tokens → Claude Code halts and asks the user to continue).
  // Raise to 32768 as a sane default; respect a higher client-supplied
  // body.max_tokens up to that ceiling.
  const azureOpenAIMaxOutput = 32768;
  const azureBody = {
    messages,
    temperature: body.temperature ?? 0.3,
    [maxTokensKey]: Math.min(body.max_tokens ?? azureOpenAIMaxOutput, azureOpenAIMaxOutput),
    top_p: body.top_p ?? 1.0,
    stream: false,
    model: azureDeployment
  };

  // Add tools - inject standard tools if client didn't send any (passthrough mode)
  let toolsToSend = body.tools;
  let toolsInjected = false;

  if (!Array.isArray(toolsToSend) || toolsToSend.length === 0) {
    // Client didn't send tools (likely passthrough mode) - inject standard Claude Code tools
    toolsToSend = STANDARD_TOOLS;
    toolsInjected = true;
    logger.debug({
      injectedToolCount: STANDARD_TOOLS.length,
      injectedToolNames: STANDARD_TOOL_NAMES,
      reason: "Client did not send tools (passthrough mode)"
    }, "=== INJECTING STANDARD TOOLS ===");
  }

  if (Array.isArray(toolsToSend) && toolsToSend.length > 0) {
    azureBody.tools = convertAnthropicToolsToOpenRouter(toolsToSend);
    azureBody.parallel_tool_calls = true;  // Enable parallel tool calls
    azureBody.tool_choice = "auto";  // Explicitly enable tool use (helps GPT models understand they should use tools)
    logger.debug({
      toolCount: toolsToSend.length,
      toolNames: toolsToSend.map(t => t.name),
      toolsInjected,
      hasSystemMessage: !!body.system,
      messageCount: messages.length,
      temperature: azureBody.temperature,
      sampleTool: azureBody.tools[0] // Log first tool for inspection
    }, "=== SENDING TOOLS TO AZURE OPENAI ===");
  }

  logger.debug({
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

    // Detect if this is a continuation request (has tool results)
    // Azure content filter triggers on full system prompt in continuations
    // Check for:
    // 1. tool_result blocks in user messages (Anthropic format)
    // 2. tool messages (OpenAI format)
    // 3. assistant messages with tool_use or tool_calls (indicates prior tool invocation)
    // 4. Flattened continuation pattern from orchestrator (contains "IMPORTANT: Focus on")
    const hasToolResults = (body.messages || []).some(msg => {
      // Check for Anthropic format tool_result in user messages
      if (msg.role === "user" && Array.isArray(msg.content)) {
        if (msg.content.some(block => block.type === "tool_result")) return true;
      }
      // Check for OpenAI format tool messages
      if (msg.role === "tool") return true;
      // Check for assistant messages with tool_use (Anthropic) or tool_calls (OpenAI)
      // If there's a prior tool use, this is a continuation
      if (msg.role === "assistant") {
        if (Array.isArray(msg.content)) {
          if (msg.content.some(block => block.type === "tool_use")) return true;
        }
        if (msg.tool_calls && msg.tool_calls.length > 0) return true;
      }
      return false;
    }) || azureBody.messages.some(msg => {
      // Also check converted messages for flattened continuation pattern
      // The orchestrator flattens tool results into user message with this marker
      if (msg.role === "user" && typeof msg.content === "string") {
        if (msg.content.includes("IMPORTANT: Focus on and respond ONLY to my most recent request")) return true;
      }
      return false;
    });

    if (hasToolResults) {
      logger.debug({
        hasToolResults: true,
        originalMessageCount: (body.messages || []).length,
        convertedMessageCount: azureBody.messages.length,
        messageRoles: (body.messages || []).map(m => m.role),
      }, "=== CONTINUATION REQUEST DETECTED - using minimal system prompt to avoid Azure content filter ===");
    } else {
      logger.debug({
        hasToolResults: false,
        originalMessageCount: (body.messages || []).length,
        messageRoles: (body.messages || []).map(m => m.role),
      }, "Initial request - using full system prompt");
    }

    // Helper function to strip <system-reminder> tags and meta-instructions from content
    // Azure's jailbreak filter triggers on these instructions in continuation requests
    const stripSystemReminders = (content) => {
      if (!content || typeof content !== 'string') return content;
      // Remove <system-reminder>...</system-reminder> blocks
      let cleaned = content.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, '');
      // Remove the continuation marker that orchestrator adds
      cleaned = cleaned.replace(/---\s*IMPORTANT:\s*Focus on and respond ONLY to my most recent request[^\n]*/gi, '');
      // Trim whitespace
      return cleaned.trim();
    };

    for (const msg of azureBody.messages) {
      if (msg.role === "system") {
        // For continuation requests, use minimal system prompt to avoid content filter
        // Azure's jailbreak detection triggers on security-related text in continuations
        if (hasToolResults) {
          responsesInput.push({
            type: "message",
            role: "developer",
            content: "You are a helpful coding assistant. Continue helping the user based on the tool results."
          });
        } else {
          // Initial request - use full system prompt
          responsesInput.push({
            type: "message",
            role: "developer",
            content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)
          });
        }
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
              // For continuation requests, strip system-reminder tags to avoid jailbreak filter
              const textContent = hasToolResults ? stripSystemReminders(block.text || "") : (block.text || "");
              if (textContent) {  // Only add if there's content after stripping
                responsesInput.push({
                  type: "message",
                  role: "user",
                  content: textContent
                });
              }
            }
          }
        } else {
          // For continuation requests, strip system-reminder tags to avoid jailbreak filter
          let userContent = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
          if (hasToolResults) {
            userContent = stripSystemReminders(userContent);
          }
          if (userContent) {  // Only add if there's content after stripping
            responsesInput.push({
              type: "message",
              role: "user",
              content: userContent
            });
          }
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
    logger.debug({
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
      const rawToolCalls = outputArray
        .filter(o => o.type === "function_call")
        .map(tc => ({
          id: tc.call_id || tc.id || `call_${Date.now()}`,
          type: "function",
          function: {
            name: tc.name,
            arguments: typeof tc.arguments === 'string' ? tc.arguments : JSON.stringify(tc.arguments || {})
          }
        }));

      // Deduplicate identical tool calls (GPT sometimes returns multiple identical calls)
      const seenSignatures = new Set();
      const toolCalls = rawToolCalls.filter(tc => {
        const signature = `${tc.function.name}:${tc.function.arguments}`;
        if (seenSignatures.has(signature)) {
          logger.warn({
            toolName: tc.function.name,
            signature: signature.substring(0, 100),
          }, "Filtered duplicate tool call from GPT response");
          return false;
        }
        seenSignatures.add(signature);
        return true;
      });

      if (rawToolCalls.length !== toolCalls.length) {
        logger.debug({
          originalCount: rawToolCalls.length,
          dedupedCount: toolCalls.length,
          removed: rawToolCalls.length - toolCalls.length,
        }, "Deduplicated identical tool calls from single response");
      }

      logger.debug({
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

      logger.debug({
        convertedContent: textContent?.substring(0, 100),
        hasToolCalls: toolCalls.length > 0,
        toolCallCount: toolCalls.length
      }, "Converted Responses API to Chat Completions format");

      // Now convert from Chat Completions format to Anthropic format
      const anthropicJson = convertOpenAIToAnthropic(result.json);
      logger.debug({
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


async function invokeOpenAI(body, incomingHeaders = {}) {
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

  // System prompt injection disabled - breaks model response

  const openAIBody = {
    model: body._suggestionModeModel || body._tierModel || config.openai.model || "gpt-4o",
    messages,
    temperature: body.temperature ?? 0.7,
    max_tokens: body.max_tokens ?? 16384,
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
    logger.debug({
      injectedToolCount: STANDARD_TOOLS.length,
      injectedToolNames: STANDARD_TOOL_NAMES,
      reason: "Client did not send tools (passthrough mode)"
    }, "=== INJECTING STANDARD TOOLS (OpenAI) ===");
  }

  if (Array.isArray(toolsToSend) && toolsToSend.length > 0) {
    openAIBody.tools = convertAnthropicToolsToOpenRouter(toolsToSend);
    openAIBody.parallel_tool_calls = false;  // Disable parallel tool calls - GPT often makes duplicate calls
    openAIBody.tool_choice = "auto";  // Let the model decide when to use tools
    logger.debug({
      toolCount: toolsToSend.length,
      toolNames: toolsToSend.map(t => t.name),
      toolsInjected
    }, "=== SENDING TOOLS TO OPENAI ===");
  }

  logger.debug({
    endpoint,
    model: openAIBody.model,
    hasTools: !!openAIBody.tools,
    toolCount: openAIBody.tools?.length || 0,
    temperature: openAIBody.temperature,
    max_tokens: openAIBody.max_tokens,
  }, "=== OPENAI REQUEST ===");

  return performJsonRequest(endpoint, { headers, body: openAIBody }, "OpenAI");
}

async function invokeLlamaCpp(body, incomingHeaders = {}) {
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
    logger.debug({
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
    max_tokens: body.max_tokens ?? 16384,
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
    logger.debug({
      injectedToolCount: STANDARD_TOOLS.length,
      injectedToolNames: STANDARD_TOOL_NAMES,
      reason: "Client did not send tools (passthrough mode)"
    }, "=== INJECTING STANDARD TOOLS (llama.cpp) ===");
  } else if (!injectToolsLlamacpp) {
    logger.debug({}, "Tool injection disabled for llama.cpp (INJECT_TOOLS_LLAMACPP=false)");
  }

  if (Array.isArray(toolsToSend) && toolsToSend.length > 0) {
    llamacppBody.tools = convertAnthropicToolsToOpenRouter(toolsToSend);
    llamacppBody.tool_choice = "auto";
    logger.debug({
      toolCount: toolsToSend.length,
      toolNames: toolsToSend.map(t => t.name),
      toolsInjected
    }, "=== SENDING TOOLS TO LLAMA.CPP ===");
  }

  logger.debug({
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

async function invokeLMStudio(body, incomingHeaders = {}) {
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
    max_tokens: body.max_tokens ?? 16384,
    top_p: body.top_p ?? 1.0,
    stream: body.stream ?? false
  };

  // Inject standard tools if client didn't send any
  let toolsToSend = body.tools;
  let toolsInjected = false;

  if (!Array.isArray(toolsToSend) || toolsToSend.length === 0) {
    toolsToSend = STANDARD_TOOLS;
    toolsInjected = true;
    logger.debug({
      injectedToolCount: STANDARD_TOOLS.length,
      injectedToolNames: STANDARD_TOOL_NAMES,
      reason: "Client did not send tools (passthrough mode)"
    }, "=== INJECTING STANDARD TOOLS (LM Studio) ===");
  }

  if (Array.isArray(toolsToSend) && toolsToSend.length > 0) {
    lmstudioBody.tools = convertAnthropicToolsToOpenRouter(toolsToSend);
    lmstudioBody.tool_choice = "auto";
    logger.debug({
      toolCount: toolsToSend.length,
      toolNames: toolsToSend.map(t => t.name),
      toolsInjected
    }, "=== SENDING TOOLS TO LM STUDIO ===");
  }

  logger.debug({
    endpoint,
    hasTools: !!lmstudioBody.tools,
    toolCount: lmstudioBody.tools?.length || 0,
    temperature: lmstudioBody.temperature,
    max_tokens: lmstudioBody.max_tokens,
  }, "=== LM STUDIO REQUEST ===");

  return performJsonRequest(endpoint, { headers, body: lmstudioBody }, "LM Studio");
}

/**
 * Flatten an Anthropic-style content value into a plain string for the
 * Bedrock Converse API.
 *
 * Prompt-cache injection (injectPromptCaching) rewrites string `system`
 * fields and message `content` into arrays of `{ type, text, cache_control }`
 * blocks. The Converse API has no `cache_control` concept and expects
 * `system: [{ text: "<string>" }]` and message content blocks shaped as
 * `{ text: "<string>" }`. Passing the injected array through unchanged would
 * either drop the cache markers silently or nest an array under `text`,
 * producing a ValidationException.
 *
 * @param {string|Array|undefined} value - String or array of content blocks
 * @returns {string} Concatenated plain text
 */
function flattenContentToText(value) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map(block => {
        if (typeof block === "string") return block;
        if (block && typeof block === "object") return block.text || block.content || "";
        return "";
      })
      .join("");
  }
  return String(value);
}

/**
 * Normalize a request body for the Bedrock Converse API.
 *
 * Strips `cache_control` markers and flattens any array-shaped `system` /
 * message `content` (left behind by prompt-cache injection) back into the
 * plain strings the Converse API expects. Returns a shallow copy with a
 * normalized `messages` array; the original body is not mutated.
 *
 * @param {Object} body - Anthropic-format request body
 * @returns {Object} Body safe for Converse request construction
 */
function normalizeBodyForConverse(body) {
  const normalized = { ...body };

  if (normalized.system !== undefined) {
    normalized.system = flattenContentToText(normalized.system);
  }

  if (Array.isArray(normalized.messages)) {
    normalized.messages = normalized.messages.map(msg => ({
      ...msg,
      content: flattenContentToText(msg.content),
    }));
  }

  return normalized;
}

async function invokeBedrock(body, incomingHeaders = {}) {
  // 1. Validate Bearer token
  if (!config.bedrock?.apiKey) {
    throw new Error(
      "AWS Bedrock requires AWS_BEDROCK_API_KEY (Bearer token). " +
      "Generate from AWS Console → Bedrock → API Keys, then set AWS_BEDROCK_API_KEY in your .env file."
    );
  }

  const bearerToken = config.bedrock.apiKey;
  logger.debug({ authMethod: "Bearer Token" }, "=== BEDROCK AUTH ===");

  // 2. Inject standard tools if needed
  let toolsToSend = body.tools;
  let toolsInjected = false;

  if (!Array.isArray(toolsToSend) || toolsToSend.length === 0) {
    toolsToSend = STANDARD_TOOLS;
    toolsInjected = true;
    logger.debug({
      injectedToolCount: STANDARD_TOOLS.length,
      injectedToolNames: STANDARD_TOOL_NAMES,
      reason: "Client did not send tools (passthrough mode)"
    }, "=== INJECTING STANDARD TOOLS (Bedrock) ===");
  }

  // Normalize away cache_control / array shapes that prompt-cache injection
  // may have applied: the Converse API expects plain-string system and
  // message content, not Anthropic cache_control blocks.
  const bedrockBody = { ...normalizeBodyForConverse(body), tools: toolsToSend };

  // 4. Detect model family and convert format
  const modelId = body._tierModel || config.bedrock.modelId;
  const modelFamily = detectModelFamily(modelId);

  logger.debug({
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

  logger.debug({
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

    logger.debug({
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
async function invokeZai(body, incomingHeaders = {}) {
  if (!config.zai?.apiKey) {
    throw new Error("Z.AI API key is not configured. Set ZAI_API_KEY in your .env file.");
  }

  const endpoint = config.zai.endpoint || "https://api.z.ai/api/anthropic/v1/messages";
  const isOpenAIFormat = endpoint.includes("/chat/completions");

  // Model mapping: Anthropic names → Z.AI names (lowercase)
  const modelMap = {
    "claude-sonnet-4-5-20250929": "glm-4.7",
    "claude-sonnet-4-5": "glm-4.7",
    "claude-sonnet-4.5": "glm-4.7",
    "claude-3-5-sonnet": "glm-4.7",
    "claude-haiku-4-5-20251001": "glm-4.5-air",
    "claude-haiku-4-5": "glm-4.5-air",
    "claude-3-haiku": "glm-4.5-air",
  };

  const requestedModel = body._tierModel || body.model || config.zai.model;
  let mappedModel = modelMap[requestedModel] || config.zai.model || "glm-4.7";
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
      max_tokens: body.max_tokens || 16384,
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
      zaiBody.parallel_tool_calls = false;  // Disable parallel tool calls - GPT often makes duplicate calls
    }

    headers = {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${config.zai.apiKey}`,
    };
  } else {
    // Anthropic format endpoint
    zaiBody = { ...body };
    zaiBody.model = mappedModel;

    // Inject standard tools if client didn't send any (passthrough mode)
    if (!Array.isArray(zaiBody.tools) || zaiBody.tools.length === 0) {
      zaiBody.tools = STANDARD_TOOLS;
      logger.debug({
        injectedToolCount: STANDARD_TOOLS.length,
        injectedToolNames: STANDARD_TOOL_NAMES,
        reason: "Client did not send tools (passthrough mode)"
      }, "=== INJECTING STANDARD TOOLS (Z.AI Anthropic) ===");
    }

    headers = {
      "Content-Type": "application/json",
      "x-api-key": config.zai.apiKey,
      "anthropic-version": "2023-06-01",
    };
  }

  logger.debug({
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
  }, "=== Z.AI REQUEST ===");

  logger.debug({
    zaiBody: JSON.stringify(zaiBody).substring(0, 1000),
  }, "Z.AI request body (truncated)");

  // Use bulkhead to limit concurrent Z.AI requests (prevents rate limiting)
  return zaiSemaphore.execute(async () => {
    logger.debug("Z.AI bulkhead executing request");

    const response = await performJsonRequest(endpoint, { headers, body: zaiBody }, "Z.AI");

    logger.debug({
      responseOk: response?.ok,
      responseStatus: response?.status,
      hasJson: !!response?.json,
      rawContent: response?.json?.choices?.[0]?.message?.content,
      hasReasoning: !!response?.json?.choices?.[0]?.message?.reasoning_content,
      isOpenAIFormat,
    }, "=== Z.AI RAW RESPONSE ===");

    // Convert OpenAI response back to Anthropic format if needed
    if (isOpenAIFormat && response?.ok && response?.json) {
      const anthropicJson = convertOpenAIToAnthropic(response.json);
      logger.debug({
        convertedContent: JSON.stringify(anthropicJson.content).substring(0, 200),
      }, "=== Z.AI CONVERTED RESPONSE ===");
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



/**
 * Moonshot AI (Kimi) Provider
 *
 * Moonshot offers Kimi models through an OpenAI-compatible chat completions API.
 * Uses native system role support (unlike Z.AI which merges into user message).
 */
async function invokeMoonshot(body, incomingHeaders = {}) {
  if (!config.moonshot?.apiKey) {
    throw new Error("Moonshot API key is not configured. Set MOONSHOT_API_KEY in your .env file.");
  }

  const {
    convertAnthropicToolsToOpenRouter,
    convertAnthropicMessagesToOpenRouter
  } = require("./openrouter-utils");

  const endpoint = config.moonshot.endpoint || "https://api.moonshot.ai/v1/chat/completions";

  // Model mapping: Anthropic names → Moonshot/Kimi names
  const modelMap = {
    "claude-sonnet-4-5-20250929": "kimi-k2-turbo-preview",
    "claude-sonnet-4-5": "kimi-k2-turbo-preview",
    "claude-sonnet-4.5": "kimi-k2-turbo-preview",
    "claude-3-5-sonnet": "kimi-k2-turbo-preview",
    "claude-haiku-4-5-20251001": "kimi-k2-turbo-preview",
    "claude-haiku-4-5": "kimi-k2-turbo-preview",
    "claude-3-haiku": "kimi-k2-turbo-preview",
    // moonshot-v1-auto 400s with "tokenization failed" (its server-side auto
    // context-size pass fails on large tool-bearing payloads). Remap to a
    // fixed model that's broadly available on api.moonshot.ai.
    "moonshot-v1-auto": "moonshot-v1-128k",
  };

  const requestedModel = body._tierModel || body.model || config.moonshot.model;
  let mappedModel = modelMap[requestedModel] || config.moonshot.model || "kimi-k2-turbo-preview";
  // Guard against the deprecated auto model arriving via config too.
  if (mappedModel === "moonshot-v1-auto") mappedModel = "moonshot-v1-128k";

  // Convert messages using existing utility
  const messages = convertAnthropicMessagesToOpenRouter(body.messages || []);

  // Moonshot natively supports system role — add as system message
  if (body.system) {
    const systemContent = Array.isArray(body.system)
      ? body.system.map(s => s.text || s).join("\n")
      : body.system;
    messages.unshift({ role: "system", content: systemContent });
  }

  // kimi-k2.x (k2.5 / k2.6 …) are thinking models that only accept
  // temperature: 1 — any other value 400s with "invalid temperature".
  const isKimiThinking = /^kimi-k2/i.test(mappedModel);

  const moonshotBody = {
    model: mappedModel,
    messages,
    max_tokens: body.max_tokens || 16384,
    // kimi-k2.x thinking models pin sampling params: temperature must be 1
    // and top_p must be 0.95 — any other value 400s.
    temperature: isKimiThinking ? 1 : (body.temperature ?? 0.7),
    top_p: isKimiThinking ? 0.95 : (body.top_p ?? 1.0),
    stream: false,  // Force non-streaming - OpenAI SSE to Anthropic SSE conversion not implemented
  };

  // Convert and add tools if present
  if (Array.isArray(body.tools) && body.tools.length > 0) {
    moonshotBody.tools = convertAnthropicToolsToOpenRouter(body.tools);
    moonshotBody.tool_choice = "auto";
    moonshotBody.parallel_tool_calls = false;
  }

  const headers = {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${config.moonshot.apiKey}`,
  };

  logger.debug({
    endpoint,
    model: moonshotBody.model,
    originalModel: requestedModel,
    messageCount: moonshotBody.messages?.length || 0,
    hasTools: !!moonshotBody.tools,
    toolCount: moonshotBody.tools?.length || 0,
  }, "=== Moonshot REQUEST ===");

  const response = await performJsonRequest(endpoint, { headers, body: moonshotBody }, "Moonshot");

  const rawMsg = response?.json?.choices?.[0]?.message;
  logger.debug({
    responseOk: response?.ok,
    responseStatus: response?.status,
    hasJson: !!response?.json,
    contentType: typeof rawMsg?.content,
    contentValue: typeof rawMsg?.content === 'string' ? rawMsg.content.substring(0, 300) : String(JSON.stringify(rawMsg?.content) || '').substring(0, 300),
    hasReasoning: !!rawMsg?.reasoning_content,
    reasoningType: typeof rawMsg?.reasoning_content,
    reasoningValue: typeof rawMsg?.reasoning_content === 'string' ? rawMsg.reasoning_content.substring(0, 300) : String(JSON.stringify(rawMsg?.reasoning_content) || '').substring(0, 300),
    finishReason: response?.json?.choices?.[0]?.finish_reason,
    messageKeys: rawMsg ? Object.keys(rawMsg) : [],
    fullRawResponse: String(JSON.stringify(response?.json) || '').substring(0, 800),
  }, "=== Moonshot RAW RESPONSE ===");

  // Convert OpenAI response back to Anthropic format
  if (response?.ok && response?.json) {
    const anthropicJson = convertOpenAIToAnthropic(response.json);
    logger.debug({
      convertedContent: JSON.stringify(anthropicJson.content).substring(0, 500),
      contentLength: anthropicJson.content?.length,
      firstContentType: anthropicJson.content?.[0]?.type,
      firstContentText: anthropicJson.content?.[0]?.text?.substring(0, 300),
    }, "=== Moonshot CONVERTED RESPONSE ===");
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
 * Convert OpenAI response to Anthropic format
 */
function convertOpenAIToAnthropic(response) {
  if (!response.choices || !response.choices[0]) {
    return response; // Return as-is if unexpected format
  }

  const choice = response.choices[0];
  const message = choice.message || {};
  const content = [];

  // Extract tool calls embedded as XML/text in content (Minimax, Qwen, GLM, etc.)
  if (!message.tool_calls?.length && typeof message.content === "string" && message.content.trim()) {
    const { extractToolCallsFromText } = require("./xml-tool-extractor");
    const extracted = extractToolCallsFromText(message.content);
    if (extracted.toolCalls.length > 0) {
      message.tool_calls = extracted.toolCalls;
      message.content = extracted.cleanedText;
      choice.finish_reason = "tool_calls";
    }
  }

  // Add text content from message.content
  // Don't add placeholder text if there are tool_calls - tools are the actual response
  const hasToolCalls = Array.isArray(message.tool_calls) && message.tool_calls.length > 0;

  // Extract text content and reasoning from thinking models
  const textContent = typeof message.content === 'string' ? message.content : '';
  const reasoningContent = typeof message.reasoning_content === 'string' ? message.reasoning_content : '';

  // Emit reasoning_content as a proper thinking block (not discarded)
  if (reasoningContent) {
    content.push({ type: "thinking", thinking: reasoningContent });
  }

  if (textContent) {
    content.push({ type: "text", text: textContent });
  } else if (!reasoningContent) {
    // No content and no reasoning — will be handled by the empty check below
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
  // IMPORTANT: Check for actual tool_calls presence, not just finish_reason string.
  // Some providers (Moonshot, etc.) return finish_reason: "stop" even when tool_calls exist.
  // If we don't set stop_reason to "tool_use", the CLI won't execute the tool calls.
  let stopReason = "end_turn";
  if (hasToolCalls) {
    stopReason = "tool_use";
  } else if (choice.finish_reason === "length") {
    stopReason = "max_tokens";
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
async function invokeVertex(body, incomingHeaders = {}) {
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
  const requestedModel = body._tierModel || body.model || config.vertex.model;
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
      maxOutputTokens: body.max_tokens || 16384,
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

  logger.debug({
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
    logger.debug({
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

async function invokeCodex(body, incomingHeaders = {}) {
  const { getCodexProcess } = require("./codex-process");
  const { convertAnthropicToCodexPrompt, convertCodexResponseToAnthropic } = require("./codex-utils");

  const codex = getCodexProcess();
  await codex.ensureRunning();

  const model = body._tierModel || config.codex?.model || "gpt-5.3-codex";
  const { prompt, systemContext } = convertAnthropicToCodexPrompt(body);

  if (!prompt) {
    throw new Error("Codex: no prompt content to send");
  }

  // Start a new thread
  const threadParams = { model };
  if (systemContext) {
    threadParams.instructions = systemContext;
  }
  const threadResult = await codex.sendRequest("thread/start", threadParams);
  const threadId = threadResult?.threadId || threadResult?.id;

  if (!threadId) {
    throw new Error("Codex: thread/start did not return a threadId");
  }

  logger.debug({ threadId, model, promptLength: prompt.length }, "[Codex] Thread started");

  // Send the turn and collect response
  const turnResult = await codex.sendTurn(threadId, prompt, model);

  logger.debug({
    threadId,
    responseLength: turnResult.text?.length || 0,
  }, "[Codex] Turn completed");

  // Convert to Anthropic format
  const anthropicJson = convertCodexResponseToAnthropic(turnResult, model);

  return {
    ok: true,
    status: 200,
    json: anthropicJson,
    text: JSON.stringify(anthropicJson),
    contentType: "application/json",
  };
}

/**
 * Compute request cost in USD from model pricing × token usage.
 * Registry returns per-1M-token prices ({ input, output }); returns null when
 * pricing is unknown so we don't record misleading zeros.
 */
const _unknownCostWarned = new Set();
function computeCostUsd(model, inputTokens, outputTokens) {
  try {
    const { getModelRegistrySync } = require("../routing/model-registry");
    const reg = getModelRegistrySync && getModelRegistrySync();
    const cost = reg?.getCost?.(model);
    if (!cost) return null;
    // Unknown model → record null (not a fabricated default), warn once so the
    // gap is visible and can be fixed via MODEL_PRICE_OVERRIDES.
    if (cost.unknown) {
      if (model && !_unknownCostWarned.has(model)) {
        _unknownCostWarned.add(model);
        logger.warn({ model }, "[Cost] No pricing for model — recording cost_usd=null. Set MODEL_PRICE_OVERRIDES to fix.");
      }
      return null;
    }
    if (cost.input == null && cost.output == null) return null;
    const inUsd = ((inputTokens || 0) / 1e6) * (cost.input || 0);
    const outUsd = ((outputTokens || 0) / 1e6) * (cost.output || 0);
    return Number((inUsd + outUsd).toFixed(6));
  } catch {
    return null;
  }
}

// Telemetry prompt/response text is always captured (truncated) to build the
// routing ML training corpus. Stored locally in .lynkr/telemetry.db only.
const TELEMETRY_TEXT_MAXLEN = 2000;

/** Flatten the latest user message to plain text (for telemetry capture). */
function captureRequestText(body) {
  const messages = body?.messages;
  if (!Array.isArray(messages)) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role !== "user") continue;
    let text = "";
    if (typeof m.content === "string") text = m.content;
    else if (Array.isArray(m.content)) {
      text = m.content.filter((b) => b?.type === "text").map((b) => b.text || "").join(" ");
    }
    if (text) return text.slice(0, TELEMETRY_TEXT_MAXLEN);
  }
  return null;
}

/** Flatten an Anthropic response's text blocks to plain text (for telemetry). */
function captureResponseText(resultJson) {
  const content = resultJson?.content;
  if (!Array.isArray(content)) return null;
  const text = content.filter((b) => b?.type === "text").map((b) => b.text || "").join(" ");
  return text ? text.slice(0, TELEMETRY_TEXT_MAXLEN) : null;
}

// Strip prior-turn Lynkr routing badges from assistant content[]. The badge
// is injected into the response stream as a content block (see router.js paths
// near lines 213, 1078, 1264, 1402) so the TUI renders it. Claude Code persists
// content[] into the session transcript and resubmits it as conversation
// history on each subsequent request, so without this strip the badge text
// dominates the model's view of its own prior turns — which breaks M2.5's
// interleaved-thinking continuity (HF model card requires preserved <think>
// blocks across turns; resubmitted badges replace them and Tau²/BrowseComp
// scores collapse). Render-side injection stays untouched; this only sanitises
// what we forward upstream.
// Matches a Lynkr badge string anchored at the start, e.g.
//   "*[Lynkr] SIMPLE → minimax-m2.5:cloud (ollama) · score 21*\n\n\n"
// The badge format never contains an inner `*` until the closing one, so a
// non-greedy lazy match is unnecessary — match up to (and including) the
// closing `*` plus trailing whitespace.
const LYNKR_BADGE_PREFIX_RE = /^\*\[Lynkr\][^*\n]*\*\s*/;

function stripLynkrBadges(messages) {
  if (!Array.isArray(messages)) return messages;
  let mutated = false;
  let badgeCount = 0;
  const out = messages.map((msg) => {
    if (msg?.role !== 'assistant') return msg;

    // String content variant — assistant.content is a bare string. This is
    // what the orchestrator's OpenAI-format response branch produces, and
    // it's where badges actually leak in the Ollama agent loop.
    if (typeof msg.content === 'string') {
      if (!LYNKR_BADGE_PREFIX_RE.test(msg.content)) return msg;
      const stripped = msg.content.replace(LYNKR_BADGE_PREFIX_RE, '');
      mutated = true;
      badgeCount++;
      // Badge-only content must not become an empty string — Anthropic
      // rejects empty assistant content (this is the interrupted-response
      // continuation case, where the partial text WAS just the badge).
      return { ...msg, content: stripped.trim() ? stripped : '…' };
    }

    // Array content variant — Anthropic-format responses keep content as an
    // array of blocks. Strip the badge PREFIX from matching blocks rather
    // than dropping whole blocks: clients that merge text blocks on replay
    // produce "badge + real answer" in ONE block, and dropping it would
    // silently delete the model's actual reply from history. A block that
    // was badge-only disappears entirely.
    if (Array.isArray(msg.content)) {
      let changed = false;
      const rebuilt = [];
      for (const b of msg.content) {
        if (b?.type === 'text' && typeof b.text === 'string' && LYNKR_BADGE_PREFIX_RE.test(b.text)) {
          changed = true;
          badgeCount++;
          const strippedText = b.text.replace(LYNKR_BADGE_PREFIX_RE, '');
          if (strippedText.trim()) rebuilt.push({ ...b, text: strippedText });
          // badge-only block → drop
        } else {
          rebuilt.push(b);
        }
      }
      if (!changed) return msg;
      mutated = true;
      // Anthropic rejects BOTH empty content[] and empty-string text blocks
      // (min length 1) — the previous `text: ''` placeholder 400'd upstream
      // on interrupted-response continuations where the partial assistant
      // text was just the badge. Use a visible-but-benign ellipsis.
      return { ...msg, content: rebuilt.length ? rebuilt : [{ type: 'text', text: '…' }] };
    }

    return msg;
  });
  return mutated ? out : messages;
}

async function invokeModel(body, options = {}) {
  const { determineProviderSmart, isFallbackEnabled, getFallbackProvider } = require("./routing");
  const metricsCollector = getMetricsCollector();
  const registry = getCircuitBreakerRegistry();
  const healthTracker = getHealthTracker();

  // Extract incoming headers for OAuth passthrough
  const incomingHeaders = options.headers || {};

  // Sanitise inbound history before any provider sees it. See stripLynkrBadges
  // comment for the M2.5-collapse rationale. Safe for all providers — the badge
  // is never legitimate prior-turn content.
  if (Array.isArray(body?.messages)) {
    body = { ...body, messages: stripLynkrBadges(body.messages) };
  }

  // Determine provider via async tier routing
  // Thread workspace for code-graph integration (from X-Lynkr-Workspace header or body._workspace)
  const workspace = body._workspace || options.workspace || null;
  const tenantPolicy = body._tenantPolicy || options.tenantPolicy || null;
  const routingResult = options.forceProvider
    ? {
        // Forced path (OAuth intent + subscription): the actual decision was
        // made upstream in api/router.js. Reconstitute the shape from
        // req.body so WS0 telemetry columns (tier, base_tier,
        // escalation_source, pinned, switch_reason) survive the hop.
        provider: options.forceProvider,
        model: body._tierModel ?? null,
        tier: body._tierName ?? null,
        method: body._forcedMethod || 'forced',
        base_tier: body._baseTier ?? null,
        escalation_source: body._escalationSource ?? null,
        pinned: body._pinnedRoute ? true : false,
        switch_reason: body._switchReason ?? null,
        // WS4 — off-policy evaluation from telemetry alone requires
        // propensity + candidates on every row. Deterministic default is
        // 1.0 with a single-entry candidate list matching the served pair.
        propensity: body._propensity ?? 1.0,
        candidates: body._candidates ?? [{ provider: options.forceProvider, model: body._tierModel ?? null }],
        // WS5 — feedback loop. Forward the bandit context vector so
        // bandit.update fires with the same features the arm was scored on,
        // and the query embedding so conclusive-quality outcomes grow the
        // kNN index without paying for a second embedding call.
        _banditContext: body._banditContext ?? null,
        _queryEmbedding: body._queryEmbedding ?? null,
        _queryText: body._queryText ?? null,
      }
    : await determineProviderSmart(body, { workspace, tenantPolicy });
  const initialProvider = routingResult.provider;
  const tierSelectedModel = routingResult.model;

  // Inject tier-selected model into body so provider functions can use it
  if (tierSelectedModel) {
    body._tierModel = tierSelectedModel;
  }

  // Inject provider-side prompt caching (cache_control breakpoints)
  // Reduces input token cost by up to 90% and latency by up to 80%
  const { injectPromptCaching } = require('./prompt-cache-injection');
  injectPromptCaching(body, initialProvider);

  // Always-on markdown formatting guard. Stops formatting-weak backends
  // (Moonshot/Kimi, Ollama, etc.) from emitting mangled ASCII box-drawing
  // "diagrams". Keyed off the routing-resolved provider/model; skipped for
  // Claude-family backends which already format cleanly.
  const { injectFormatGuard } = require('../context/output-format-guard');
  injectFormatGuard(body, { provider: initialProvider, model: tierSelectedModel });

  // Build routing decision object for response headers
  const routingDecision = {
    provider: initialProvider,
    tier: routingResult.tier || null,
    model: tierSelectedModel || null,
    score: routingResult.score,
    threshold: routingResult.threshold,
    mode: routingResult.mode,
    reason: routingResult.reason,
    method: routingResult.method || 'static',
  };

  logger.debug({
    initialProvider,
    tierSelectedModel,
    tier: routingResult.tier,
    fallbackEnabled: isFallbackEnabled(),
    toolCount: Array.isArray(body?.tools) ? body.tools.length : 0,
    score: routingResult.score,
    reason: routingResult.reason,
    method: routingResult.method,
  }, "Provider routing decision");

  // Phase 3.3 — small-first cascade (LYNKR_CASCADE_ENABLED=true to opt in).
  // _cascadeInner prevents recursive cascade when invokeModel is called from inside.
  if (!options._cascadeInner) {
    const cascadeModule = require('../routing/cascade');
    const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
    if (cascadeModule.shouldCascade({
      tier: routingDecision.tier,
      streaming: !!body.stream,
      hasTools,
    })) {
      try {
        const { getModelTierSelector } = require('../routing/model-tiers');
        const simpleSelection = getModelTierSelector().selectModel('SIMPLE', null);
        const cascadeResult = await cascadeModule.run({
          payload: body,
          smallModel: simpleSelection,
          bigModel: { provider: initialProvider, model: tierSelectedModel },
          invoke: async (provider, model, payload) => {
            const cloned = { ...payload };
            if (model) cloned._tierModel = model;
            const resp = await invokeModel(cloned, { forceProvider: provider, _cascadeInner: true });
            return resp.json; // confidence-scorer needs response body (.content)
          },
          taskType: body._taskType || routingResult.reason || 'reasoning',
          threshold: 0.85,
        });
        logger.debug({
          accepted: cascadeResult.cascadeStats.accepted,
          usedModel: cascadeResult.usedModel,
          totalMs: cascadeResult.cascadeStats.totalLatency,
        }, '[Cascade] Result');
        return {
          ok: true,
          status: 200,
          json: cascadeResult.response,
          stream: null,
          routingDecision: { ...routingDecision, cascadeStats: cascadeResult.cascadeStats, usedModel: cascadeResult.usedModel },
        };
      } catch (err) {
        logger.debug({ err: err.message }, '[Cascade] Failed, falling through to normal routing');
      }
    }
  }

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
        return await invokeAzureOpenAI(body, incomingHeaders);
      } else if (initialProvider === "azure-anthropic") {
        return await invokeAzureAnthropic(body, incomingHeaders);
      } else if (initialProvider === "ollama") {
        return await invokeOllama(body, incomingHeaders);
      } else if (initialProvider === "openrouter") {
        return await invokeOpenRouter(body, incomingHeaders);
      } else if (initialProvider === "edenai") {
        return await invokeEdenAI(body, incomingHeaders);
      } else if (initialProvider === "openai") {
        return await invokeOpenAI(body, incomingHeaders);
      } else if (initialProvider === "llamacpp") {
        return await invokeLlamaCpp(body, incomingHeaders);
      } else if (initialProvider === "lmstudio") {
        return await invokeLMStudio(body, incomingHeaders);
      } else if (initialProvider === "bedrock") {
        return await invokeBedrock(body, incomingHeaders);
      } else if (initialProvider === "zai") {
        return await invokeZai(body, incomingHeaders);
      } else if (initialProvider === "vertex") {
        return await invokeVertex(body, incomingHeaders);
      } else if (initialProvider === "moonshot") {
        return await invokeMoonshot(body, incomingHeaders);
      } else if (initialProvider === "codex") {
        return await invokeCodex(body, incomingHeaders);
      }
      return await invokeDatabricks(body, incomingHeaders);
    });

    // Record success metrics
    const latency = Date.now() - startTime;
    metricsCollector.recordProviderSuccess(initialProvider, latency);
    metricsCollector.recordDatabricksRequest(true, retries);
    healthTracker.recordSuccess(initialProvider, latency);

    // Record latency for routing intelligence
    getLatencyTracker().record(initialProvider, latency);

    // Record tokens and cost savings
    const outputTokens = result.json?.usage?.output_tokens || result.json?.usage?.completion_tokens || 0;
    const inputTokens = result.json?.usage?.input_tokens || result.json?.usage?.prompt_tokens || 0;
    if (result.json?.usage) {
      metricsCollector.recordTokens(inputTokens, outputTokens);

      // Estimate cost savings if Ollama was used
      if (initialProvider === "ollama") {
        const savings = estimateCostSavings(inputTokens, outputTokens);
        metricsCollector.recordCostSavings(savings);
      }
    }

    // Count tool calls in response
    const toolCallsMade = result.json?.content?.filter?.(
      (b) => b.type === "tool_use"
    )?.length || 0;

    // Compute quality score
    const qualityScore = scoreResponseQuality(
      { tier: routingDecision.tier, hasTools: Array.isArray(body?.tools) && body.tools.length > 0 },
      null,
      {
        status_code: 200,
        output_tokens: outputTokens,
        tool_calls_made: toolCallsMade,
        was_fallback: false,
        retry_count: retries,
        error_type: null,
        latency_ms: latency,
      }
    );

    // Record routing telemetry (non-blocking)
    telemetry.record({
      request_id: crypto.randomUUID(),
      session_id: body._sessionId || null,
      timestamp: Date.now(),
      complexity_score: routingResult.score ?? null,
      tier: routingDecision.tier,
      agentic_type: routingResult.agenticResult?.agentType || null,
      tool_count: Array.isArray(body?.tools) ? body.tools.length : 0,
      input_tokens: inputTokens || null,
      message_count: Array.isArray(body?.messages) ? body.messages.length : 0,
      request_type: routingResult.analysis?.requestType || null,
      provider: initialProvider,
      model: routingDecision.model ?? body._tierModel ?? null,
      routing_method: routingDecision.method,
      was_fallback: false,
      output_tokens: outputTokens || null,
      latency_ms: latency,
      status_code: 200,
      error_type: null,
      tool_calls_made: toolCallsMade,
      retry_count: retries,
      circuit_breaker_state: breaker.state,
      quality_score: qualityScore,
      tokens_per_second: outputTokens && latency > 0 ? outputTokens / (latency / 1000) : null,
      cost_usd: computeCostUsd(routingDecision.model || body._tierModel, inputTokens, outputTokens),
      request_text: captureRequestText(body),
      response_text: captureResponseText(result.json),
      base_tier: routingResult.base_tier ?? null,
      escalation_source: routingResult.escalation_source ?? null,
      propensity: routingResult.propensity ?? null,
      candidates: routingResult.candidates ?? null,
      pinned: routingResult.pinned ? 1 : 0,
      switch_reason: routingResult.switch_reason ?? null,
    });

    // WS5.4 — feedback loop (success path).
    recordFeedbackOutcome({
      routingResult,
      body,
      outcome: {
        qualityScore,
        costUsd: computeCostUsd(routingDecision.model || body._tierModel, inputTokens, outputTokens),
        latencyMs: latency,
        statusCode: 200,
        errorType: null,
        wasFallback: false,
      },
    });

    // Return result with provider info and routing decision for headers
    return {
      ...result,
      actualProvider: initialProvider,
      routingDecision,
    };

  } catch (err) {
    // Record failure
    const failLatency = Date.now() - startTime;
    metricsCollector.recordProviderFailure(initialProvider);
    healthTracker.recordFailure(initialProvider, err, err.status);
    getLatencyTracker().record(initialProvider, routingDecision?.model, failLatency);

    // Tier-aware escalate-then-demote fallback (TIER_FALLBACK_ENABLED).
    // On failure, try a MORE capable tier first (climb toward REASONING); only
    // if every higher tier is unavailable do we fall downward to SIMPLE/local.
    // Runs before the flat global fallback below and is never silent.
    if (config.tierFallback?.enabled && !options._tierFallbackInner && routingDecision.tier) {
      const { getFallbackChain } = require("../routing/tier-fallback");
      const chain = getFallbackChain(routingDecision.tier);
      for (const cand of chain) {
        try {
          logger.warn({
            fromTier: routingDecision.tier,
            fromProvider: initialProvider,
            toTier: cand.tier,
            toProvider: cand.provider,
            toModel: cand.model,
            direction: cand.direction,
          }, "[TierFallback] Primary tier failed — attempting tier fallback");

          const attempt = await invokeModel(
            { ...body, _tierModel: cand.model },
            {
              forceProvider: cand.provider,
              _tierFallbackInner: true,
              disableFallback: true,
              _cascadeInner: true,
              workspace,
              tenantPolicy,
            }
          );

          metricsCollector.recordFallbackAttempt(initialProvider, cand.provider, "tier_fallback");
          logger.warn({
            servedTier: cand.tier,
            servedProvider: cand.provider,
            fromTier: routingDecision.tier,
            direction: cand.direction,
          }, "[TierFallback] Served by tier fallback");

          return {
            ...attempt,
            actualProvider: cand.provider,
            routingDecision: {
              ...routingDecision,
              provider: cand.provider,
              model: cand.model,
              servedTier: cand.tier,
              fromTier: routingDecision.tier,
              fallback: true,
              fallbackDirection: cand.direction,
              method: "tier_fallback",
            },
          };
        } catch (innerErr) {
          logger.warn(
            { toProvider: cand.provider, error: innerErr.message },
            "[TierFallback] Candidate failed, trying next"
          );
        }
      }
      logger.warn(
        { fromTier: routingDecision.tier },
        "[TierFallback] All tier candidates exhausted — falling through"
      );
    }

    // Check if we should fallback (any provider can fall back, not just ollama)
    const shouldFallback =
      isFallbackEnabled() &&
      initialProvider !== getFallbackProvider() &&
      !options.disableFallback;

    if (!shouldFallback) {
      metricsCollector.recordDatabricksRequest(false, retries);

      const failQualityScore = scoreResponseQuality(
        { tier: routingDecision.tier, hasTools: Array.isArray(body?.tools) && body.tools.length > 0 },
        null,
        { error_type: err.code || err.name, was_fallback: false, retry_count: retries, latency_ms: failLatency }
      );

      // Record failed telemetry
      telemetry.record({
        request_id: crypto.randomUUID(),
        session_id: body._sessionId || null,
        timestamp: Date.now(),
        complexity_score: routingResult.score ?? null,
        tier: routingDecision.tier,
        agentic_type: routingResult.agenticResult?.agentType || null,
        tool_count: Array.isArray(body?.tools) ? body.tools.length : 0,
        input_tokens: null,
        message_count: Array.isArray(body?.messages) ? body.messages.length : 0,
        request_type: routingResult.analysis?.requestType || null,
        provider: initialProvider,
        model: routingDecision.model ?? body._tierModel ?? null,
        routing_method: routingDecision.method,
        was_fallback: false,
        latency_ms: failLatency,
        status_code: err.status || null,
        error_type: err.code || err.name || "unknown",
        quality_score: failQualityScore,
        base_tier: routingResult.base_tier ?? null,
        escalation_source: routingResult.escalation_source ?? null,
        propensity: routingResult.propensity ?? null,
        candidates: routingResult.candidates ?? null,
        pinned: routingResult.pinned ? 1 : 0,
        switch_reason: routingResult.switch_reason ?? null,
      });

      // WS5.4 — feedback loop (primary-failed, no fallback). Low quality
      // scores are signal too: the bandit's reward drops, and if the
      // outcome is conclusive-negative (≤40) the kNN index learns to
      // steer away from this (query → model) pairing.
      recordFeedbackOutcome({
        routingResult,
        body,
        outcome: {
          qualityScore: failQualityScore,
          costUsd: null,
          latencyMs: failLatency,
          statusCode: err.status || null,
          errorType: err.code || err.name || "unknown",
          wasFallback: false,
        },
      });

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
    }, "Primary provider failed, attempting transparent fallback");

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
          return await invokeAzureOpenAI(body, incomingHeaders);
        } else if (fallbackProvider === "azure-anthropic") {
          return await invokeAzureAnthropic(body, incomingHeaders);
        } else if (fallbackProvider === "openrouter") {
          return await invokeOpenRouter(body, incomingHeaders);
        } else if (fallbackProvider === "edenai") {
          return await invokeEdenAI(body, incomingHeaders);
        } else if (fallbackProvider === "openai") {
          return await invokeOpenAI(body, incomingHeaders);
        } else if (fallbackProvider === "llamacpp") {
          return await invokeLlamaCpp(body, incomingHeaders);
        } else if (fallbackProvider === "zai") {
          return await invokeZai(body, incomingHeaders);
        } else if (fallbackProvider === "vertex") {
          return await invokeVertex(body, incomingHeaders);
        } else if (fallbackProvider === "moonshot") {
          return await invokeMoonshot(body, incomingHeaders);
        }
        return await invokeDatabricks(body, incomingHeaders);
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

      // Record latency for fallback provider
      getLatencyTracker().record(fallbackProvider, routingDecision?.model, fallbackLatency);

      // Capture fallback telemetry
      const fbOutputTokens = fallbackResult.json?.usage?.output_tokens || fallbackResult.json?.usage?.completion_tokens || 0;
      const fbInputTokens = fallbackResult.json?.usage?.input_tokens || fallbackResult.json?.usage?.prompt_tokens || 0;
      const fbToolCalls = fallbackResult.json?.content?.filter?.(
        (b) => b.type === "tool_use"
      )?.length || 0;

      const fbTotalLatency = Date.now() - startTime;
      const fbQualityScore = scoreResponseQuality(
        { tier: routingDecision.tier, hasTools: Array.isArray(body?.tools) && body.tools.length > 0 },
        null,
        { status_code: 200, output_tokens: fbOutputTokens, tool_calls_made: fbToolCalls, was_fallback: true, retry_count: 0, latency_ms: fbTotalLatency }
      );
      const fbCostUsd = computeCostUsd(routingDecision.model || body._tierModel, fbInputTokens, fbOutputTokens);

      telemetry.record({
        request_id: crypto.randomUUID(),
        session_id: body._sessionId || null,
        timestamp: Date.now(),
        complexity_score: routingResult.score ?? null,
        tier: routingDecision.tier,
        agentic_type: routingResult.agenticResult?.agentType || null,
        tool_count: Array.isArray(body?.tools) ? body.tools.length : 0,
        input_tokens: fbInputTokens || null,
        message_count: Array.isArray(body?.messages) ? body.messages.length : 0,
        request_type: routingResult.analysis?.requestType || null,
        provider: fallbackProvider,
        model: routingDecision.model ?? body._tierModel ?? null,
        routing_method: "fallback",
        was_fallback: true,
        output_tokens: fbOutputTokens || null,
        latency_ms: fbTotalLatency,
        status_code: 200,
        error_type: null,
        tool_calls_made: fbToolCalls,
        retry_count: 0,
        quality_score: fbQualityScore,
        tokens_per_second: fbOutputTokens && fallbackLatency > 0 ? fbOutputTokens / (fallbackLatency / 1000) : null,
        cost_usd: fbCostUsd,
        request_text: captureRequestText(body),
        response_text: captureResponseText(fallbackResult.json),
        base_tier: routingResult.base_tier ?? null,
        escalation_source: routingResult.escalation_source ?? null,
        propensity: routingResult.propensity ?? null,
        candidates: routingResult.candidates ?? null,
        pinned: routingResult.pinned ? 1 : 0,
        switch_reason: routingResult.switch_reason ?? null,
      });

      // WS5.4 — feedback loop (fallback success). The served provider
      // isn't the one the router picked, so the bandit reward records the
      // fallback outcome under the original arm — which is the honest
      // signal for future picks of that arm.
      recordFeedbackOutcome({
        routingResult,
        body,
        outcome: {
          qualityScore: fbQualityScore,
          costUsd: fbCostUsd,
          latencyMs: fbTotalLatency,
          statusCode: 200,
          errorType: null,
          wasFallback: true,
        },
      });

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

      const dfLatencyMs = Date.now() - startTime;

      // Record double-failure telemetry
      telemetry.record({
        request_id: crypto.randomUUID(),
        session_id: body._sessionId || null,
        timestamp: Date.now(),
        complexity_score: routingResult.score ?? null,
        tier: routingDecision.tier,
        provider: fallbackProvider,
        model: routingDecision.model ?? body._tierModel ?? null,
        routing_method: "fallback",
        was_fallback: true,
        latency_ms: dfLatencyMs,
        status_code: fallbackErr.status || null,
        error_type: fallbackErr.code || fallbackErr.name || "double_failure",
        quality_score: 0,
        base_tier: routingResult.base_tier ?? null,
        escalation_source: routingResult.escalation_source ?? null,
        propensity: routingResult.propensity ?? null,
        candidates: routingResult.candidates ?? null,
        pinned: routingResult.pinned ? 1 : 0,
        switch_reason: routingResult.switch_reason ?? null,
      });

      // WS5.4 — feedback loop (double failure). quality=0 is a hard
      // negative exemplar; the kNN index will learn to steer away from
      // this arm for similar queries.
      recordFeedbackOutcome({
        routingResult,
        body,
        outcome: {
          qualityScore: 0,
          costUsd: null,
          latencyMs: dfLatencyMs,
          statusCode: fallbackErr.status || null,
          errorType: fallbackErr.code || fallbackErr.name || "double_failure",
          wasFallback: true,
        },
      });

      logger.error({
        originalProvider: initialProvider,
        fallbackProvider,
        originalError: err.message,
        fallbackError: fallbackErr.message,
      }, "Both primary and fallback provider failed");

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
  stripLynkrBadges,
  destroyHttpAgents,
  normalizeBodyForConverse,
  _stripInternalFields,
};
