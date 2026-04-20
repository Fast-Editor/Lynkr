/**
 * OpenAI API Compatibility Router
 *
 * Implements OpenAI API endpoints for Cursor IDE compatibility.
 * Routes:
 *   - POST /v1/chat/completions - Chat API with streaming support
 *   - GET /v1/models - List available models
 *   - POST /v1/embeddings - Generate embeddings (via OpenRouter or OpenAI)
 *   - GET /v1/health - Health check
 *
 * Note: If MODEL_PROVIDER=openrouter, the same OPENROUTER_API_KEY is used
 * for both chat completions and embeddings - no additional configuration needed.
 *
 * @module api/openai-router
 */

const express = require("express");
const logger = require("../logger");
const config = require("../config");
const orchestrator = require("../orchestrator");
const { getSession } = require("../sessions");
const {
  convertOpenAIToAnthropic,
  convertAnthropicToOpenAI
} = require("../clients/openai-format");
const { IDE_SAFE_TOOLS } = require("../clients/standard-tools");

const router = express.Router();

/**
 * Resolve the model name for OpenAI responses.
 * In OpenClaw mode, returns the actual provider/model from routing metadata.
 */
function resolveResponseModel(resultBody, requestModel) {
  if (config.openclaw?.enabled && resultBody?._routingMeta) {
    const meta = resultBody._routingMeta;
    if (meta.provider && meta.model) {
      return `${meta.provider}/${meta.model}`;
    }
    if (meta.provider) {
      return meta.provider;
    }
  }
  return requestModel;
}

/**
 * Client detection - identifies which AI coding tool is making the request
 * @param {Object} headers - Request headers
 * @returns {string} Client type: 'codex', 'cline', 'continue', or 'unknown'
 */
function detectClient(headers) {
  const userAgent = (headers?.["user-agent"] || "").toLowerCase();
  const clientHeader = (headers?.["x-client"] || headers?.["x-client-name"] || "").toLowerCase();

  // Check user-agent and custom headers
  if (userAgent.includes("codex") || clientHeader.includes("codex") || userAgent.includes("openai-codex")) {
    return "codex";
  }
  // Kilo Code is a fork of Cline - check for both
  if (userAgent.includes("kilo") || clientHeader.includes("kilo")) {
    return "kilo";
  }
  if (userAgent.includes("cline") || clientHeader.includes("cline") || userAgent.includes("claude-dev")) {
    return "cline";
  }
  if (userAgent.includes("continue") || clientHeader.includes("continue")) {
    return "continue";
  }

  return "unknown";
}

/**
 * Tool mappings for different AI coding clients
 * Each client has different tool names and parameter schemas
 */
const CLIENT_TOOL_MAPPINGS = {
  // ============== CODEX CLI ==============
  // Codex v0.121.0 only recognises "shell" and "apply_patch" as built-in
  // tools.  All other operations (read, list, grep, etc.) must go through
  // shell commands — the model handles this naturally.
  codex: {
    "Bash": {
      name: "shell",
      mapArgs: (a) => ({
        command: ["bash", "-c", a.command || ""]
      })
    },
    "Edit": {
      name: "apply_patch",
      mapArgs: (a) => ({
        path: a.file_path || a.path || "",
        old_string: a.old_string || "",
        new_string: a.new_string || ""
      })
    }
  },

  // ============== CLINE (VS Code Extension) ==============
  // Tools: execute_command, read_file, write_to_file, replace_in_file, search_files, list_files
  cline: {
    "Bash": {
      name: "execute_command",
      mapArgs: (a) => ({
        command: a.command || "",
        requires_approval: false
      })
    },
    "Read": {
      name: "read_file",
      mapArgs: (a) => ({
        path: a.file_path || a.path || ""
      })
    },
    "Write": {
      name: "write_to_file",
      mapArgs: (a) => ({
        path: a.file_path || a.path || "",
        content: a.content || ""
      })
    },
    "Edit": {
      name: "replace_in_file",
      mapArgs: (a) => ({
        path: a.file_path || a.path || "",
        old_str: a.old_string || "",
        new_str: a.new_string || ""
      })
    },
    "Glob": {
      name: "list_files",
      mapArgs: (a) => ({
        path: a.path || ".",
        recursive: true
      })
    },
    "Grep": {
      name: "search_files",
      mapArgs: (a) => ({
        path: a.path || ".",
        regex: a.pattern || "",
        file_pattern: a.glob || "*"
      })
    },
    "ListDir": {
      name: "list_files",
      mapArgs: (a) => ({
        path: a.path || a.directory || ".",
        recursive: false
      })
    },
    "WebAgent": {
      name: "web_agent",
      mapArgs: (a) => ({
        url: a.url || "",
        goal: a.goal || ""
      })
    }
  },

  // ============== KILO CODE (Fork of Cline) ==============
  // Tools: execute_command, read_file, write_to_file, apply_diff, list_files, search_files, codebase_search
  kilo: {
    "Bash": {
      name: "execute_command",
      mapArgs: (a) => ({
        command: a.command || "",
        requires_approval: false
      })
    },
    "Read": {
      name: "read_file",
      mapArgs: (a) => ({
        path: a.file_path || a.path || ""
      })
    },
    "Write": {
      name: "write_to_file",
      mapArgs: (a) => ({
        path: a.file_path || a.path || "",
        content: a.content || ""
      })
    },
    "Edit": {
      name: "apply_diff",
      mapArgs: (a) => ({
        path: a.file_path || a.path || "",
        diff: a.old_string && a.new_string
          ? `--- a/${a.file_path || a.path}\n+++ b/${a.file_path || a.path}\n@@ -1 +1 @@\n-${a.old_string}\n+${a.new_string}`
          : ""
      })
    },
    "Glob": {
      name: "list_files",
      mapArgs: (a) => ({
        path: a.path || ".",
        recursive: true
      })
    },
    "Grep": {
      name: "search_files",
      mapArgs: (a) => ({
        path: a.path || ".",
        regex: a.pattern || "",
        file_pattern: a.glob || "*"
      })
    },
    "ListDir": {
      name: "list_files",
      mapArgs: (a) => ({
        path: a.path || a.directory || ".",
        recursive: false
      })
    },
    "WebAgent": {
      name: "web_agent",
      mapArgs: (a) => ({
        url: a.url || "",
        goal: a.goal || ""
      })
    }
  },

  // ============== CONTINUE.DEV ==============
  // Tools: read_file, create_new_file, exact_search, read_currently_open_file
  continue: {
    "Bash": {
      name: "run_terminal_command",
      mapArgs: (a) => ({
        command: a.command || ""
      })
    },
    "Read": {
      name: "read_file",
      mapArgs: (a) => ({
        filepath: a.file_path || a.path || ""
      })
    },
    "Write": {
      name: "create_new_file",
      mapArgs: (a) => ({
        filepath: a.file_path || a.path || "",
        contents: a.content || ""
      })
    },
    "Edit": {
      name: "edit_existing_file",
      mapArgs: (a) => ({
        filepath: a.file_path || a.path || "",
        old_string: a.old_string || "",
        new_string: a.new_string || ""
      })
    },
    "Glob": {
      name: "exact_search",
      mapArgs: (a) => ({
        query: a.pattern || ""
      })
    },
    "Grep": {
      name: "exact_search",
      mapArgs: (a) => ({
        query: a.pattern || ""
      })
    },
    "ListDir": {
      name: "read_file",
      mapArgs: (a) => ({
        filepath: a.path || a.directory || "."
      })
    },
    "WebAgent": {
      name: "web_agent",
      mapArgs: (a) => ({
        url: a.url || "",
        goal: a.goal || ""
      })
    }
  }
};

