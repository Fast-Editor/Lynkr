const assert = require("assert");
const { describe, it, beforeEach, afterEach } = require("node:test");

describe("llama.cpp Integration", () => {
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
    it("should accept llamacpp as a valid MODEL_PROVIDER", () => {
      process.env.MODEL_PROVIDER = "llamacpp";
      process.env.LLAMACPP_ENDPOINT = "http://localhost:8080";

      const config = require("../src/config");
      assert.strictEqual(config.modelProvider.type, "llamacpp");
    });

    it("should use default endpoint when LLAMACPP_ENDPOINT is not set", () => {
      process.env.MODEL_PROVIDER = "llamacpp";
      delete process.env.LLAMACPP_ENDPOINT; // Remove from test env
      process.env.LLAMACPP_ENDPOINT = undefined; // Ensure it's truly unset

      const config = require("../src/config");
      assert.strictEqual(config.llamacpp.endpoint, "http://localhost:8080");
    });

    it("should use custom endpoint when LLAMACPP_ENDPOINT is set", () => {
      process.env.MODEL_PROVIDER = "llamacpp";
      process.env.LLAMACPP_ENDPOINT = "http://192.168.1.100:9000";

      const config = require("../src/config");
      assert.strictEqual(config.llamacpp.endpoint, "http://192.168.1.100:9000");
    });

    it("should throw error when LLAMACPP_ENDPOINT is invalid URL", () => {
      process.env.MODEL_PROVIDER = "llamacpp";
      process.env.LLAMACPP_ENDPOINT = "not-a-valid-url";

      assert.throws(
        () => require("../src/config"),
        /LLAMACPP_ENDPOINT must be a valid URL/
      );
    });

    it("should use default model when LLAMACPP_MODEL is not set", () => {
      process.env.MODEL_PROVIDER = "llamacpp";
      delete process.env.LLAMACPP_MODEL; // Remove from test env
      process.env.LLAMACPP_MODEL = undefined; // Ensure it's truly unset

      const config = require("../src/config");
      assert.strictEqual(config.llamacpp.model, "default");
    });

    it("should use custom model when LLAMACPP_MODEL is set", () => {
      process.env.MODEL_PROVIDER = "llamacpp";
      process.env.LLAMACPP_MODEL = "qwen2.5-coder-7b";

      const config = require("../src/config");
      assert.strictEqual(config.llamacpp.model, "qwen2.5-coder-7b");
    });

    it("should use default timeout when LLAMACPP_TIMEOUT_MS is not set", () => {
      process.env.MODEL_PROVIDER = "llamacpp";
      delete process.env.LLAMACPP_TIMEOUT_MS;

      const config = require("../src/config");
      assert.strictEqual(config.llamacpp.timeout, 120000);
    });

    it("should use custom timeout when LLAMACPP_TIMEOUT_MS is set", () => {
      process.env.MODEL_PROVIDER = "llamacpp";
      process.env.LLAMACPP_TIMEOUT_MS = "300000";

      const config = require("../src/config");
      assert.strictEqual(config.llamacpp.timeout, 300000);
    });

    it("should have null apiKey when LLAMACPP_API_KEY is not set", () => {
      process.env.MODEL_PROVIDER = "llamacpp";
      delete process.env.LLAMACPP_API_KEY;

      const config = require("../src/config");
      assert.strictEqual(config.llamacpp.apiKey, null);
    });

    it("should store apiKey when LLAMACPP_API_KEY is set", () => {
      process.env.MODEL_PROVIDER = "llamacpp";
      process.env.LLAMACPP_API_KEY = "my-secret-key";

      const config = require("../src/config");
      assert.strictEqual(config.llamacpp.apiKey, "my-secret-key");
    });
  });

  describe("Routing", () => {
    it("should route to llamacpp when MODEL_PROVIDER is llamacpp", async () => {
      process.env.MODEL_PROVIDER = "llamacpp";
      process.env.LLAMACPP_ENDPOINT = "http://localhost:8080";

      const config = require("../src/config");
      const routing = require("../src/clients/routing");

      const payload = { messages: [{ role: "user", content: "test" }] };
      const result = await routing.determineProviderSmart(payload);

      assert.strictEqual(result.provider, "llamacpp");
      assert.strictEqual(result.method, "static");
    });

    it("should return static routing from determineProviderSmart when tiers disabled", async () => {
      process.env.MODEL_PROVIDER = "llamacpp";
      process.env.LLAMACPP_ENDPOINT = "http://localhost:8080";

      const config = require("../src/config");
      const routing = require("../src/clients/routing");

      const payload = { messages: [{ role: "user", content: "test" }] };
      const result = await routing.determineProviderSmart(payload);

      assert.strictEqual(result.provider, "llamacpp");
      assert.strictEqual(result.method, "static");
      assert.strictEqual(result.reason, "tier_routing_disabled");
    });

    it("should throw error when llamacpp is set as FALLBACK_PROVIDER", () => {
      process.env.MODEL_PROVIDER = "ollama";
      process.env.OLLAMA_MODEL = "qwen2.5-coder:latest";
      process.env.FALLBACK_PROVIDER = "llamacpp";
      process.env.LLAMACPP_ENDPOINT = "http://localhost:8080";
      process.env.FALLBACK_ENABLED = "true";
      // Enable tier routing so fallback validation runs
      process.env.TIER_SIMPLE = "ollama:llama3.2";
      process.env.TIER_MEDIUM = "ollama:llama3.2";
      process.env.TIER_COMPLEX = "ollama:llama3.2";
      process.env.TIER_REASONING = "ollama:llama3.2";

      assert.throws(
        () => require("../src/config"),
        /FALLBACK_PROVIDER cannot be 'llamacpp'/
      );
    });
  });

  describe("Response Conversion", () => {
    // llama.cpp uses OpenAI-compatible format, so we reuse the same converter

    it("should convert llama.cpp text response to Anthropic format", () => {
      process.env.MODEL_PROVIDER = "databricks";
      process.env.DATABRICKS_API_KEY = "test-key";
      process.env.DATABRICKS_API_BASE = "http://test.com";

      const { convertOpenRouterResponseToAnthropic } = require("../src/clients/openrouter-utils");

      const llamacppResponse = {
        id: "chatcmpl-123",
        object: "chat.completion",
        created: 1677652288,
        model: "qwen2.5-coder-7b",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "Hello! I'm running on llama.cpp."
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

      const result = convertOpenRouterResponseToAnthropic(llamacppResponse, "claude-sonnet-4-5");

      assert.strictEqual(result.role, "assistant");
      assert.strictEqual(result.model, "claude-sonnet-4-5");
      assert.strictEqual(Array.isArray(result.content), true);
      assert.strictEqual(result.content.length, 1);
      assert.strictEqual(result.content[0].type, "text");
      assert.strictEqual(result.content[0].text, "Hello! I'm running on llama.cpp.");
      assert.strictEqual(result.stop_reason, "end_turn");
      assert.strictEqual(result.usage.input_tokens, 9);
      assert.strictEqual(result.usage.output_tokens, 12);
    });

    it("should convert llama.cpp tool call response to Anthropic format", () => {
      process.env.MODEL_PROVIDER = "databricks";
      process.env.DATABRICKS_API_KEY = "test-key";
      process.env.DATABRICKS_API_BASE = "http://test.com";

      const { convertOpenRouterResponseToAnthropic } = require("../src/clients/openrouter-utils");

      const llamacppResponse = {
        id: "chatcmpl-123",
        object: "chat.completion",
        model: "qwen2.5-coder-7b",
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

      const result = convertOpenRouterResponseToAnthropic(llamacppResponse, "claude-sonnet-4-5");

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

    it("should convert llama.cpp parallel tool calls to Anthropic format", () => {
      process.env.MODEL_PROVIDER = "databricks";
      process.env.DATABRICKS_API_KEY = "test-key";
      process.env.DATABRICKS_API_BASE = "http://test.com";

      const { convertOpenRouterResponseToAnthropic } = require("../src/clients/openrouter-utils");

      const llamacppResponse = {
        id: "chatcmpl-123",
        model: "qwen2.5-coder-7b",
        choices: [
          {
            message: {
              role: "assistant",
              content: "I'll search for both patterns.",
              tool_calls: [
                {
                  id: "call_1",
                  type: "function",
                  function: {
                    name: "Grep",
                    arguments: JSON.stringify({ pattern: "TODO" })
                  }
                },
                {
                  id: "call_2",
                  type: "function",
                  function: {
                    name: "Grep",
                    arguments: JSON.stringify({ pattern: "FIXME" })
                  }
                }
              ]
            },
            finish_reason: "tool_calls"
          }
        ],
        usage: { prompt_tokens: 30, completion_tokens: 40, total_tokens: 70 }
      };

      const result = convertOpenRouterResponseToAnthropic(llamacppResponse, "claude-sonnet-4-5");

      assert.strictEqual(result.content.length, 3); // text + 2 tool_uses
      assert.strictEqual(result.content[0].type, "text");
      assert.strictEqual(result.content[1].type, "tool_use");
      assert.strictEqual(result.content[1].name, "Grep");
      assert.strictEqual(result.content[1].id, "call_1");
      assert.strictEqual(result.content[2].type, "tool_use");
      assert.strictEqual(result.content[2].name, "Grep");
      assert.strictEqual(result.content[2].id, "call_2");
    });

    it("should handle llama.cpp response with only tool calls (no text content)", () => {
      process.env.MODEL_PROVIDER = "databricks";
      process.env.DATABRICKS_API_KEY = "test-key";
      process.env.DATABRICKS_API_BASE = "http://test.com";

      const { convertOpenRouterResponseToAnthropic } = require("../src/clients/openrouter-utils");

      const llamacppResponse = {
        id: "chatcmpl-123",
        model: "qwen2.5-coder-7b",
        choices: [
          {
            message: {
              role: "assistant",
              content: null, // llama.cpp may return null content with tool calls
              tool_calls: [
                {
                  id: "call_xyz",
                  type: "function",
                  function: {
                    name: "Bash",
                    arguments: JSON.stringify({ command: "pwd" })
                  }
                }
              ]
            },
            finish_reason: "tool_calls"
          }
        ],
        usage: { prompt_tokens: 20, completion_tokens: 15, total_tokens: 35 }
      };

      const result = convertOpenRouterResponseToAnthropic(llamacppResponse, "claude-sonnet-4-5");

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
    it("should convert Anthropic messages to llama.cpp (OpenAI) format", () => {
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

    it("should convert Anthropic tool_result messages to llama.cpp (OpenAI) format", () => {
      process.env.MODEL_PROVIDER = "databricks";
      process.env.DATABRICKS_API_KEY = "test-key";
      process.env.DATABRICKS_API_BASE = "http://test.com";

      const { convertAnthropicMessagesToOpenRouter } = require("../src/clients/openrouter-utils");

      // Must have a preceding assistant message with tool_use for tool_result to be valid
      const anthropicMessages = [
        {
          role: "user",
          content: [{ type: "text", text: "Run a command" }]
        },
        {
          role: "assistant",
          content: [
            { type: "text", text: "I'll run that command." },
            {
              type: "tool_use",
              id: "call_456",
              name: "Bash",
              input: { command: "echo hello" }
            }
          ]
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "call_456",
              content: "hello"
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
      assert.strictEqual(toolResultMsg.tool_call_id, "call_456");
      assert.strictEqual(toolResultMsg.content, "hello");
    });
  });

  describe("Tool Conversion", () => {
    it("should convert Anthropic tools to llama.cpp (OpenAI) format", () => {
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

  describe("Error Handling", () => {
    it("should throw error when llama.cpp response has no choices", () => {
      process.env.MODEL_PROVIDER = "databricks";
      process.env.DATABRICKS_API_KEY = "test-key";
      process.env.DATABRICKS_API_BASE = "http://test.com";

      const { convertOpenRouterResponseToAnthropic } = require("../src/clients/openrouter-utils");

      const errorResponse = {
        error: {
          message: "Model not loaded",
          type: "invalid_request_error"
        }
      };

      assert.throws(
        () => convertOpenRouterResponseToAnthropic(errorResponse, "test-model"),
        /No choices in OpenRouter response/
      );
    });

    it("should throw error when llama.cpp response has empty choices array", () => {
      process.env.MODEL_PROVIDER = "databricks";
      process.env.DATABRICKS_API_KEY = "test-key";
      process.env.DATABRICKS_API_BASE = "http://test.com";

      const { convertOpenRouterResponseToAnthropic } = require("../src/clients/openrouter-utils");

      const emptyChoicesResponse = {
        id: "chatcmpl-123",
        model: "qwen2.5-coder-7b",
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
        model: "qwen2.5-coder-7b",
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
                    name: "Read",
                    arguments: "invalid json {"
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
            message: { role: "assistant", content: "Complete" },
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
              content: "Executing tool",
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
            message: { role: "assistant", content: "Truncated response..." },
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
    it("should correctly map llama.cpp usage to Anthropic format", () => {
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
          prompt_tokens: 200,
          completion_tokens: 100,
          total_tokens: 300
        }
      };

      const result = convertOpenRouterResponseToAnthropic(response, "test-model");

      assert.strictEqual(result.usage.input_tokens, 200);
      assert.strictEqual(result.usage.output_tokens, 100);
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

    it("should filter duplicate tool call JSON from content when tool_calls are present", () => {
      process.env.MODEL_PROVIDER = "databricks";
      process.env.DATABRICKS_API_KEY = "test-key";
      process.env.DATABRICKS_API_BASE = "http://test.com";

      const { convertOpenRouterResponseToAnthropic } = require("../src/clients/openrouter-utils");

      // Simulate llama.cpp response with BOTH content (as JSON) and tool_calls
      const response = {
        id: "chatcmpl-123",
        choices: [
          {
            message: {
              role: "assistant",
              content: '{"type": "function", "function": {"name": "Write", "parameters": {"file_path": "test.cpp", "content": "int main() {}"}}}',
              tool_calls: [
                {
                  id: "call_abc123",
                  type: "function",
                  function: {
                    name: "Write",
                    arguments: '{"file_path": "test.cpp", "content": "int main() {}"}'
                  }
                }
              ]
            },
            finish_reason: "tool_calls"
          }
        ],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 50
        }
      };

      const result = convertOpenRouterResponseToAnthropic(response, "test-model");

      // Should have only 1 content block (tool_use), not 2 (text + tool_use)
      assert.strictEqual(result.content.length, 1);
      assert.strictEqual(result.content[0].type, "tool_use");
      assert.strictEqual(result.content[0].name, "Write");
      assert.strictEqual(result.stop_reason, "tool_use");

      // Verify the JSON text was NOT included as a text block
      const textBlocks = result.content.filter(block => block.type === "text");
      assert.strictEqual(textBlocks.length, 0, "Should not include text block with duplicate JSON");
    });

    it("should preserve normal text content when tool_calls are NOT present", () => {
      process.env.MODEL_PROVIDER = "databricks";
      process.env.DATABRICKS_API_KEY = "test-key";
      process.env.DATABRICKS_API_BASE = "http://test.com";

      const { convertOpenRouterResponseToAnthropic } = require("../src/clients/openrouter-utils");

      const response = {
        id: "chatcmpl-456",
        choices: [
          {
            message: {
              role: "assistant",
              content: "Here is the code you requested.",
              // No tool_calls
            },
            finish_reason: "stop"
          }
        ],
        usage: {
          prompt_tokens: 50,
          completion_tokens: 25
        }
      };

      const result = convertOpenRouterResponseToAnthropic(response, "test-model");

      // Should have 1 text block
      assert.strictEqual(result.content.length, 1);
      assert.strictEqual(result.content[0].type, "text");
      assert.strictEqual(result.content[0].text, "Here is the code you requested.");
      assert.strictEqual(result.stop_reason, "end_turn");
    });

    it("should preserve text content with tool_calls when text is NOT JSON", () => {
      process.env.MODEL_PROVIDER = "databricks";
      process.env.DATABRICKS_API_KEY = "test-key";
      process.env.DATABRICKS_API_BASE = "http://test.com";

      const { convertOpenRouterResponseToAnthropic } = require("../src/clients/openrouter-utils");

      // Some models include explanatory text before/with tool calls
      const response = {
        id: "chatcmpl-789",
        choices: [
          {
            message: {
              role: "assistant",
              content: "I'll write the file for you now.",
              tool_calls: [
                {
                  id: "call_xyz789",
                  type: "function",
                  function: {
                    name: "Write",
                    arguments: '{"file_path": "test.cpp", "content": "int main() {}"}'
                  }
                }
              ]
            },
            finish_reason: "tool_calls"
          }
        ],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 60
        }
      };

      const result = convertOpenRouterResponseToAnthropic(response, "test-model");

      // Should have 2 content blocks (text + tool_use)
      assert.strictEqual(result.content.length, 2);
      assert.strictEqual(result.content[0].type, "text");
      assert.strictEqual(result.content[0].text, "I'll write the file for you now.");
      assert.strictEqual(result.content[1].type, "tool_use");
      assert.strictEqual(result.content[1].name, "Write");
      assert.strictEqual(result.stop_reason, "tool_use");
    });

    it("should filter malformed JSON when model outputs ONLY JSON without tool_calls", () => {
      process.env.MODEL_PROVIDER = "databricks";
      process.env.DATABRICKS_API_KEY = "test-key";
      process.env.DATABRICKS_API_BASE = "http://test.com";

      const { convertOpenRouterResponseToAnthropic } = require("../src/clients/openrouter-utils");

      // Simulate llama.cpp model that outputs JSON in content but doesn't provide tool_calls
      // This is a model training/configuration issue - model learned to output JSON
      // but llama.cpp server isn't converting it to structured tool_calls
      const response = {
        id: "chatcmpl-malformed",
        choices: [
          {
            message: {
              role: "assistant",
              content: '{"function": "Write", "parameters": {"file_path": "test.go", "content": "package main"}}',
              // No tool_calls array - model error!
            },
            finish_reason: "stop"
          }
        ],
        usage: {
          prompt_tokens: 50,
          completion_tokens: 30
        }
      };

      const result = convertOpenRouterResponseToAnthropic(response, "test-model");

      // Should have 1 empty text block (JSON was filtered out)
      assert.strictEqual(result.content.length, 1);
      assert.strictEqual(result.content[0].type, "text");
      assert.strictEqual(result.content[0].text, "");
      assert.strictEqual(result.stop_reason, "end_turn");
    });

    it("should filter alternative JSON formats without tool_calls", () => {
      process.env.MODEL_PROVIDER = "databricks";
      process.env.DATABRICKS_API_KEY = "test-key";
      process.env.DATABRICKS_API_BASE = "http://test.com";

      const { convertOpenRouterResponseToAnthropic } = require("../src/clients/openrouter-utils");

      // Test the other JSON format seen in the wild
      const response = {
        id: "chatcmpl-alt-format",
        choices: [
          {
            message: {
              role: "assistant",
              content: '{"type": "function", "function": {"name": "Read", "arguments": {"file_path": "config.json"}}}',
            },
            finish_reason: "stop"
          }
        ],
        usage: {
          prompt_tokens: 40,
          completion_tokens: 25
        }
      };

      const result = convertOpenRouterResponseToAnthropic(response, "test-model");

      // Should filter out the JSON
      assert.strictEqual(result.content.length, 1);
      assert.strictEqual(result.content[0].type, "text");
      assert.strictEqual(result.content[0].text, "");
    });
  });
});
