const assert = require("assert");
const { describe, it, beforeEach, afterEach } = require("node:test");

describe("Azure OpenAI Integration Tests", () => {
  let originalConfig;

  beforeEach(() => {
    // Clear module cache
    delete require.cache[require.resolve("../src/config")];
    delete require.cache[require.resolve("../src/clients/databricks")];
    delete require.cache[require.resolve("../src/observability/metrics")];

    // Store original config
    originalConfig = { ...process.env };

    // Set default provider to avoid validation errors
    process.env.MODEL_PROVIDER = "databricks";
    process.env.DATABRICKS_API_KEY = "test-key";
    process.env.DATABRICKS_API_BASE = "http://test.com";

    // Prevent .env TIER_* values from being picked up by dotenv
    process.env.TIER_SIMPLE = "";
    process.env.TIER_MEDIUM = "";
    process.env.TIER_COMPLEX = "";
    process.env.TIER_REASONING = "";
  });

  afterEach(() => {
    // Restore original environment
    process.env = originalConfig;
  });

  describe("End-to-End Request Flow", () => {
    it("should construct valid Azure OpenAI request URL", () => {
      process.env.AZURE_OPENAI_ENDPOINT = "https://test-resource.openai.azure.com";
      process.env.AZURE_OPENAI_DEPLOYMENT = "gpt-4o";
      process.env.AZURE_OPENAI_API_VERSION = "2024-08-01-preview";

      const config = require("../src/config");

      const expectedURL = `${config.azureOpenAI.endpoint}/openai/deployments/${config.azureOpenAI.deployment}/chat/completions?api-version=${config.azureOpenAI.apiVersion}`;

      assert.strictEqual(
        expectedURL,
        "https://test-resource.openai.azure.com/openai/deployments/gpt-4o/chat/completions?api-version=2024-08-01-preview"
      );
    });

    it("should construct valid request headers with api-key", () => {
      process.env.AZURE_OPENAI_API_KEY = "test-api-key-12345";

      const config = require("../src/config");

      const headers = {
        "api-key": config.azureOpenAI.apiKey,
        "Content-Type": "application/json"
      };

      assert.strictEqual(headers["api-key"], "test-api-key-12345");
      assert.strictEqual(headers["Content-Type"], "application/json");
    });

    it("should construct request body with messages and tools", () => {
      const { convertAnthropicMessagesToOpenRouter, convertAnthropicToolsToOpenRouter } = require("../src/clients/openrouter-utils");

      const anthropicMessages = [
        { role: "user", content: "Read /app/test.js" }
      ];

      const anthropicTools = [
        {
          name: "Read",
          description: "Read file",
          input_schema: {
            type: "object",
            properties: { file_path: { type: "string" } },
            required: ["file_path"]
          }
        }
      ];

      const messages = convertAnthropicMessagesToOpenRouter(anthropicMessages);
      const tools = convertAnthropicToolsToOpenRouter(anthropicTools);

      const requestBody = {
        messages,
        tools,
        temperature: 0.7,
        max_tokens: 4096,
        stream: false
      };

      assert.ok(Array.isArray(requestBody.messages));
      assert.strictEqual(requestBody.messages[0].content, "Read /app/test.js");
      assert.ok(Array.isArray(requestBody.tools));
      assert.strictEqual(requestBody.tools[0].function.name, "Read");
    });
  });

  describe("Tool Calling Round Trip", () => {
    it("should handle complete tool calling flow", () => {
      const { convertAnthropicToolsToOpenRouter, convertOpenRouterResponseToAnthropic } = require("../src/clients/openrouter-utils");

      // Step 1: Convert Anthropic tools to Azure OpenAI format
      const anthropicTools = [
        {
          name: "Bash",
          description: "Execute bash command",
          input_schema: {
            type: "object",
            properties: { command: { type: "string" } },
            required: ["command"]
          }
        }
      ];

      const azureTools = convertAnthropicToolsToOpenRouter(anthropicTools);

      assert.strictEqual(azureTools[0].type, "function");
      assert.strictEqual(azureTools[0].function.name, "Bash");

      // Step 2: Simulate Azure OpenAI response with tool call
      const azureResponse = {
        choices: [
          {
            message: {
              role: "assistant",
              content: "I'll run that command",
              tool_calls: [
                {
                  id: "call_123",
                  type: "function",
                  function: {
                    name: "Bash",
                    arguments: '{"command":"ls -la"}'
                  }
                }
              ]
            },
            finish_reason: "tool_calls"
          }
        ],
        usage: {
          prompt_tokens: 50,
          completion_tokens: 20
        }
      };

      // Step 3: Convert Azure OpenAI response to Anthropic format
      const anthropicResponse = convertOpenRouterResponseToAnthropic(azureResponse, "gpt-4o");

      assert.strictEqual(anthropicResponse.role, "assistant");
      assert.strictEqual(anthropicResponse.stop_reason, "tool_use");

      const textContent = anthropicResponse.content.find(c => c.type === "text");
      const toolUse = anthropicResponse.content.find(c => c.type === "tool_use");

      assert.strictEqual(textContent.text, "I'll run that command");
      assert.strictEqual(toolUse.name, "Bash");
      assert.deepStrictEqual(toolUse.input, { command: "ls -la" });
    });
  });

  describe("Provider Selection Integration", () => {
    it("should select azure-openai as primary provider", () => {
      process.env.MODEL_PROVIDER = "azure-openai";
      process.env.AZURE_OPENAI_ENDPOINT = "https://test.openai.azure.com";
      process.env.AZURE_OPENAI_API_KEY = "test-key";

      const config = require("../src/config");

      assert.strictEqual(config.modelProvider.type, "azure-openai");
      assert.strictEqual(config.azureOpenAI.endpoint, "https://test.openai.azure.com");
      assert.strictEqual(config.azureOpenAI.apiKey, "test-key");
    });

    it("should select azure-openai as fallback provider", () => {
      process.env.MODEL_PROVIDER = "ollama";
      process.env.OLLAMA_ENDPOINT = "http://localhost:11434";
      process.env.OLLAMA_MODEL = "qwen2.5-coder:latest";
      process.env.FALLBACK_ENABLED = "true";
      process.env.FALLBACK_PROVIDER = "azure-openai";
      process.env.AZURE_OPENAI_ENDPOINT = "https://test.openai.azure.com";
      process.env.AZURE_OPENAI_API_KEY = "test-key";
      process.env.DATABRICKS_API_KEY = "test-key";
      process.env.DATABRICKS_API_BASE = "http://test.com";

      const config = require("../src/config");

      assert.strictEqual(config.modelProvider.fallbackProvider, "azure-openai");
      assert.strictEqual(config.modelProvider.fallbackEnabled, true);
    });
  });

  describe("Response Conversion Integration", () => {
    it("should handle text-only response conversion", () => {
      const { convertOpenRouterResponseToAnthropic } = require("../src/clients/openrouter-utils");

      const azureResponse = {
        id: "chatcmpl-abc123",
        object: "chat.completion",
        created: 1677652288,
        model: "gpt-4o",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "The file contains JavaScript code for a web server."
            },
            finish_reason: "stop"
          }
        ],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 50,
          total_tokens: 150
        }
      };

      const anthropicResponse = convertOpenRouterResponseToAnthropic(azureResponse, "gpt-4o");

      assert.strictEqual(anthropicResponse.role, "assistant");
      assert.strictEqual(anthropicResponse.stop_reason, "end_turn");
      assert.strictEqual(anthropicResponse.model, "gpt-4o");
      assert.strictEqual(anthropicResponse.usage.input_tokens, 100);
      assert.strictEqual(anthropicResponse.usage.output_tokens, 50);
      assert.strictEqual(anthropicResponse.content[0].type, "text");
      assert.strictEqual(anthropicResponse.content[0].text, "The file contains JavaScript code for a web server.");
    });

    it("should handle multi-turn conversation", () => {
      const { convertAnthropicMessagesToOpenRouter } = require("../src/clients/openrouter-utils");

      const anthropicMessages = [
        { role: "user", content: "What is 2+2?" },
        { role: "assistant", content: [{ type: "text", text: "2+2 equals 4." }] },
        { role: "user", content: "What about 3+3?" }
      ];

      const azureMessages = convertAnthropicMessagesToOpenRouter(anthropicMessages);

      assert.strictEqual(azureMessages.length, 3);
      assert.strictEqual(azureMessages[0].role, "user");
      assert.strictEqual(azureMessages[0].content, "What is 2+2?");
      assert.strictEqual(azureMessages[1].role, "assistant");
      assert.strictEqual(azureMessages[1].content, "2+2 equals 4.");
      assert.strictEqual(azureMessages[2].role, "user");
      assert.strictEqual(azureMessages[2].content, "What about 3+3?");
    });
  });

  describe("Multiple Deployments Support", () => {
    it("should support gpt-4o deployment", () => {
      process.env.AZURE_OPENAI_DEPLOYMENT = "gpt-4o";
      process.env.MODEL_PROVIDER = "databricks";
      process.env.DATABRICKS_API_KEY = "test-key";
      process.env.DATABRICKS_API_BASE = "http://test.com";

      const config = require("../src/config");

      assert.strictEqual(config.azureOpenAI.deployment, "gpt-4o");
    });

    it("should support gpt-5 deployment", () => {
      process.env.AZURE_OPENAI_DEPLOYMENT = "gpt-5";
      process.env.MODEL_PROVIDER = "databricks";
      process.env.DATABRICKS_API_KEY = "test-key";
      process.env.DATABRICKS_API_BASE = "http://test.com";

      const config = require("../src/config");

      assert.strictEqual(config.azureOpenAI.deployment, "gpt-5");
    });

    it("should support custom deployment names", () => {
      process.env.AZURE_OPENAI_DEPLOYMENT = "my-custom-gpt-5-codex";
      process.env.MODEL_PROVIDER = "databricks";
      process.env.DATABRICKS_API_KEY = "test-key";
      process.env.DATABRICKS_API_BASE = "http://test.com";

      const config = require("../src/config");

      assert.strictEqual(config.azureOpenAI.deployment, "my-custom-gpt-5-codex");
    });
  });
});