/**
 * Map Lynkr tool names and arguments to client-specific equivalents
 * @param {string} toolName - Lynkr tool name
 * @param {string} argsJson - JSON string of tool arguments
 * @param {string} clientType - Client type (codex, cline, continue)
 * @returns {{ name: string, arguments: string }} Mapped tool name and arguments
 */
function mapToolForClient(toolName, argsJson, clientType) {
  let args = {};
  try {
    args = JSON.parse(argsJson || "{}");
  } catch (e) {
    args = {};
  }

  const clientMappings = CLIENT_TOOL_MAPPINGS[clientType];
  if (!clientMappings) {
    // Unknown client - return as-is
    return { name: toolName, arguments: argsJson };
  }

  const mapping = clientMappings[toolName];
  if (mapping) {
    const mappedArgs = mapping.mapArgs(args);
    // Remove undefined values
    Object.keys(mappedArgs).forEach(key => {
      if (mappedArgs[key] === undefined) {
        delete mappedArgs[key];
      }
    });
    return {
      name: mapping.name,
      arguments: JSON.stringify(mappedArgs)
    };
  }

  // No mapping found - return as-is (lowercase for convention)
  return {
    name: toolName.toLowerCase(),
    arguments: argsJson
  };
}



/**
 * POST /v1/chat/completions
 *
 * OpenAI-compatible chat completions endpoint.
 * Converts OpenAI format → Anthropic → processes → converts back to OpenAI format.
 */
