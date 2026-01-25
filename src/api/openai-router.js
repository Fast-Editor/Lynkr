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
  convertAnthropicToOpenAI,
  convertAnthropicStreamChunkToOpenAI
} = require("../clients/openai-format");

const router = express.Router();

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
    logger.info({
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
      requestBodyPreview: JSON.stringify(req.body).substring(0, 500)
    }, "=== OPENAI CHAT COMPLETION REQUEST ===");

    // Convert OpenAI request to Anthropic format
    const anthropicRequest = convertOpenAIToAnthropic(req.body);

    // Get or create session
    const session = getSession(sessionId);

    // Handle streaming vs non-streaming
    if (req.body.stream) {
      // Set up SSE headers for streaming
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");

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
        if (!result || !result.body) {
          logger.error({
            result: result ? JSON.stringify(result) : "null",
            resultKeys: result ? Object.keys(result) : null
          }, "Invalid orchestrator response for streaming");
          throw new Error("Invalid response from orchestrator");
        }

        // Convert to OpenAI format
        const openaiResponse = convertAnthropicToOpenAI(result.body, req.body.model);

        // Simulate streaming by sending the complete response as chunks
        const content = openaiResponse.choices[0].message.content || "";
        const words = content.split(" ");

        // Send start chunk
        const startChunk = {
          id: openaiResponse.id,
          object: "chat.completion.chunk",
          created: openaiResponse.created,
          model: req.body.model,
          choices: [{
            index: 0,
            delta: { role: "assistant", content: "" },
            finish_reason: null
          }]
        };
        res.write(`data: ${JSON.stringify(startChunk)}\n\n`);

        // Send content in word chunks
        for (let i = 0; i < words.length; i++) {
          const word = words[i] + (i < words.length - 1 ? " " : "");
          const chunk = {
            id: openaiResponse.id,
            object: "chat.completion.chunk",
            created: openaiResponse.created,
            model: req.body.model,
            choices: [{
              index: 0,
              delta: { content: word },
              finish_reason: null
            }]
          };
          res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        }

        // Send finish chunk
        const finishChunk = {
          id: openaiResponse.id,
          object: "chat.completion.chunk",
          created: openaiResponse.created,
          model: req.body.model,
          choices: [{
            index: 0,
            delta: {},
            finish_reason: openaiResponse.choices[0].finish_reason
          }]
        };
        res.write(`data: ${JSON.stringify(finishChunk)}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();

        logger.info({
          duration: Date.now() - startTime,
          mode: "streaming",
          inputTokens: openaiResponse.usage.prompt_tokens,
          outputTokens: openaiResponse.usage.completion_tokens
        }, "OpenAI streaming completed");

      } catch (streamError) {
        logger.error({ error: streamError.message, stack: streamError.stack }, "Streaming error");

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
      const openaiResponse = convertAnthropicToOpenAI(result.body, req.body.model);

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

  logger.info({
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

  logger.info({
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

  logger.info({
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

  logger.info({
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

    logger.info({
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
    logger.info({
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

    // Convert Responses API to Chat Completions format
    const chatRequest = convertResponsesToChat(req.body);

    logger.info({
      chatRequestMessageCount: chatRequest.messages?.length,
      chatRequestMessages: chatRequest.messages?.map(m => ({
        role: m.role,
        hasContent: !!m.content,
        contentPreview: typeof m.content === 'string' ? m.content.substring(0, 50) : m.content
      }))
    }, "After Responses→Chat conversion");

    // Convert to Anthropic format
    const anthropicRequest = convertOpenAIToAnthropic(chatRequest);

    logger.info({
      anthropicMessageCount: anthropicRequest.messages?.length,
      anthropicMessages: anthropicRequest.messages?.map(m => ({
        role: m.role,
        hasContent: !!m.content
      }))
    }, "After Chat→Anthropic conversion");

    // Get session
    const session = getSession(sessionId);

    // Handle streaming vs non-streaming
    if (req.body.stream) {
      // Set up SSE headers for streaming
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");

      try {
        // Force non-streaming from orchestrator
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
        const chatResponse = convertAnthropicToOpenAI(result.body, req.body.model);
        const responsesResponse = convertChatToResponses(chatResponse);

        // Simulate streaming using OpenAI Responses API SSE format
        const content = responsesResponse.content || "";
        const words = content.split(" ");

        // Send response.created event
        const createdEvent = {
          id: responsesResponse.id,
          object: "response.created",
          created: responsesResponse.created,
          model: req.body.model
        };
        res.write(`event: response.created\n`);
        res.write(`data: ${JSON.stringify(createdEvent)}\n\n`);

        // Send content in word chunks using response.output_text.delta
        for (let i = 0; i < words.length; i++) {
          const word = words[i] + (i < words.length - 1 ? " " : "");
          const deltaEvent = {
            id: responsesResponse.id,
            object: "response.output_text.delta",
            delta: word,
            created: responsesResponse.created
          };
          res.write(`event: response.output_text.delta\n`);
          res.write(`data: ${JSON.stringify(deltaEvent)}\n\n`);
        }

        // Send response.completed event
        const completedEvent = {
          id: responsesResponse.id,
          object: "response.completed",
          created: responsesResponse.created,
          model: req.body.model,
          content: content,
          stop_reason: responsesResponse.stop_reason,
          usage: responsesResponse.usage
        };
        res.write(`event: response.completed\n`);
        res.write(`data: ${JSON.stringify(completedEvent)}\n\n`);

        // Optional: Send [DONE] marker
        res.write("data: [DONE]\n\n");
        res.end();

        logger.info({
          duration: Date.now() - startTime,
          mode: "streaming",
          contentLength: content.length
        }, "=== RESPONSES API STREAMING COMPLETE ===");

      } catch (streamError) {
        logger.error({ error: streamError.message, stack: streamError.stack }, "Responses API streaming error");

        // Send error via SSE
        res.write(`data: ${JSON.stringify({
          error: {
            message: streamError.message || "Internal server error",
            type: "server_error",
            code: "internal_error"
          }
        })}\n\n`);
        res.end();
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
      const chatResponse = convertAnthropicToOpenAI(result.body, req.body.model);
      const responsesResponse = convertChatToResponses(chatResponse);

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
