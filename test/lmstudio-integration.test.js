const assert = require("assert");
const { describe, it, beforeEach, afterEach } = require("node:test");

describe("LM Studio Integration", () => {
  let originalEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };

    // Clear module cache
    delete require.cache[require.resolve("../src/config")];
    delete require.cache[require.resolve("../src/clients/routing")];
    delete require.cache[require.resolve("../src/clients/openrouter-utils")];

    // Prevent .env TIER_* values from being picked up by dotenv
    process.env.TIER_SIMPLE = "";
    process.env.TIER_MEDIUM = "";
    process.env.TIER_COMPLEX = "";
    process.env.TIER_REASONING = "";
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe("Configuration", () => {
    it("should accept lmstudio as a valid MODEL_PROVIDER", () => {
      process.env.MODEL_PROVIDER = "lmstudio";
      process.env.LMSTUDIO_ENDPOINT = "http://localhost:1234";

      const config = require("../src/config");
      assert.strictEqual(config.modelProvider.type, "lmstudio");
    });

    it("should use default endpoint when LMSTUDIO_ENDPOINT is not set", () => {
      process.env.MODEL_PROVIDER = "lmstudio";
      delete process.env.LMSTUDIO_ENDPOINT;

      const config = require("../src/config");
      assert.strictEqual(config.lmstudio.endpoint, "http://localhost:1234");
    });

    it("should use custom endpoint when LMSTUDIO_ENDPOINT is set", () => {
      process.env.MODEL_PROVIDER = "lmstudio";
      process.env.LMSTUDIO_ENDPOINT = "http://192.168.1.100:9000";

      const config = require("../src/config");
      assert.strictEqual(config.lmstudio.endpoint, "http://192.168.1.100:9000");
    });

    it("should throw error when LMSTUDIO_ENDPOINT is invalid URL", () => {
      process.env.MODEL_PROVIDER = "lmstudio";
      process.env.LMSTUDIO_ENDPOINT = "not-a-valid-url";

      assert.throws(
        () => require("../src/config"),
        /LMSTUDIO_ENDPOINT must be a valid URL/
      );
    });

    it("should use default model when LMSTUDIO_MODEL is not set", () => {
      process.env.MODEL_PROVIDER = "lmstudio";
      delete process.env.LMSTUDIO_MODEL;

      const config = require("../src/config");
      assert.strictEqual(config.lmstudio.model, "default");
    });

    it("should use custom model when LMSTUDIO_MODEL is set", () => {
      process.env.MODEL_PROVIDER = "lmstudio";
      process.env.LMSTUDIO_MODEL = "hermes-2-pro-llama-3-8b";

      const config = require("../src/config");
      assert.strictEqual(config.lmstudio.model, "hermes-2-pro-llama-3-8b");
    });

    it("should use default timeout when LMSTUDIO_TIMEOUT_MS is not set", () => {
      process.env.MODEL_PROVIDER = "lmstudio";
      delete process.env.LMSTUDIO_TIMEOUT_MS;

      const config = require("../src/config");
      assert.strictEqual(config.lmstudio.timeout, 120000);
    });

    it("should use custom timeout when LMSTUDIO_TIMEOUT_MS is set", () => {
      process.env.MODEL_PROVIDER = "lmstudio";
      process.env.LMSTUDIO_TIMEOUT_MS = "300000";

      const config = require("../src/config");
      assert.strictEqual(config.lmstudio.timeout, 300000);
    });

    it("should have null apiKey when LMSTUDIO_API_KEY is not set", () => {
      process.env.MODEL_PROVIDER = "lmstudio";
      delete process.env.LMSTUDIO_API_KEY;

      const config = require("../src/config");
      assert.strictEqual(config.lmstudio.apiKey, null);
    });

    it("should store apiKey when LMSTUDIO_API_KEY is set", () => {
      process.env.MODEL_PROVIDER = "lmstudio";
      process.env.LMSTUDIO_API_KEY = "my-secret-key";

      const config = require("../src/config");
      assert.strictEqual(config.lmstudio.apiKey, "my-secret-key");
    });
  });

  describe("Routing", () => {
    it("should route to lmstudio when MODEL_PROVIDER is lmstudio", () => {
      process.env.MODEL_PROVIDER = "lmstudio";
      process.env.LMSTUDIO_ENDPOINT = "http://localhost:1234";

      const config = require("../src/config");
      const routing = require("../src/clients/routing");

      const payload = { messages: [{ role: "user", content: "test" }] };
      const provider = routing.determineProviderSync(payload);

      assert.strictEqual(provider, "lmstudio");
    });

    it("should return static routing from determineProviderSmart when tiers disabled", async () => {
      process.env.MODEL_PROVIDER = "lmstudio";
      process.env.LMSTUDIO_ENDPOINT = "http://localhost:1234";

      const config = require("../src/config");
      const routing = require("../src/clients/routing");

      const payload = { messages: [{ role: "user", content: "test" }] };
      const result = await routing.determineProviderSmart(payload);

      assert.strictEqual(result.provider, "lmstudio");
      assert.strictEqual(result.method, "static");
      assert.strictEqual(result.reason, "tier_routing_disabled");
    });

    it("should throw error when lmstudio is set as FALLBACK_PROVIDER", () => {
      process.env.MODEL_PROVIDER = "ollama";
      process.env.OLLAMA_MODEL = "qwen2.5-coder:latest";
      process.env.FALLBACK_PROVIDER = "lmstudio";
      process.env.LMSTUDIO_ENDPOINT = "http://localhost:1234";
      process.env.FALLBACK_ENABLED = "true";

      assert.throws(
        () => require("../src/config"),
        /FALLBACK_PROVIDER cannot be 'lmstudio'/
      );
    });
  });

  describe("Response Conversion", () => {
    // LM Studio uses OpenAI-compatible format, so we reuse the same converter

    it("should convert LM Studio text response to Anthropic format", () => {
      process.env.MODEL_PROVIDER = "databricks";
      process.env.DATABRICKS_API_KEY = "test-key";
      process.env.DATABRICKS_API_BASE = "http://test.com";

      const { convertOpenRouterResponseToAnthropic } = require("../src/clients/openrouter-utils");

      const lmstudioResponse = {
        id: "chatcmpl-123",
        object: "chat.completion",
        created: 1677652288,
        model: "hermes-2-pro-llama-3-8b",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "Hello! I'm running on LM Studio."
            },
            finish_reason: "stop"
          }
        ],
        usage: {
          prompt_tokens: 9,
          completion_tokens: 12,
          total_tokens: 21
        }
      };

      const result = convertOpenRouterResponseToAnthropic(lmstudioResponse, "claude-sonnet-4-5");

      assert.strictEqual(result.role, "assistant");
      assert.strictEqual(result.model, "claude-sonnet-4-5");
      assert.strictEqual(Array.isArray(result.content), true);
      assert.strictEqual(result.content.length, 1);
      assert.strictEqual(result.content[0].type, "text");
      assert.strictEqual(result.content[0].text, "Hello! I'm running on LM Studio.");
      assert.strictEqual(result.stop_reason, "end_turn");
      assert.strictEqual(result.usage.input_tokens, 9);
      assert.strictEqual(result.usage.output_tokens, 12);
    });

    it("should convert LM Studio tool call response to Anthropic format", () => {
      process.env.MODEL_PROVIDER = "databricks";
      process.env.DATABRICKS_API_KEY = "test-key";
      process.env.DATABRICKS_API_BASE = "http://test.com";

      const { convertOpenRouterResponseToAnthropic } = require("../src/clients/openrouter-utils");

      const lmstudioResponse = {
        id: "chatcmpl-123",
        object: "chat.completion",
        model: "hermes-2-pro-llama-3-8b",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "I'll read that file for you.",
              tool_calls: [
                {
                  id: "call_abc123",
                  type: "function",
                  function: {
                    name: "Read",
                    arguments: JSON.stringify({
                      file_path: "/tmp/example.txt"
                    })
                  }
                }
              ]
            },
            finish_reason: "tool_calls"
          }
        ],
        usage: {
          prompt_tokens: 50,
          completion_tokens: 30,
          total_tokens: 80
        }
      };

      const result = convertOpenRouterResponseToAnthropic(lmstudioResponse, "claude-sonnet-4-5");

      assert.strictEqual(result.role, "assistant");
      assert.strictEqual(result.content.length, 2); // text + tool_use
      assert.strictEqual(result.content[0].type, "text");
      assert.strictEqual(result.content[0].text, "I'll read that file for you.");
      assert.strictEqual(result.content[1].type, "tool_use");
      assert.strictEqual(result.content[1].name, "Read");
      assert.strictEqual(result.content[1].id, "call_abc123");
      assert.deepStrictEqual(result.content[1].input, {
        file_path: "/tmp/example.txt"
      });
      assert.strictEqual(result.stop_reason, "tool_use");
    });
  });

  describe("Message Conversion", () => {
    it("should convert Anthropic messages to LM Studio (OpenAI) format", () => {
      process.env.MODEL_PROVIDER = "databricks";
      process.env.DATABRICKS_API_KEY = "test-key";
      process.env.DATABRICKS_API_BASE = "http://test.com";

      const { convertAnthropicMessagesToOpenRouter } = require("../src/clients/openrouter-utils");

      const anthropicMessages = [
        {
          role: "user",
          content: [
            { type: "text", text: "What is 2 + 2?" }
          ]
        },
        {
          role: "assistant",
          content: [
            { type: "text", text: "2 + 2 equals 4." }
          ]
        }
      ];

      const result = convertAnthropicMessagesToOpenRouter(anthropicMessages);

      assert.strictEqual(result.length, 2);
      assert.strictEqual(result[0].role, "user");
      assert.strictEqual(result[0].content, "What is 2 + 2?");
      assert.strictEqual(result[1].role, "assistant");
      assert.strictEqual(result[1].content, "2 + 2 equals 4.");
    });
  });

  describe("Tool Conversion", () => {
    it("should convert Anthropic tools to LM Studio (OpenAI) format", () => {
      process.env.MODEL_PROVIDER = "databricks";
      process.env.DATABRICKS_API_KEY = "test-key";
      process.env.DATABRICKS_API_BASE = "http://test.com";

      const { convertAnthropicToolsToOpenRouter } = require("../src/clients/openrouter-utils");

      const anthropicTools = [
        {
          name: "Read",
          description: "Read a file from disk",
          input_schema: {
            type: "object",
            properties: {
              file_path: { type: "string", description: "Path to the file" }
            },
            required: ["file_path"]
          }
        }
      ];

      const result = convertAnthropicToolsToOpenRouter(anthropicTools);

      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].type, "function");
      assert.strictEqual(result[0].function.name, "Read");
      assert.strictEqual(result[0].function.description, "Read a file from disk");
      assert.deepStrictEqual(result[0].function.parameters, {
        type: "object",
        properties: {
          file_path: { type: "string", description: "Path to the file" }
        },
        required: ["file_path"]
      });
    });
  });

  describe("Fallback Prevention", () => {
    it("should prevent lmstudio from being used as fallback provider", () => {
      process.env.MODEL_PROVIDER = "ollama";
      process.env.OLLAMA_MODEL = "qwen2.5-coder:latest";
      process.env.FALLBACK_PROVIDER = "lmstudio";
      process.env.LMSTUDIO_ENDPOINT = "http://localhost:1234";
      process.env.FALLBACK_ENABLED = "true";

      assert.throws(
        () => require("../src/config"),
        /FALLBACK_PROVIDER cannot be 'lmstudio' \(local providers should not be fallbacks\)/
      );
    });

    it("should allow lmstudio as primary provider", () => {
      process.env.MODEL_PROVIDER = "lmstudio";
      process.env.LMSTUDIO_ENDPOINT = "http://localhost:1234";

      const config = require("../src/config");
      assert.strictEqual(config.modelProvider.type, "lmstudio");
    });
  });
});