router.post("/chat/completions", async (req, res) => {
  const startTime = Date.now();
  const sessionId = req.headers["x-session-id"] || req.headers["authorization"]?.split(" ")[1] || "openai-session";

  try {
    // Validate request body exists
    if (!req.body || typeof req.body !== 'object') {
      logger.error({ body: req.body, bodyType: typeof req.body }, "Invalid or missing request body");
      return res.status(400).json({
        error: {
          message: "Invalid or missing request body",
          type: "invalid_request_error",
          code: "invalid_body"
        }
      });
    }

    // Validate required fields
    if (!req.body.messages || !Array.isArray(req.body.messages)) {
      logger.error({ hasMessages: !!req.body.messages }, "Missing or invalid messages array");
      return res.status(400).json({
        error: {
          message: "Missing required field: messages (must be an array)",
          type: "invalid_request_error",
          code: "missing_messages"
        }
      });
    }

    // DEBUG: Log full message details to diagnose Codex caching issue
    const messagesSummary = (req.body.messages || []).map((m, i) => ({
      index: i,
      role: m.role,
      contentPreview: typeof m.content === 'string'
        ? m.content.substring(0, 200)
        : JSON.stringify(m.content).substring(0, 200)
    }));

    logger.debug({
      endpoint: "/v1/chat/completions",
      model: req.body.model,
      messageCount: req.body.messages?.length,
      stream: req.body.stream || false,
      hasTools: !!req.body.tools,
      toolCount: req.body.tools?.length || 0,
      hasMessages: !!req.body.messages,
      messagesType: typeof req.body.messages,
      requestBodyKeys: Object.keys(req.body),
      // Log first 500 chars of body for debugging
      requestBodyPreview: JSON.stringify(req.body).substring(0, 500),
      // DEBUG: Full messages breakdown
      messages: messagesSummary
    }, "=== OPENAI CHAT COMPLETION REQUEST ===");

    // Convert OpenAI request to Anthropic format
    const anthropicRequest = convertOpenAIToAnthropic(req.body);

    // Inject tools if client didn't send any.
    // Two-layer filtering:
    //   1. IDE_SAFE_TOOLS = STANDARD_TOOLS minus AskUserQuestion (can't work through proxy)
    //   2. For known clients (codex, cline, etc.), further filter to only tools
    //      that have a mapping in CLIENT_TOOL_MAPPINGS — this ensures clients like
    //      Codex don't see tools they can't handle (Task, WebFetch, NotebookEdit)
    //      while Claude Code (unknown client) gets the full IDE_SAFE_TOOLS set.
    // Skip injection if client explicitly opted out (tool_choice: "none" or empty tools array).
    const clientType = detectClient(req.headers);
    const clientExplicitlyDisabledTools = req.body.tool_choice === "none" || Array.isArray(req.body.tools);
    if (!clientExplicitlyDisabledTools && (!anthropicRequest.tools || anthropicRequest.tools.length === 0)) {
      const clientMappings = CLIENT_TOOL_MAPPINGS[clientType];
      let clientTools = clientMappings
        ? IDE_SAFE_TOOLS.filter(t => clientMappings[t.name])
        : IDE_SAFE_TOOLS;
      anthropicRequest.tools = clientTools;
      logger.debug({
        clientType,
        injectedToolCount: clientTools.length,
        injectedToolNames: clientTools.map(t => t.name),
        reason: clientMappings
          ? `Known client '${clientType}' — filtered to mapped tools only`
          : "Unknown client — injecting full IDE_SAFE_TOOLS"
      }, "=== INJECTING TOOLS ===");
    }

    // Get or create session
    const session = getSession(sessionId);

    // Handle streaming vs non-streaming
    if (req.body.stream) {
      // Set up SSE headers for streaming
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no"); // Prevent nginx buffering
      res.flushHeaders(); // Ensure headers are sent immediately

      try {
        // For streaming, we need to handle it differently - convert to non-streaming temporarily
        // Get non-streaming response from orchestrator
        anthropicRequest.stream = false; // Force non-streaming from orchestrator

        const result = await orchestrator.processMessage({
          payload: anthropicRequest,
          headers: req.headers,
          session: session,
          options: {
            maxSteps: req.body?.max_steps
          }
        });

        // Check if we have a valid response body
        logger.debug({
          hasResult: !!result,
          resultKeys: result ? Object.keys(result) : null,
          hasBody: result && !!result.body,
          bodyType: result && result.body ? typeof result.body : null,
          bodyKeys: result && result.body ? Object.keys(result.body) : null,
          status: result?.status,
          terminationReason: result?.terminationReason
        }, "=== ORCHESTRATOR RESULT STRUCTURE ===");

        if (!result || !result.body) {
          logger.error({
            result: result ? JSON.stringify(result).substring(0, 500) : "null",
            resultKeys: result ? Object.keys(result) : null
          }, "Invalid orchestrator response for streaming");
          throw new Error("Invalid response from orchestrator");
        }

        // Convert to OpenAI format
        const streamModel = resolveResponseModel(result.body, req.body.model);
        const openaiResponse = convertAnthropicToOpenAI(result.body, streamModel);

        // Debug: Log what we're about to stream
        logger.debug({
          openaiResponseId: openaiResponse.id,
          messageContent: openaiResponse.choices[0]?.message?.content?.substring(0, 100),
          contentLength: openaiResponse.choices[0]?.message?.content?.length || 0,
          finishReason: openaiResponse.choices[0]?.finish_reason,
          hasToolCalls: !!openaiResponse.choices[0]?.message?.tool_calls,
          resultBodyKeys: Object.keys(result.body || {}),
          resultBodyContent: JSON.stringify(result.body?.content)?.substring(0, 200)
        }, "=== PREPARING TO STREAM ===");

        // Simulate streaming by sending the complete response as chunks
        const content = openaiResponse.choices[0].message.content || "";
        let toolCalls = openaiResponse.choices[0].message.tool_calls;

        // Map tool names for known IDE clients
        if (clientType !== "unknown" && toolCalls && toolCalls.length > 0) {
          toolCalls = toolCalls.map(tc => {
            const mapped = mapToolForClient(tc.function?.name || "", tc.function?.arguments || "{}", clientType);
            return {
              ...tc,
              function: {
                name: mapped.name,
                arguments: mapped.arguments
              }
            };
          });
          logger.debug({
            mappedTools: toolCalls.map(t => t.function?.name),
            clientType
          }, "Tool names mapped for streaming chat/completions");
        }

        // Send start chunk with role
        const startChunk = {
          id: openaiResponse.id,
          object: "chat.completion.chunk",
          created: openaiResponse.created,
          model: streamModel,
          system_fingerprint: "fp_lynkr",
          choices: [{
            index: 0,
            delta: { role: "assistant", content: "" },
            logprobs: null,
            finish_reason: null
          }]
        };

        logger.debug({ chunk: "start", contentLength: content.length }, "Sending start chunk");
        const startWriteOk = res.write(`data: ${JSON.stringify(startChunk)}\n\n`);
        if (!startWriteOk) {
          logger.warn("Start chunk write returned false (backpressure)");
        }

        // Send content in a single chunk (or character by character for true streaming simulation)
        if (content) {
          const contentChunk = {
            id: openaiResponse.id,
            object: "chat.completion.chunk",
            created: openaiResponse.created,
            model: streamModel,
            system_fingerprint: "fp_lynkr",
            choices: [{
              index: 0,
              delta: { content: content },
              logprobs: null,
              finish_reason: null
            }]
          };
          const contentWriteOk = res.write(`data: ${JSON.stringify(contentChunk)}\n\n`);
          logger.debug({ contentPreview: content.substring(0, 50), writeOk: contentWriteOk }, "Sent content chunk");
        }

        // Send tool calls if present
        if (toolCalls && toolCalls.length > 0) {
          for (const toolCall of toolCalls) {
            const toolChunk = {
              id: openaiResponse.id,
              object: "chat.completion.chunk",
              created: openaiResponse.created,
              model: streamModel,
              choices: [{
                index: 0,
                delta: {
                  tool_calls: [{
                    index: 0,
                    id: toolCall.id,
                    type: "function",
                    function: {
                      name: toolCall.function.name,
                      arguments: toolCall.function.arguments
                    }
                  }]
                },
                finish_reason: null
              }]
            };
            res.write(`data: ${JSON.stringify(toolChunk)}\n\n`);
            logger.debug({ toolName: toolCall.function.name }, "Sent tool call chunk");
          }
        }

        // Send finish chunk
        const finishChunk = {
          id: openaiResponse.id,
          object: "chat.completion.chunk",
          created: openaiResponse.created,
          model: streamModel,
          system_fingerprint: "fp_lynkr",
          choices: [{
            index: 0,
            delta: {},
            logprobs: null,
            finish_reason: openaiResponse.choices[0].finish_reason
          }]
        };

        logger.debug({ chunk: "finish", finishReason: openaiResponse.choices[0].finish_reason }, "Sending finish chunk");
        res.write(`data: ${JSON.stringify(finishChunk)}\n\n`);
        res.write("data: [DONE]\n\n");

        // Ensure data is flushed before ending
        logger.debug({ contentLength: content.length, contentPreview: content.substring(0, 50) }, "=== SSE STREAM COMPLETE ===");
        res.end();

        logger.info({
          duration: Date.now() - startTime,
          mode: "streaming",
          inputTokens: openaiResponse.usage.prompt_tokens,
          outputTokens: openaiResponse.usage.completion_tokens
        }, "OpenAI streaming completed");

      } catch (streamError) {
        logger.error({
          error: streamError.message,
          stack: streamError.stack
        }, "=== STREAMING ERROR ===");

        // Send error in OpenAI streaming format
        const errorChunk = {
          id: `chatcmpl-error-${Date.now()}`,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: req.body.model,
          choices: [{
            index: 0,
            delta: {
              role: "assistant",
              content: `Error: ${streamError.message}`
            },
            finish_reason: "stop"
          }]
        };

        res.write(`data: ${JSON.stringify(errorChunk)}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
      }
    } else {
      // Non-streaming mode
      const result = await orchestrator.processMessage({
        payload: anthropicRequest,
        headers: req.headers,
        session: session,
        options: {
          maxSteps: req.body?.max_steps
        }
      });

      // Debug logging
      logger.debug({
        resultKeys: Object.keys(result || {}),
        hasBody: !!result?.body,
        bodyType: typeof result?.body,
        bodyKeys: result?.body ? Object.keys(result.body) : null
      }, "Orchestrator result structure");

      // Convert Anthropic response to OpenAI format
      const openaiResponse = convertAnthropicToOpenAI(result.body, resolveResponseModel(result.body, req.body.model));

      // Map tool names for known IDE clients
      if (clientType !== "unknown" && openaiResponse.choices?.[0]?.message?.tool_calls?.length > 0) {
        openaiResponse.choices[0].message.tool_calls = openaiResponse.choices[0].message.tool_calls.map(tc => {
          const mapped = mapToolForClient(tc.function?.name || "", tc.function?.arguments || "{}", clientType);
          return {
            ...tc,
            function: {
              name: mapped.name,
              arguments: mapped.arguments
            }
          };
        });
        logger.debug({
          mappedTools: openaiResponse.choices[0].message.tool_calls.map(t => t.function?.name),
          clientType
        }, "Tool names mapped for non-streaming chat/completions");
      }

      logger.info({
        duration: Date.now() - startTime,
        mode: "non-streaming",
        inputTokens: openaiResponse.usage.prompt_tokens,
        outputTokens: openaiResponse.usage.completion_tokens,
        finishReason: openaiResponse.choices[0].finish_reason
      }, "=== OPENAI CHAT COMPLETION RESPONSE ===");

      res.json(openaiResponse);
    }

  } catch (error) {
    logger.error({
      error: error.message,
      stack: error.stack,
      duration: Date.now() - startTime
    }, "OpenAI chat completion error");

    // Return OpenAI-format error
    res.status(500).json({
      error: {
        message: error.message || "Internal server error",
        type: "server_error",
        code: "internal_error"
      }
    });
  }
});

/**
 * Get all configured providers with their models (cc-relay style)
 * Reads from config (which comes from .env) to discover what's available
 */
function getConfiguredProviders() {
  const providers = [];
  const timestamp = Math.floor(Date.now() / 1000);

  // Check Databricks
  if (config.databricks?.url && config.databricks?.apiKey) {
    providers.push({
      name: "databricks",
      type: "databricks",
      models: [
        "claude-sonnet-4.5",
        "claude-opus-4.5",
        config.modelProvider?.defaultModel || "databricks-claude-sonnet-4-5"
      ]
    });
  }

  // Check AWS Bedrock
  if (config.bedrock?.apiKey) {
    const bedrockModels = [config.bedrock.modelId];
    if (config.bedrock.modelId?.includes("claude")) {
      bedrockModels.push(
        "anthropic.claude-3-5-sonnet-20241022-v2:0",
        "anthropic.claude-3-opus-20240229-v1:0",
        "anthropic.claude-3-haiku-20240307-v1:0"
      );
    }
    providers.push({
      name: "bedrock",
      type: "aws-bedrock",
      models: [...new Set(bedrockModels)]
    });
  }

  // Check Azure Anthropic
  if (config.azureAnthropic?.endpoint && config.azureAnthropic?.apiKey) {
    providers.push({
      name: "azure-anthropic",
      type: "azure-anthropic",
      models: ["claude-3-5-sonnet", "claude-opus-4.5"]
    });
  }

  // Check Azure OpenAI
  if (config.azureOpenAI?.endpoint && config.azureOpenAI?.apiKey) {
    providers.push({
      name: "azure-openai",
      type: "azure-openai",
      models: [
        config.azureOpenAI.deployment || "gpt-4o",
        "gpt-4o",
        "gpt-4-turbo",
        "gpt-4",
        "gpt-3.5-turbo"
      ]
    });
  }

  // Check OpenAI
  if (config.openai?.apiKey) {
    providers.push({
      name: "openai",
      type: "openai",
      models: [
        config.openai.model || "gpt-4o",
        "gpt-4o",
        "gpt-4o-mini",
        "gpt-4-turbo"
      ]
    });
  }

  // Check OpenRouter
  if (config.openrouter?.apiKey) {
    providers.push({
      name: "openrouter",
      type: "openrouter",
      models: [
        config.openrouter.model || "openai/gpt-4o-mini",
        "anthropic/claude-3.5-sonnet",
        "openai/gpt-4o",
        "openai/gpt-4o-mini",
        "nvidia/nemotron-3-nano-30b-a3b:free"
      ]
    });
  }

  // Check Ollama
  if (config.ollama?.endpoint) {
    providers.push({
      name: "ollama",
      type: "ollama",
      models: [config.ollama.model || "qwen2.5-coder:7b"]
    });
  }

  // Check llama.cpp
  if (config.llamacpp?.endpoint) {
    providers.push({
      name: "llamacpp",
      type: "llama.cpp",
      models: [config.llamacpp.model || "default"]
    });
  }

  // Check LM Studio
  if (config.lmstudio?.endpoint) {
    providers.push({
      name: "lmstudio",
      type: "lm-studio",
      models: [config.lmstudio.model || "default"]
    });
  }

  // Check Z.AI (Zhipu)
  if (config.zai?.apiKey) {
    providers.push({
      name: "zai",
      type: "zhipu-ai",
      models: [
        config.zai.model || "GLM-4.7",
        "GLM-4.7",
        "GLM-4.5-Air",
        "GLM-4-Plus"
      ]
    });
  }

  // Check Moonshot AI (Kimi)
  if (config.moonshot?.apiKey) {
    providers.push({
      name: "moonshot",
      type: "moonshot-ai",
      models: [
        config.moonshot.model || "kimi-k2-turbo-preview",
        "kimi-k2-turbo-preview"
      ]
    });
  }

  // Check Vertex AI (Google Cloud)
  if (config.vertex?.projectId) {
    providers.push({
      name: "vertex",
      type: "google-vertex-ai",
      models: [
        config.vertex.model || "claude-sonnet-4-5@20250514",
        "claude-sonnet-4-5@20250514",
        "claude-opus-4-5@20250514",
        "claude-haiku-4-5@20251001"
      ]
    });
  }

  return providers;
}

/**
 * GET /v1/models
 *
 * List available models from ALL configured providers (cc-relay style).
 * Returns OpenAI-compatible model list with provider field.
 */
router.get("/models", (req, res) => {
  try {
    const providers = getConfiguredProviders();
    const primaryProvider = config.modelProvider?.type || "databricks";
    const timestamp = Math.floor(Date.now() / 1000);
    const models = [];
    const seenModelIds = new Set();

    // Collect models from all providers
    for (const provider of providers) {
      for (const modelId of provider.models) {
        // Create unique key to avoid duplicates
        const uniqueKey = `${provider.name}:${modelId}`;
        if (seenModelIds.has(uniqueKey)) continue;
        seenModelIds.add(uniqueKey);

        models.push({
          id: modelId,
          object: "model",
          created: timestamp,
          owned_by: provider.type,
          provider: provider.name,  // cc-relay style: include provider name
          permission: [],
          root: modelId,
          parent: null
        });
      }
    }

    // Add embedding models if embeddings are configured
    const embeddingConfig = determineEmbeddingProvider();
    if (embeddingConfig) {
      let embeddingModelId;
      switch (embeddingConfig.provider) {
        case "llamacpp":
          embeddingModelId = "text-embedding-3-small";
          break;
        case "ollama":
          embeddingModelId = embeddingConfig.model;
          break;
        case "openrouter":
          embeddingModelId = embeddingConfig.model;
          break;
        case "openai":
          embeddingModelId = embeddingConfig.model || "text-embedding-ada-002";
          break;
        default:
          embeddingModelId = "text-embedding-3-small";
      }

      const uniqueKey = `${embeddingConfig.provider}:${embeddingModelId}`;
      if (!seenModelIds.has(uniqueKey)) {
        models.push({
          id: embeddingModelId,
          object: "model",
          created: timestamp,
          owned_by: embeddingConfig.provider,
          provider: embeddingConfig.provider,
          permission: [],
          root: embeddingModelId,
          parent: null
        });
      }
    }

    logger.debug({
      providerCount: providers.length,
      modelCount: models.length,
      models: models.map(m => ({ id: m.id, provider: m.provider })),
      hasEmbeddings: !!embeddingConfig
    }, "Listed models for OpenAI API (cc-relay style)");

    res.json({
      object: "list",
      data: models
    });

  } catch (error) {
    logger.error({ error: error.message }, "Error listing models");
    res.status(500).json({
      error: {
        message: error.message || "Failed to list models",
        type: "server_error",
        code: "internal_error"
      }
    });
  }
});

/**
 * Determine which provider to use for embeddings
 * Priority:
 *   1. Explicit EMBEDDINGS_PROVIDER env var
 *   2. Same provider as MODEL_PROVIDER (if it supports embeddings)
 *   3. First available: OpenRouter > OpenAI > Ollama > llama.cpp
 */
function determineEmbeddingProvider(requestedModel = null) {
  const explicitProvider = process.env.EMBEDDINGS_PROVIDER?.trim();

  // Priority 1: Explicit configuration
  if (explicitProvider) {
    switch (explicitProvider) {
      case "ollama":
        if (!config.ollama?.embeddingsModel) {
          logger.warn("EMBEDDINGS_PROVIDER=ollama but OLLAMA_EMBEDDINGS_MODEL not set");
          return null;
        }
        return {
          provider: "ollama",
          model: requestedModel || config.ollama.embeddingsModel,
          endpoint: config.ollama.embeddingsEndpoint
        };

      case "llamacpp":
        if (!config.llamacpp?.embeddingsEndpoint) {
          logger.warn("EMBEDDINGS_PROVIDER=llamacpp but LLAMACPP_EMBEDDINGS_ENDPOINT not set");
          return null;
        }
        return {
          provider: "llamacpp",
          model: requestedModel || "default",
          endpoint: config.llamacpp.embeddingsEndpoint
        };

      case "openrouter":
        if (!config.openrouter?.apiKey) {
          logger.warn("EMBEDDINGS_PROVIDER=openrouter but OPENROUTER_API_KEY not set");
          return null;
        }
        return {
          provider: "openrouter",
          model: requestedModel || config.openrouter.embeddingsModel,
          apiKey: config.openrouter.apiKey,
          endpoint: "https://openrouter.ai/api/v1/embeddings"
        };

      case "openai":
        if (!config.openai?.apiKey) {
          logger.warn("EMBEDDINGS_PROVIDER=openai but OPENAI_API_KEY not set");
          return null;
        }
        return {
          provider: "openai",
          model: requestedModel || "text-embedding-ada-002",
          apiKey: config.openai.apiKey,
          endpoint: "https://api.openai.com/v1/embeddings"
        };
    }
  }

  // Priority 2: Same as chat provider (if supported)
  const chatProvider = config.modelProvider?.type;

  if (chatProvider === "openrouter" && config.openrouter?.apiKey) {
    return {
      provider: "openrouter",
      model: requestedModel || config.openrouter.embeddingsModel,
      apiKey: config.openrouter.apiKey,
      endpoint: "https://openrouter.ai/api/v1/embeddings"
    };
  }

  if (chatProvider === "ollama" && config.ollama?.embeddingsModel) {
    return {
      provider: "ollama",
      model: requestedModel || config.ollama.embeddingsModel,
      endpoint: config.ollama.embeddingsEndpoint
    };
  }

  if (chatProvider === "llamacpp" && config.llamacpp?.embeddingsEndpoint) {
    return {
      provider: "llamacpp",
      model: requestedModel || "default",
      endpoint: config.llamacpp.embeddingsEndpoint
    };
  }

  // Priority 3: First available provider
  if (config.openrouter?.apiKey) {
    return {
      provider: "openrouter",
      model: requestedModel || config.openrouter.embeddingsModel,
      apiKey: config.openrouter.apiKey,
      endpoint: "https://openrouter.ai/api/v1/embeddings"
    };
  }

  if (config.openai?.apiKey) {
    return {
      provider: "openai",
      model: requestedModel || "text-embedding-ada-002",
      apiKey: config.openai.apiKey,
      endpoint: "https://api.openai.com/v1/embeddings"
    };
  }

  if (config.ollama?.embeddingsModel) {
    return {
      provider: "ollama",
      model: requestedModel || config.ollama.embeddingsModel,
      endpoint: config.ollama.embeddingsEndpoint
    };
  }

  if (config.llamacpp?.embeddingsEndpoint) {
    return {
      provider: "llamacpp",
      model: requestedModel || "default",
      endpoint: config.llamacpp.embeddingsEndpoint
    };
  }

  return null; // No provider available
}

/**
 * Generate embeddings using Ollama
 * Note: Ollama only supports single prompt, not batch
 */
async function generateOllamaEmbeddings(inputs, embeddingConfig) {
  const { model, endpoint } = embeddingConfig;

  logger.debug({
    model,
    endpoint,
    inputCount: inputs.length
  }, "Generating embeddings with Ollama");

  // Ollama doesn't support batch, so we need to process one by one
  const embeddings = [];

  for (let i = 0; i < inputs.length; i++) {
    const input = inputs[i];

    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: model,
          prompt: input
        })
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Ollama embeddings error (${response.status}): ${errorText}`);
      }

      const data = await response.json();

      embeddings.push({
        object: "embedding",
        embedding: data.embedding,
        index: i
      });

    } catch (error) {
      logger.error({
        error: error.message,
        input: input.substring(0, 100),
        index: i
      }, "Failed to generate Ollama embedding");
      throw error;
    }
  }

  // Convert to OpenAI format
  return {
    object: "list",
    data: embeddings,
    model: model,
    usage: {
      prompt_tokens: 0, // Ollama doesn't provide this
      total_tokens: 0
    }
  };
}

/**
 * Generate embeddings using llama.cpp
 * llama.cpp uses OpenAI-compatible format, so minimal conversion needed
 */
async function generateLlamaCppEmbeddings(inputs, embeddingConfig) {
  const { model, endpoint } = embeddingConfig;

  logger.debug({
    model,
    endpoint,
    inputCount: inputs.length
  }, "Generating embeddings with llama.cpp");

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        input: inputs, // llama.cpp supports batch
        encoding_format: "float"
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`llama.cpp embeddings error (${response.status}): ${errorText}`);
    }

    const data = await response.json();

    // llama.cpp returns array format: [{index: 0, embedding: [[...]]}]
    // Need to convert to OpenAI format: {data: [{object: "embedding", embedding: [...], index: 0}]}
    let embeddingsData;

    if (Array.isArray(data)) {
      // llama.cpp returns array directly
      embeddingsData = data.map(item => ({
        object: "embedding",
        embedding: Array.isArray(item.embedding[0]) ? item.embedding[0] : item.embedding, // Flatten double-nested array
        index: item.index
      }));
    } else if (data.data) {
      // Already in OpenAI format
      embeddingsData = data.data;
    } else {
      embeddingsData = [];
    }

    return {
      object: "list",
      data: embeddingsData,
      model: model || data.model || "default",
      usage: data.usage || {
        prompt_tokens: 0,
        total_tokens: 0
      }
    };

  } catch (error) {
    logger.error({
      error: error.message,
      endpoint
    }, "Failed to generate llama.cpp embeddings");
    throw error;
  }
}

