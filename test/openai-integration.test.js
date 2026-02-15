const assert = require("assert");
const { describe, it, beforeEach, afterEach } = require("node:test");

describe("OpenAI Integration", () => {
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
    it("should accept openai as a valid MODEL_PROVIDER", () => {
      process.env.MODEL_PROVIDER = "openai";
      process.env.OPENAI_API_KEY = "sk-test-key";

      const config = require("../src/config");
      assert.strictEqual(config.modelProvider.type, "openai");
    });

    it("should throw error when OPENAI_API_KEY is missing", () => {
      process.env.MODEL_PROVIDER = "openai";
      delete process.env.OPENAI_API_KEY;

      assert.throws(
        () => require("../src/config"),
        /Set OPENAI_API_KEY before starting the proxy/
      );
    });

    it("should use default model when OPENAI_MODEL is not set", () => {
      process.env.MODEL_PROVIDER = "openai";
      process.env.OPENAI_API_KEY = "sk-test-key";
      delete process.env.OPENAI_MODEL;

      const config = require("../src/config");
      assert.strictEqual(config.openai.model, "gpt-4o");
    });

    it("should use custom model when OPENAI_MODEL is set", () => {
      process.env.MODEL_PROVIDER = "openai";
      process.env.OPENAI_API_KEY = "sk-test-key";
      process.env.OPENAI_MODEL = "gpt-4o-mini";

      const config = require("../src/config");
      assert.strictEqual(config.openai.model, "gpt-4o-mini");
    });

    it("should use default endpoint when OPENAI_ENDPOINT is not set", () => {
      process.env.MODEL_PROVIDER = "openai";
      process.env.OPENAI_API_KEY = "sk-test-key";
      delete process.env.OPENAI_ENDPOINT;

      const config = require("../src/config");
      assert.strictEqual(config.openai.endpoint, "https://api.openai.com/v1/chat/completions");
    });

    it("should use custom endpoint when OPENAI_ENDPOINT is set", () => {
      process.env.MODEL_PROVIDER = "openai";
      process.env.OPENAI_API_KEY = "sk-test-key";
      process.env.OPENAI_ENDPOINT = "https://custom.openai.com/v1/chat/completions";

      const config = require("../src/config");
      assert.strictEqual(config.openai.endpoint, "https://custom.openai.com/v1/chat/completions");
    });

    it("should store organization when OPENAI_ORGANIZATION is set", () => {
      process.env.MODEL_PROVIDER = "openai";
      process.env.OPENAI_API_KEY = "sk-test-key";
      process.env.OPENAI_ORGANIZATION = "org-test123";

      const config = require("../src/config");
      assert.strictEqual(config.openai.organization, "org-test123");
    });

    it("should have null organization when OPENAI_ORGANIZATION is not set", () => {
      process.env.MODEL_PROVIDER = "openai";
      process.env.OPENAI_API_KEY = "sk-test-key";
      delete process.env.OPENAI_ORGANIZATION;

      const config = require("../src/config");
      assert.strictEqual(config.openai.organization, null);
    });
  });

  describe("Routing", () => {
    it("should route to openai when MODEL_PROVIDER is openai", () => {
      process.env.MODEL_PROVIDER = "openai";
      process.env.OPENAI_API_KEY = "sk-test-key";

      const config = require("../src/config");
      const routing = require("../src/clients/routing");

      const payload = { messages: [{ role: "user", content: "test" }] };
      const provider = routing.determineProviderSync(payload);

      assert.strictEqual(provider, "openai");
    });

    it("should return static routing from determineProviderSmart when tiers disabled", async () => {
      process.env.MODEL_PROVIDER = "openai";
      process.env.OPENAI_API_KEY = "sk-test-key";

      const config = require("../src/config");
      const routing = require("../src/clients/routing");

      const payload = {
        messages: [{ role: "user", content: "test" }],
        tools: Array.from({ length: 10 }, (_, i) => ({ name: `tool${i}`, description: "test" })),
      };

      const result = await routing.determineProviderSmart(payload);
      // No TIER_* vars = static routing
      assert.strictEqual(result.provider, "openai");
      assert.strictEqual(result.method, "static");
      assert.strictEqual(result.reason, "tier_routing_disabled");
    });

    it("should use openai as fallback provider when configured", () => {
      process.env.MODEL_PROVIDER = "ollama";
      process.env.OLLAMA_MODEL = "qwen2.5-coder:latest";
      process.env.FALLBACK_PROVIDER = "openai";
      process.env.OPENAI_API_KEY = "sk-test-key";
      process.env.FALLBACK_ENABLED = "true";

      // Clear cache after env setup
      delete require.cache[require.resolve("../src/config/index.js")];
      delete require.cache[require.resolve("../src/clients/routing")];
      delete require.cache[require.resolve("../src/routing/index.js")];

      require("../src/config");
      const routing = require("../src/clients/routing");

      assert.strictEqual(routing.getFallbackProvider(), "openai");
    });
  });

  describe("Response Conversion", () => {
    // OpenAI uses the same response format as OpenRouter, so we can reuse the converter

    it("should convert OpenAI text response to Anthropic format", () => {
      process.env.MODEL_PROVIDER = "databricks";
      process.env.DATABRICKS_API_KEY = "test-key";
      process.env.DATABRICKS_API_BASE = "http://test.com";

      const { convertOpenRouterResponseToAnthropic } = require("../src/clients/openrouter-utils");

      const openAIResponse = {
        id: "chatcmpl-123",
        object: "chat.completion",
        created: 1677652288,
        model: "gpt-4o",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "Hello! How can I help you today?"
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

      const result = convertOpenRouterResponseToAnthropic(openAIResponse, "claude-sonnet-4-5");

      assert.strictEqual(result.role, "assistant");
      assert.strictEqual(result.model, "claude-sonnet-4-5");
      assert.strictEqual(Array.isArray(result.content), true);
      assert.strictEqual(result.content.length, 1);
      assert.strictEqual(result.content[0].type, "text");
      assert.strictEqual(result.content[0].text, "Hello! How can I help you today?");
      assert.strictEqual(result.stop_reason, "end_turn");
      assert.strictEqual(result.usage.input_tokens, 9);
      assert.strictEqual(result.usage.output_tokens, 12);
    });

    it("should convert OpenAI tool call response to Anthropic format", () => {
      process.env.MODEL_PROVIDER = "databricks";
      process.env.DATABRICKS_API_KEY = "test-key";
      process.env.DATABRICKS_API_BASE = "http://test.com";

      const { convertOpenRouterResponseToAnthropic } = require("../src/clients/openrouter-utils");

      const openAIResponse = {
        id: "chatcmpl-123",
        object: "chat.completion",
        model: "gpt-4o",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "I'll create that file for you.",
              tool_calls: [
                {
                  id: "call_abc123",
                  type: "function",
                  function: {
                    name: "Write",
                    arguments: JSON.stringify({
                      file_path: "/tmp/test.txt",
                      content: "Hello World"
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

      const result = convertOpenRouterResponseToAnthropic(openAIResponse, "claude-sonnet-4-5");

      assert.strictEqual(result.role, "assistant");
      assert.strictEqual(result.content.length, 2); // text + tool_use
      assert.strictEqual(result.content[0].type, "text");
      assert.strictEqual(result.content[0].text, "I'll create that file for you.");
      assert.strictEqual(result.content[1].type, "tool_use");
      assert.strictEqual(result.content[1].name, "Write");
      assert.strictEqual(result.content[1].id, "call_abc123");
      assert.deepStrictEqual(result.content[1].input, {
        file_path: "/tmp/test.txt",
        content: "Hello World"
      });
      assert.strictEqual(result.stop_reason, "tool_use");
    });

    it("should convert OpenAI parallel tool calls to Anthropic format", () => {
      process.env.MODEL_PROVIDER = "databricks";
      process.env.DATABRICKS_API_KEY = "test-key";
      process.env.DATABRICKS_API_BASE = "http://test.com";

      const { convertOpenRouterResponseToAnthropic } = require("../src/clients/openrouter-utils");

      const openAIResponse = {
        id: "chatcmpl-123",
        model: "gpt-4o",
        choices: [
          {
            message: {
              role: "assistant",
              content: "I'll read both files.",
              tool_calls: [
                {
                  id: "call_1",
                  type: "function",
                  function: {
                    name: "Read",
                    arguments: JSON.stringify({ file_path: "/tmp/file1.txt" })
                  }
                },
                {
                  id: "call_2",
                  type: "function",
                  function: {
                    name: "Read",
                    arguments: JSON.stringify({ file_path: "/tmp/file2.txt" })
                  }
                }
              ]
            },
            finish_reason: "tool_calls"
          }
        ],
        usage: { prompt_tokens: 30, completion_tokens: 40, total_tokens: 70 }
      };

      const result = convertOpenRouterResponseToAnthropic(openAIResponse, "claude-sonnet-4-5");

      assert.strictEqual(result.content.length, 3); // text + 2 tool_uses
      assert.strictEqual(result.content[0].type, "text");
      assert.strictEqual(result.content[1].type, "tool_use");
      assert.strictEqual(result.content[1].name, "Read");
      assert.strictEqual(result.content[1].id, "call_1");
      assert.strictEqual(result.content[2].type, "tool_use");
      assert.strictEqual(result.content[2].name, "Read");
      assert.strictEqual(result.content[2].id, "call_2");
    });

    it("should handle OpenAI response with only tool calls (no text content)", () => {
      process.env.MODEL_PROVIDER = "databricks";
      process.env.DATABRICKS_API_KEY = "test-key";
      process.env.DATABRICKS_API_BASE = "http://test.com";

      const { convertOpenRouterResponseToAnthropic } = require("../src/clients/openrouter-utils");

      const openAIResponse = {
        id: "chatcmpl-123",
        model: "gpt-4o",
        choices: [
          {
            message: {
              role: "assistant",
              content: null, // OpenAI often returns null content with tool calls
              tool_calls: [
                {
                  id: "call_xyz",
                  type: "function",
                  function: {
                    name: "Bash",
                    arguments: JSON.stringify({ command: "ls -la" })
                  }
                }
              ]
            },
            finish_reason: "tool_calls"
          }
        ],
        usage: { prompt_tokens: 20, completion_tokens: 15, total_tokens: 35 }
      };

      const result = convertOpenRouterResponseToAnthropic(openAIResponse, "claude-sonnet-4-5");

      // Should have tool_use block (at least one)
      assert.strictEqual(result.role, "assistant");
      assert.strictEqual(Array.isArray(result.content), true);
      assert.strictEqual(result.content.length >= 1, true);
      // Find the tool_use block
      const toolUseBlock = result.content.find(c => c.type === "tool_use");
      assert.strictEqual(toolUseBlock !== undefined, true);
      assert.strictEqual(toolUseBlock.name, "Bash");
    });
  });

  describe("Message Conversion", () => {
    it("should convert Anthropic messages to OpenAI format", () => {
      process.env.MODEL_PROVIDER = "databricks";
      process.env.DATABRICKS_API_KEY = "test-key";
      process.env.DATABRICKS_API_BASE = "http://test.com";

      const { convertAnthropicMessagesToOpenRouter } = require("../src/clients/openrouter-utils");

      const anthropicMessages = [
        {
          role: "user",
          content: [
            { type: "text", text: "Hello, how are you?" }
          ]
        },
        {
          role: "assistant",
          content: [
            { type: "text", text: "I'm doing well, thank you!" }
          ]
        }
      ];

      const result = convertAnthropicMessagesToOpenRouter(anthropicMessages);

      assert.strictEqual(result.length, 2);
      assert.strictEqual(result[0].role, "user");
      assert.strictEqual(result[0].content, "Hello, how are you?");
      assert.strictEqual(result[1].role, "assistant");
      assert.strictEqual(result[1].content, "I'm doing well, thank you!");
    });

    it("should convert Anthropic tool_result messages to OpenAI format", () => {
      process.env.MODEL_PROVIDER = "databricks";
      process.env.DATABRICKS_API_KEY = "test-key";
      process.env.DATABRICKS_API_BASE = "http://test.com";

      const { convertAnthropicMessagesToOpenRouter } = require("../src/clients/openrouter-utils");

      // Must have a preceding assistant message with tool_use for tool_result to be valid
      const anthropicMessages = [
        {
          role: "user",
          content: [{ type: "text", text: "Create a file" }]
        },
        {
          role: "assistant",
          content: [
            { type: "text", text: "I'll create that file." },
            {
              type: "tool_use",
              id: "call_123",
              name: "Write",
              input: { file_path: "/tmp/test.txt", content: "Hello" }
            }
          ]
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "call_123",
              content: "File created successfully"
            }
          ]
        }
      ];

      const result = convertAnthropicMessagesToOpenRouter(anthropicMessages);

      // Should have user message, assistant message with tool call, and tool result
      assert.strictEqual(result.length >= 3, true);
      // Find the tool result message
      const toolResultMsg = result.find(m => m.role === "tool");
      assert.strictEqual(toolResultMsg !== undefined, true);
      assert.strictEqual(toolResultMsg.tool_call_id, "call_123");
      assert.strictEqual(toolResultMsg.content, "File created successfully");
    });
  });

  describe("Tool Conversion", () => {
    it("should convert Anthropic tools to OpenAI format", () => {
      process.env.MODEL_PROVIDER = "databricks";
      process.env.DATABRICKS_API_KEY = "test-key";
      process.env.DATABRICKS_API_BASE = "http://test.com";

      const { convertAnthropicToolsToOpenRouter } = require("../src/clients/openrouter-utils");

      const anthropicTools = [
        {
          name: "Write",
          description: "Write content to a file",
          input_schema: {
            type: "object",
            properties: {
              file_path: { type: "string", description: "Path to the file" },
              content: { type: "string", description: "Content to write" }
            },
            required: ["file_path", "content"]
          }
        }
      ];

      const result = convertAnthropicToolsToOpenRouter(anthropicTools);

      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].type, "function");
      assert.strictEqual(result[0].function.name, "Write");
      assert.strictEqual(result[0].function.description, "Write content to a file");
      assert.deepStrictEqual(result[0].function.parameters, {
        type: "object",
        properties: {
          file_path: { type: "string", description: "Path to the file" },
          content: { type: "string", description: "Content to write" }
        },
        required: ["file_path", "content"]
      });
    });
  });

  describe("Error Handling", () => {
    it("should throw error when OpenAI response has no choices", () => {
      process.env.MODEL_PROVIDER = "databricks";
      process.env.DATABRICKS_API_KEY = "test-key";
      process.env.DATABRICKS_API_BASE = "http://test.com";

      const { convertOpenRouterResponseToAnthropic } = require("../src/clients/openrouter-utils");

      const errorResponse = {
        error: {
          message: "Rate limit exceeded",
          type: "rate_limit_error",
          code: "rate_limit_exceeded"
        }
      };

      assert.throws(
        () => convertOpenRouterResponseToAnthropic(errorResponse, "test-model"),
        /No choices in OpenRouter response/
      );
    });

    it("should throw error when OpenAI response has empty choices array", () => {
      process.env.MODEL_PROVIDER = "databricks";
      process.env.DATABRICKS_API_KEY = "test-key";
      process.env.DATABRICKS_API_BASE = "http://test.com";

      const { convertOpenRouterResponseToAnthropic } = require("../src/clients/openrouter-utils");

      const emptyChoicesResponse = {
        id: "chatcmpl-123",
        model: "gpt-4o",
        choices: [],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
      };

      assert.throws(
        () => convertOpenRouterResponseToAnthropic(emptyChoicesResponse, "test-model"),
        /No choices in OpenRouter response/
      );
    });

    it("should handle malformed tool call arguments gracefully", () => {
      process.env.MODEL_PROVIDER = "databricks";
      process.env.DATABRICKS_API_KEY = "test-key";
      process.env.DATABRICKS_API_BASE = "http://test.com";

      const { convertOpenRouterResponseToAnthropic } = require("../src/clients/openrouter-utils");

      const responseWithBadArgs = {
        id: "chatcmpl-123",
        model: "gpt-4o",
        choices: [
          {
            message: {
              role: "assistant",
              content: "Using tool",
              tool_calls: [
                {
                  id: "call_bad",
                  type: "function",
                  function: {
                    name: "Write",
                    arguments: "this is not valid json {"
                  }
                }
              ]
            },
            finish_reason: "tool_calls"
          }
        ],
        usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 }
      };

      const result = convertOpenRouterResponseToAnthropic(responseWithBadArgs, "test-model");

      // Should still convert, but with empty input object
      assert.strictEqual(result.content[1].type, "tool_use");
      assert.deepStrictEqual(result.content[1].input, {});
    });
  });

  describe("Finish Reason Mapping", () => {
    it("should map stop finish_reason to end_turn", () => {
      process.env.MODEL_PROVIDER = "databricks";
      process.env.DATABRICKS_API_KEY = "test-key";
      process.env.DATABRICKS_API_BASE = "http://test.com";

      const { convertOpenRouterResponseToAnthropic } = require("../src/clients/openrouter-utils");

      const response = {
        choices: [
          {
            message: { role: "assistant", content: "Done" },
            finish_reason: "stop"
          }
        ],
        usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 }
      };

      const result = convertOpenRouterResponseToAnthropic(response, "test-model");
      assert.strictEqual(result.stop_reason, "end_turn");
    });

    it("should map tool_calls finish_reason to tool_use", () => {
      process.env.MODEL_PROVIDER = "databricks";
      process.env.DATABRICKS_API_KEY = "test-key";
      process.env.DATABRICKS_API_BASE = "http://test.com";

      const { convertOpenRouterResponseToAnthropic } = require("../src/clients/openrouter-utils");

      const response = {
        choices: [
          {
            message: {
              role: "assistant",
              content: "Calling tool",
              tool_calls: [
                {
                  id: "call_1",
                  type: "function",
                  function: { name: "test", arguments: "{}" }
                }
              ]
            },
            finish_reason: "tool_calls"
          }
        ],
        usage: { prompt_tokens: 5, completion_tokens: 10, total_tokens: 15 }
      };

      const result = convertOpenRouterResponseToAnthropic(response, "test-model");
      assert.strictEqual(result.stop_reason, "tool_use");
    });

    it("should map length finish_reason to max_tokens", () => {
      process.env.MODEL_PROVIDER = "databricks";
      process.env.DATABRICKS_API_KEY = "test-key";
      process.env.DATABRICKS_API_BASE = "http://test.com";

      const { convertOpenRouterResponseToAnthropic } = require("../src/clients/openrouter-utils");

      const response = {
        choices: [
          {
            message: { role: "assistant", content: "This is a truncated response that..." },
            finish_reason: "length"
          }
        ],
        usage: { prompt_tokens: 5, completion_tokens: 100, total_tokens: 105 }
      };

      const result = convertOpenRouterResponseToAnthropic(response, "test-model");
      assert.strictEqual(result.stop_reason, "max_tokens");
    });
  });

  describe("Usage Metrics", () => {
    it("should correctly map OpenAI usage to Anthropic format", () => {
      process.env.MODEL_PROVIDER = "databricks";
      process.env.DATABRICKS_API_KEY = "test-key";
      process.env.DATABRICKS_API_BASE = "http://test.com";

      const { convertOpenRouterResponseToAnthropic } = require("../src/clients/openrouter-utils");

      const response = {
        choices: [
          {
            message: { role: "assistant", content: "Response" },
            finish_reason: "stop"
          }
        ],
        usage: {
          prompt_tokens: 150,
          completion_tokens: 75,
          total_tokens: 225
        }
      };

      const result = convertOpenRouterResponseToAnthropic(response, "test-model");

      // OpenAI prompt_tokens -> Anthropic input_tokens
      // OpenAI completion_tokens -> Anthropic output_tokens
      assert.strictEqual(result.usage.input_tokens, 150);
      assert.strictEqual(result.usage.output_tokens, 75);
    });

    it("should handle missing usage gracefully", () => {
      process.env.MODEL_PROVIDER = "databricks";
      process.env.DATABRICKS_API_KEY = "test-key";
      process.env.DATABRICKS_API_BASE = "http://test.com";

      const { convertOpenRouterResponseToAnthropic } = require("../src/clients/openrouter-utils");

      const response = {
        choices: [
          {
            message: { role: "assistant", content: "Response" },
            finish_reason: "stop"
          }
        ]
        // No usage field
      };

      const result = convertOpenRouterResponseToAnthropic(response, "test-model");

      assert.strictEqual(result.usage.input_tokens, 0);
      assert.strictEqual(result.usage.output_tokens, 0);
    });
  });
});