/**
 * Generate embeddings using OpenRouter
 */
async function generateOpenRouterEmbeddings(inputs, embeddingConfig) {
  const { model, apiKey, endpoint } = embeddingConfig;

  logger.debug({
    model,
    inputCount: inputs.length
  }, "Generating embeddings with OpenRouter");

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
      "HTTP-Referer": "https://github.com/vishalveerareddy123/Lynkr",
      "X-Title": "Lynkr"
    },
    body: JSON.stringify({
      model: model,
      input: inputs,
      encoding_format: "float"
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenRouter embeddings error (${response.status}): ${errorText}`);
  }

  return await response.json();
}

/**
 * Generate embeddings using OpenAI
 */
async function generateOpenAIEmbeddings(inputs, embeddingConfig) {
  const { model, apiKey, endpoint } = embeddingConfig;

  logger.debug({
    model,
    inputCount: inputs.length
  }, "Generating embeddings with OpenAI");

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: model,
      input: inputs,
      encoding_format: "float"
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenAI embeddings error (${response.status}): ${errorText}`);
  }

  return await response.json();
}

/**
 * POST /v1/embeddings
 *
 * Generate embeddings using configured provider (Ollama, llama.cpp, OpenRouter, or OpenAI).
 * Required for Cursor's semantic search features.
 */
router.post("/embeddings", async (req, res) => {
  const startTime = Date.now();

  try {
    const { input, model, encoding_format } = req.body;

    // Validate input
    if (!input) {
      return res.status(400).json({
        error: {
          message: "Missing required parameter: input",
          type: "invalid_request_error",
          code: "missing_parameter"
        }
      });
    }

    // Convert input to array if string
    const inputs = Array.isArray(input) ? input : [input];

    logger.debug({
      endpoint: "/v1/embeddings",
      model: model || "auto-detect",
      inputCount: inputs.length,
      inputLengths: inputs.map(i => i.length)
    }, "=== OPENAI EMBEDDINGS REQUEST ===");

    // Determine which provider to use for embeddings
    const embeddingConfig = determineEmbeddingProvider(model);

    if (!embeddingConfig) {
      logger.warn("No embedding provider configured");
      return res.status(501).json({
        error: {
          message: "Embeddings not configured. Set up one of: OPENROUTER_API_KEY, OPENAI_API_KEY, OLLAMA_EMBEDDINGS_MODEL, or LLAMACPP_EMBEDDINGS_ENDPOINT in your .env file to enable @Codebase semantic search.",
          type: "not_implemented",
          code: "embeddings_not_configured"
        }
      });
    }

    // Route to appropriate provider
    let embeddingResponse;

    try {
      switch (embeddingConfig.provider) {
        case "ollama":
          embeddingResponse = await generateOllamaEmbeddings(inputs, embeddingConfig);
          break;

        case "llamacpp":
          embeddingResponse = await generateLlamaCppEmbeddings(inputs, embeddingConfig);
          break;

        case "openrouter":
          embeddingResponse = await generateOpenRouterEmbeddings(inputs, embeddingConfig);
          break;

        case "openai":
          embeddingResponse = await generateOpenAIEmbeddings(inputs, embeddingConfig);
          break;

        default:
          throw new Error(`Unsupported embedding provider: ${embeddingConfig.provider}`);
      }
    } catch (error) {
      logger.error({
        error: error.message,
        provider: embeddingConfig.provider,
      }, "Embeddings generation failed");

      return res.status(500).json({
        error: {
          message: error.message || "Embeddings generation failed",
          type: "server_error",
          code: "embeddings_error"
        }
      });
    }

    logger.info({
      provider: embeddingConfig.provider,
      model: embeddingConfig.model,
      duration: Date.now() - startTime,
      embeddingCount: embeddingResponse.data?.length || 0,
      totalTokens: embeddingResponse.usage?.total_tokens || 0
    }, "=== EMBEDDINGS RESPONSE ===");

    // Return embeddings in OpenAI format
    res.json(embeddingResponse);

  } catch (error) {
    logger.error({
      error: error.message,
      stack: error.stack,
      duration: Date.now() - startTime
    }, "Embeddings error");

    res.status(500).json({
      error: {
        message: error.message || "Internal server error",
        type: "server_error",
        code: "internal_error"
      }
    });
  }
});

/**
 * POST /v1/responses
 *
 * OpenAI Responses API endpoint (used by GPT-5-Codex and newer models).
 * Converts Responses API format to Chat Completions → processes → converts back.
 */
router.post("/responses", async (req, res) => {
  const startTime = Date.now();
  const sessionId = req.headers["x-session-id"] || req.headers["authorization"]?.split(" ")[1] || "responses-session";

  try {
    const { convertResponsesToChat, convertChatToResponses } = require("../clients/responses-format");

    // Comprehensive debug logging
    logger.debug({
      endpoint: "/v1/responses",
      inputType: typeof req.body.input,
      inputIsArray: Array.isArray(req.body.input),
      inputLength: Array.isArray(req.body.input) ? req.body.input.length : req.body.input?.length,
      inputPreview: typeof req.body.input === 'string'
        ? req.body.input.substring(0, 100)
        : Array.isArray(req.body.input)
          ? req.body.input.map(m => ({role: m?.role, hasContent: !!m?.content, hasTool: !!m?.tool_calls}))
          : 'unknown',
      model: req.body.model,
      hasTools: !!req.body.tools,
      stream: req.body.stream || false,
      fullRequestBodyKeys: Object.keys(req.body)
    }, "=== RESPONSES API REQUEST ===");

    // Resolve previous_response_id for session continuity
    if (req.body.previous_response_id) {
      const responseStore = require("../stores/response-store");
      const prev = responseStore.getResponse(req.body.previous_response_id);
      if (prev && Array.isArray(prev.messages)) {
        const prevContext = [...prev.messages];
        if (prev.assistantContent) {
          prevContext.push({ role: "assistant", content: prev.assistantContent });
        }
        if (Array.isArray(req.body.input)) {
          req.body.input = [...prevContext, ...req.body.input];
        } else if (typeof req.body.input === "string") {
          req.body.input = [...prevContext, { role: "user", content: req.body.input }];
        }
        logger.debug({
          previousId: req.body.previous_response_id,
          prependedMessages: prevContext.length,
        }, "Resolved previous_response_id");
      } else {
        logger.warn({ previousId: req.body.previous_response_id }, "previous_response_id not found");
      }
    }

    // Convert Responses API to Chat Completions format
    const chatRequest = convertResponsesToChat(req.body);

    logger.debug({
      chatRequestMessageCount: chatRequest.messages?.length,
      chatRequestMessages: chatRequest.messages?.map(m => ({
        role: m.role,
        hasContent: !!m.content,
        contentPreview: typeof m.content === 'string' ? m.content.substring(0, 50) : m.content
      }))
    }, "After Responses→Chat conversion");

    // Convert to Anthropic format
    const anthropicRequest = convertOpenAIToAnthropic(chatRequest);

    // Normalize tool_use names in conversation history to client format.
    // Tool definitions are injected with client names (e.g., "shell", "read_file"),
    // so tool_use blocks must also use client names to satisfy the Anthropic API
    // requirement that tool_use names match tool definitions.
    const clientType = detectClient(req.headers);
    const clientMappings = CLIENT_TOOL_MAPPINGS[clientType];
    if (clientMappings && Array.isArray(anthropicRequest.messages)) {
      const lynkrToClient = {};
      for (const [lynkrName, mapping] of Object.entries(clientMappings)) {
        lynkrToClient[lynkrName] = mapping.name;
      }

      for (const msg of anthropicRequest.messages) {
        if (!Array.isArray(msg.content)) continue;
        for (const block of msg.content) {
          if (block.type === 'tool_use' && lynkrToClient[block.name]) {
            block.name = lynkrToClient[block.name];
          }
        }
      }
    }

    logger.debug({
      anthropicMessageCount: anthropicRequest.messages?.length,
      anthropicMessages: anthropicRequest.messages?.map(m => ({
        role: m.role,
        hasContent: !!m.content
      }))
    }, "After Chat→Anthropic conversion");

    // Inject tools if the Anthropic request has none.
    // The client may have sent tools in Responses API format (top-level name)
    // which convertOpenAIToAnthropic silently drops because it expects Chat
    // Completions format ({function: {name}}).  Always check the CONVERTED
    // result, not the raw request.
    const clientDisabledToolChoice = req.body.tool_choice === "none";
    if (!clientDisabledToolChoice && (!anthropicRequest.tools || anthropicRequest.tools.length === 0)) {
      // Exclude server-side-only tools (Task, web_search, etc.) from the
      // Responses endpoint — they can't be executed by external clients like
      // Codex and would be converted to broken shell echo commands.
      const RESPONSES_EXCLUDED_TOOLS = new Set(["Task", "AskUserQuestion", "TodoWrite", "WebSearch", "WebFetch", "WebAgent"]);
      const clientMappings = CLIENT_TOOL_MAPPINGS[clientType];
      let clientTools = (clientMappings
        ? IDE_SAFE_TOOLS.filter(t => clientMappings[t.name])
        : IDE_SAFE_TOOLS
      ).filter(t => !RESPONSES_EXCLUDED_TOOLS.has(t.name));

      // Rename tools to client-expected names so the model uses the right names
      // e.g., for Codex: "Read" → "read_file", "Bash" → "shell"
      // The lynkrToClient map above normalizes any stale Lynkr names in history
      if (clientMappings) {
        clientTools = clientTools.map(t => {
          const mapping = clientMappings[t.name];
          if (!mapping) return t;
          return {
            ...t,
            name: mapping.name,
            description: t.description || '',
          };
        });
      }

      anthropicRequest.tools = clientTools;
      logger.info({
        clientType,
        injectedToolCount: clientTools.length,
        injectedToolNames: clientTools.map(t => t.name),
        reason: clientMappings
          ? `Known client '${clientType}' — tools renamed to client conventions`
          : "Unknown client — injecting full IDE_SAFE_TOOLS"
      }, "=== INJECTING TOOLS (responses) ===");
    } else {
      logger.info({
        clientType,
        clientDisabledToolChoice,
        hasTools: !!anthropicRequest.tools,
        toolCount: anthropicRequest.tools?.length || 0,
        toolNames: anthropicRequest.tools?.map(t => t.name)?.slice(0, 10),
        reqToolChoice: req.body.tool_choice,
        reqToolsIsArray: Array.isArray(req.body.tools),
        reqToolsLength: req.body.tools?.length,
      }, "=== TOOLS NOT INJECTED (responses) ===");
    }

    // ALWAYS strip server-side-only tools from the Responses endpoint.
    // These can't be executed by external clients (Codex, etc.) and cause
    // infinite retry loops when the model keeps calling them.
    const RESPONSES_EXCLUDED = new Set(["Task", "AskUserQuestion", "TodoWrite", "WebSearch", "WebFetch", "WebAgent"]);
    if (Array.isArray(anthropicRequest.tools)) {
      anthropicRequest.tools = anthropicRequest.tools.filter(t => !RESPONSES_EXCLUDED.has(t.name));
    }

    // Snapshot tool names before the orchestrator can mutate them
    const injectedToolNames = new Set(
      (anthropicRequest.tools || []).map(t => t.name)
    );

    // Get session
    const session = getSession(sessionId);

    // Handle streaming vs non-streaming
    if (req.body.stream) {
      // Set up SSE headers for streaming
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");
      res.flushHeaders();

      try {
        anthropicRequest.stream = false;

        // SSE comment keepalive (spec-compliant, ignored by all clients)
        const keepalive = setInterval(() => {
          try { res.write(`: keepalive\n\n`); } catch {}
        }, 2000);

        let result;
        try {
          result = await orchestrator.processMessage({
            payload: anthropicRequest,
            headers: req.headers,
            session: session,
            options: {
              maxSteps: req.body?.max_steps
            }
          });
        } finally {
          clearInterval(keepalive);
        }

        logger.debug({
          hasResult: !!result,
          hasBody: !!result?.body,
          bodyContentLength: result?.body?.content?.length || 0,
          terminationReason: result?.terminationReason
        }, "=== ORCHESTRATOR RESULT FOR RESPONSES API ===");

        // Convert back: Anthropic → OpenAI → Responses
        const responsesModel = resolveResponseModel(result.body, req.body.model);

        // Guard: if orchestrator returned an error body, surface it as text
        if (result.body?.error || result.status >= 400) {
          const errMsg = result.body?.error?.message || result.body?.error || JSON.stringify(result.body);
          logger.warn({ status: result.status, error: errMsg }, "Orchestrator returned error for Responses API");
          const errChunks = [];
          const errSse = (ev, d) => { errChunks.push(`event: ${ev}\ndata: ${JSON.stringify(d)}\n\n`); };
          const errId = `resp_err_${Date.now()}`;
          errSse("response.created", { type: "response.created", response: { id: errId, object: "response", status: "in_progress", output: [], usage: null }, sequence_number: 0 });
          errSse("response.output_item.added", { type: "response.output_item.added", output_index: 0, item: { id: `msg_${Date.now()}`, type: "message", status: "in_progress", role: "assistant", content: [] }, sequence_number: 1 });
          errSse("response.output_text.delta", { type: "response.output_text.delta", item_id: `msg_${Date.now()}`, output_index: 0, content_index: 0, delta: `Error: ${errMsg}`, sequence_number: 2 });
          errSse("response.completed", { type: "response.completed", response: { id: errId, object: "response", status: "completed", output: [{ type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: `Error: ${errMsg}` }] }], usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } }, sequence_number: 3 });
          res.end(errChunks.join(""));
          return;
        }

        const chatResponse = convertAnthropicToOpenAI(result.body, responsesModel);
        const responsesResponse = convertChatToResponses(chatResponse);

        // Clean up tool result artifacts in content
        let content = responsesResponse.content || "";
        content = content.replace(/\{"output":"((?:[^"\\]|\\.)*)"\s*(?:,"metadata":\{[^}]*\})?\}/g, (match, output) => {
          try { return JSON.parse(`"${output}"`); } catch { return output; }
        });
        content = content.replace(/\\n/g, '\n').replace(/\\t/g, '\t');
        let toolCalls = chatResponse.choices?.[0]?.message?.tool_calls || [];

        const responseId = responsesResponse.id || `resp_${Date.now()}`;
        const messageId = `msg_${Date.now()}`;
        const createdAt = Math.floor(Date.now() / 1000);
        let sequenceNumber = 0;
        let outputIndex = 0;

        // Fallback: if model returned empty text AND no tool calls,
        // the model may have failed to produce output. Surface what we have.
        if (!content && toolCalls.length === 0) {
          const body = result.body;
          if (Array.isArray(body?.content)) {
            content = body.content
              .filter(b => b?.type === "text" && b?.text)
              .map(b => b.text)
              .join("\n") || "(The model returned an empty response.)";
          } else {
            content = "(The model returned an empty response.)";
          }
        }

        // Universal tool→shell converter: ensures every tool call becomes
        // a "shell" command that Codex (or any client) can execute.
        // Server-side tools (Task, WebSearch, etc.) are dropped entirely.
        if (toolCalls.length > 0) {
          const SERVER_TOOLS = new Set(["task", "websearch", "webfetch", "web_search", "web_fetch", "web_agent", "askuserquestion", "todowrite"]);
          const converted = [];
          for (const tc of toolCalls) {
            const name = tc.function?.name || "";
            const ln = name.toLowerCase();

            // Convert server-side tools to useful shell equivalents
            if (SERVER_TOOLS.has(ln)) {
              let exploreCmd = "ls -la && head -100 README.md 2>/dev/null && cat package.json 2>/dev/null && ls src/ 2>/dev/null";
              if (ln === "task") {
                try {
                  const taskArgs = JSON.parse(tc.function?.arguments || "{}");
                  if (taskArgs.prompt && taskArgs.prompt.toLowerCase().includes("read")) {
                    exploreCmd = "cat README.md 2>/dev/null && cat package.json 2>/dev/null";
                  }
                } catch {}
              }
              converted.push({ ...tc, function: { name: "shell", arguments: JSON.stringify({ command: ["bash", "-c", exploreCmd] }) } });
              continue;
            }

            let args = {};
            try { args = JSON.parse(tc.function?.arguments || "{}"); } catch {}

            // Already a shell command — normalise to array format
            if (ln === "shell" || ln === "bash") {
              let cmd = args.command || "";
              // Handle string-encoded arrays: '["bash","-c","ls"]'
              if (typeof cmd === "string" && cmd.trim().startsWith("[")) {
                try { cmd = JSON.parse(cmd); } catch {}
              }
              // Extract the actual command from ["bash", "-c", "actual command"]
              if (Array.isArray(cmd) && cmd.length >= 3 && cmd[0] === "bash" && cmd[1] === "-c") {
                converted.push({ ...tc, function: { name: "shell", arguments: JSON.stringify({ command: cmd }) } });
              } else if (Array.isArray(cmd)) {
                converted.push({ ...tc, function: { name: "shell", arguments: JSON.stringify({ command: ["bash", "-c", cmd.join(" ")] }) } });
              } else {
                converted.push({ ...tc, function: { name: "shell", arguments: JSON.stringify({ command: ["bash", "-c", String(cmd)] }) } });
              }
              continue;
            }

            // Convert known tools to equivalent shell commands
            let shellCmd = "";
            if (ln === "read" || ln === "read_file" || ln === "cat") {
              shellCmd = `cat ${args.file_path || args.path || args.file || ""}`;
            } else if (ln === "list_dir" || ln === "listdir" || ln === "ls") {
              shellCmd = `ls -la ${args.path || args.directory || "."}`;
            } else if (ln === "grep" || ln === "rg" || ln === "search" || ln === "search_files") {
              shellCmd = `grep -rn '${(args.pattern || args.query || "").replace(/'/g, "'\\''")}' ${args.path || "."}`;
            } else if (ln === "glob" || ln === "glob_file_search" || ln === "find") {
              shellCmd = `find ${args.path || "."} -name '${(args.pattern || "*").replace(/'/g, "'\\''")}'`;
            } else if (ln === "write" || ln === "write_file" || ln === "create_file") {
              const p = args.file_path || args.path || args.file || "/dev/null";
              shellCmd = `cat > '${p}' << 'LYNKR_EOF'\n${args.content || ""}\nLYNKR_EOF`;
            } else if (ln === "edit" || ln === "apply_patch" || ln === "replace_in_file") {
              converted.push({ ...tc, function: { name: "apply_patch", arguments: tc.function?.arguments || "{}" } });
              continue;
            } else {
              // Truly unknown tool — safe echo
              shellCmd = `echo 'Unknown tool: ${ln}'`;
            }

            converted.push({ ...tc, function: { name: "shell", arguments: JSON.stringify({ command: ["bash", "-c", shellCmd] }) } });
          }
          toolCalls = converted;

          // If somehow all tools were dropped with nothing left, provide a default exploration
          if (toolCalls.length === 0 && !content) {
            toolCalls.push({
              id: `call_${Date.now()}`,
              type: "function",
              function: { name: "shell", arguments: JSON.stringify({ command: ["bash", "-c", "ls -la && head -80 README.md 2>/dev/null"] }) }
            });
          }
        }

        // Build the entire SSE payload as a single buffer so the client
        // receives all events atomically (prevents premature disconnect).
        const chunks = [];
        const sse = (event, data) => {
          chunks.push(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        };

        // response.created
        sse("response.created", {
          type: "response.created",
          response: {
            id: responseId, object: "response", status: "in_progress",
            created_at: createdAt, model: responsesModel, output: [], usage: null
          },
          sequence_number: sequenceNumber++
        });

        // response.in_progress
        sse("response.in_progress", {
          type: "response.in_progress",
          response: {
            id: responseId, object: "response", status: "in_progress",
            created_at: createdAt, model: responsesModel, output: [], usage: null
          },
          sequence_number: sequenceNumber++
        });

        const outputItems = [];

        // Function call events
        for (const toolCall of toolCalls) {
          const toolCallId = toolCall.id || `call_${Date.now()}_${outputIndex}`;
          const functionName = toolCall.function?.name || "unknown";
          const functionArgs = toolCall.function?.arguments || "{}";

          const functionCallItem = {
            id: toolCallId, type: "function_call", status: "completed",
            name: functionName, arguments: functionArgs, call_id: toolCallId
          };

          sse("response.output_item.added", {
            type: "response.output_item.added", output_index: outputIndex,
            item: functionCallItem, sequence_number: sequenceNumber++
          });
          sse("response.function_call_arguments.delta", {
            type: "response.function_call_arguments.delta", item_id: toolCallId,
            output_index: outputIndex, delta: functionArgs, sequence_number: sequenceNumber++
          });
          sse("response.function_call_arguments.done", {
            type: "response.function_call_arguments.done", item_id: toolCallId,
            output_index: outputIndex, arguments: functionArgs, sequence_number: sequenceNumber++
          });
          sse("response.output_item.done", {
            type: "response.output_item.done", output_index: outputIndex,
            item: functionCallItem, sequence_number: sequenceNumber++
          });

          outputItems.push(functionCallItem);
          outputIndex++;
        }

        // Text content events
        if (content) {
          sse("response.output_item.added", {
            type: "response.output_item.added", output_index: outputIndex,
            item: { id: messageId, type: "message", status: "in_progress", role: "assistant", content: [] },
            sequence_number: sequenceNumber++
          });
          sse("response.content_part.added", {
            type: "response.content_part.added", item_id: messageId,
            output_index: outputIndex, content_index: 0,
            part: { type: "output_text", text: "" }, sequence_number: sequenceNumber++
          });

          const words = content.split(" ");
          for (let i = 0; i < words.length; i++) {
            const word = words[i] + (i < words.length - 1 ? " " : "");
            sse("response.output_text.delta", {
              type: "response.output_text.delta", item_id: messageId,
              output_index: outputIndex, content_index: 0,
              delta: word, sequence_number: sequenceNumber++
            });
          }

          sse("response.output_text.done", {
            type: "response.output_text.done", item_id: messageId,
            output_index: outputIndex, content_index: 0,
            text: content, sequence_number: sequenceNumber++
          });
          sse("response.content_part.done", {
            type: "response.content_part.done", item_id: messageId,
            output_index: outputIndex, content_index: 0,
            part: { type: "output_text", text: content }, sequence_number: sequenceNumber++
          });

          const messageItem = {
            id: messageId, type: "message", status: "completed", role: "assistant",
            content: [{ type: "output_text", text: content }]
          };
          sse("response.output_item.done", {
            type: "response.output_item.done", output_index: outputIndex,
            item: messageItem, sequence_number: sequenceNumber++
          });

          outputItems.push(messageItem);
          outputIndex++;
        }

        // response.completed (always last)
        sse("response.completed", {
          type: "response.completed",
          response: {
            id: responseId, object: "response", status: "completed",
            created_at: createdAt, model: responsesModel, output: outputItems,
            usage: {
              input_tokens: responsesResponse.usage?.prompt_tokens || 0,
              output_tokens: responsesResponse.usage?.completion_tokens || 0,
              total_tokens: responsesResponse.usage?.total_tokens || 0
            }
          },
          sequence_number: sequenceNumber++
        });

        // Write entire payload and close in one call
        const payload = chunks.join("");
        res.end(payload);

        // Store response for previous_response_id continuity
        try {
          const responseStore = require("../stores/response-store");
          responseStore.storeResponse(responseId, {
            messages: chatRequest?.messages || [],
            assistantContent: content || null,
          });
        } catch {}

        logger.info({
          duration: Date.now() - startTime,
          mode: "streaming",
          contentLength: content.length,
          toolCallCount: toolCalls.length,
          payloadBytes: payload.length
        }, "=== RESPONSES API STREAMING COMPLETE ===");

      } catch (streamError) {
        logger.error({ error: streamError.message, stack: streamError.stack }, "Responses API streaming error");

        // Build error as a complete SSE payload with response.completed
        const errorResponseId = `resp_err_${Date.now()}`;
        const errorPayload = [
          `event: response.created\ndata: ${JSON.stringify({
            type: "response.created",
            response: { id: errorResponseId, object: "response", status: "in_progress", output: [], usage: null },
            sequence_number: 0
          })}\n\n`,
          `event: response.completed\ndata: ${JSON.stringify({
            type: "response.completed",
            response: {
              id: errorResponseId, object: "response", status: "failed",
              output: [{ type: "message", role: "assistant", status: "completed",
                content: [{ type: "output_text", text: `Error: ${streamError.message || "Internal server error"}` }] }],
              usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 }
            },
            sequence_number: 1
          })}\n\n`
        ].join("");
        try { res.end(errorPayload); } catch { try { res.end(); } catch {} }
      }

    } else {
      // Non-streaming response
      anthropicRequest.stream = false;

      const result = await orchestrator.processMessage({
        payload: anthropicRequest,
        headers: req.headers,
        session: session,
        options: {
          maxSteps: req.body?.max_steps
        }
      });

      // Convert back: Anthropic → OpenAI → Responses
      const chatResponse = convertAnthropicToOpenAI(result.body, resolveResponseModel(result.body, req.body.model));
      const responsesResponse = convertChatToResponses(chatResponse);

      // Clean up tool result artifacts in content
      if (responsesResponse.content) {
        responsesResponse.content = responsesResponse.content
          .replace(/\{"output":"((?:[^"\\]|\\.)*)"\s*(?:,"metadata":\{[^}]*\})?\}/g, (match, output) => {
            try { return JSON.parse(`"${output}"`); } catch { return output; }
          })
          .replace(/\\n/g, '\n')
          .replace(/\\t/g, '\t');
      }

      logger.info({
        duration: Date.now() - startTime,
        contentLength: responsesResponse.content?.length || 0,
        stopReason: responsesResponse.stop_reason
      }, "=== RESPONSES API RESPONSE ===");

      res.json(responsesResponse);
    }

  } catch (error) {
    logger.error({
      error: error.message,
      stack: error.stack,
      duration: Date.now() - startTime
    }, "Responses API error");

    res.status(500).json({
      error: {
        message: error.message || "Internal server error",
        type: "server_error",
        code: "internal_error"
      }
    });
  }
});

/**
 * GET /v1/health
 *
 * Health check endpoint (alias to /health/ready).
 * Used by Cursor to verify connection.
 */
router.get("/health", (req, res) => {
  res.json({
    status: "ok",
    provider: config.modelProvider?.type || "databricks",
    openai_compatible: true,
    cursor_compatible: true,
    timestamp: new Date().toISOString()
  });
});

module.exports = router;
