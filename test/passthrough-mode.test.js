const assert = require("assert");
const { describe, it, beforeEach, afterEach, mock } = require("node:test");

describe("Passthrough Mode (Client-Side Tool Execution)", () => {
  let originalEnv;
  let config;
  let orchestrator;

  beforeEach(() => {
    // Store original environment
    originalEnv = { ...process.env };

    // Set MODEL_PROVIDER to databricks for tests (not azure-openai from .env)
    process.env.MODEL_PROVIDER = "databricks";
    process.env.DATABRICKS_API_KEY = "test-key";
    process.env.DATABRICKS_API_BASE = "http://test.com";

    // Clear module cache
    delete require.cache[require.resolve("../src/config")];
    delete require.cache[require.resolve("../src/orchestrator/index")];
  });

  afterEach(() => {
    // Restore environment
    process.env = originalEnv;
  });

  describe("Response Format in Passthrough Mode", () => {
    it("should return Anthropic-formatted response with tool_use blocks", () => {
      // Mock response from provider with tool calls
      const mockProviderResponse = {
        ok: true,
        status: 200,
        json: {
          choices: [
            {
              message: {
                role: "assistant",
                content: "I'll create that file for you.",
                tool_calls: [
                  {
                    id: "call_123",
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
          model: "openai/gpt-4o-mini",
          usage: {
            prompt_tokens: 10,
            completion_tokens: 20,
            total_tokens: 30
          }
        }
      };

      // Expected Anthropic format
      const expectedContent = [
        {
          type: "text",
          text: "I'll create that file for you."
        },
        {
          type: "tool_use",
          id: "call_123",
          name: "Write",
          input: {
            file_path: "/tmp/test.txt",
            content: "Hello World"
          }
        }
      ];

      // Test content conversion
      const { convertOpenRouterResponseToAnthropic } = require("../src/clients/openrouter-utils");
      const anthropicResponse = convertOpenRouterResponseToAnthropic(
        mockProviderResponse.json,
        "claude-sonnet-4-5"
      );

      assert.strictEqual(anthropicResponse.role, "assistant");
      assert.strictEqual(anthropicResponse.stop_reason, "tool_use");
      assert.strictEqual(Array.isArray(anthropicResponse.content), true);
      assert.strictEqual(anthropicResponse.content.length, 2);
      assert.strictEqual(anthropicResponse.content[0].type, "text");
      assert.strictEqual(anthropicResponse.content[1].type, "tool_use");
      assert.strictEqual(anthropicResponse.content[1].name, "Write");
      assert.deepStrictEqual(anthropicResponse.content[1].input, {
        file_path: "/tmp/test.txt",
        content: "Hello World"
      });
    });

    it("should handle multiple tool calls in one response", () => {
      const mockProviderResponse = {
        choices: [
          {
            message: {
              role: "assistant",
              content: "I'll read the file and then write it.",
              tool_calls: [
                {
                  id: "call_1",
                  type: "function",
                  function: {
                    name: "Read",
                    arguments: JSON.stringify({ file_path: "/tmp/input.txt" })
                  }
                },
                {
                  id: "call_2",
                  type: "function",
                  function: {
                    name: "Write",
                    arguments: JSON.stringify({
                      file_path: "/tmp/output.txt",
                      content: "Modified"
                    })
                  }
                }
              ]
            },
            finish_reason: "tool_calls"
          }
        ],
        model: "openai/gpt-4o-mini",
        usage: { prompt_tokens: 10, completion_tokens: 30, total_tokens: 40 }
      };

      const { convertOpenRouterResponseToAnthropic } = require("../src/clients/openrouter-utils");
      const anthropicResponse = convertOpenRouterResponseToAnthropic(
        mockProviderResponse,
        "claude-sonnet-4-5"
      );

      assert.strictEqual(anthropicResponse.content.length, 3); // 1 text + 2 tool_use
      assert.strictEqual(anthropicResponse.content[1].type, "tool_use");
      assert.strictEqual(anthropicResponse.content[1].name, "Read");
      assert.strictEqual(anthropicResponse.content[2].type, "tool_use");
      assert.strictEqual(anthropicResponse.content[2].name, "Write");
    });

    it("should handle tool calls without text content", () => {
      const mockProviderResponse = {
        choices: [
          {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "call_1",
                  type: "function",
                  function: {
                    name: "Read",
                    arguments: JSON.stringify({ file_path: "/tmp/test.txt" })
                  }
                }
              ]
            },
            finish_reason: "tool_calls"
          }
        ],
        model: "openai/gpt-4o-mini",
        usage: { prompt_tokens: 10, completion_tokens: 15, total_tokens: 25 }
      };

      const { convertOpenRouterResponseToAnthropic } = require("../src/clients/openrouter-utils");
      const anthropicResponse = convertOpenRouterResponseToAnthropic(
        mockProviderResponse,
        "claude-sonnet-4-5"
      );

      // Should only have tool_use block, no text block
      assert.strictEqual(anthropicResponse.content.length, 1);
      assert.strictEqual(anthropicResponse.content[0].type, "tool_use");
    });
  });

  describe("Tool Result Processing", () => {
    it("should accept tool_result blocks from CLI in next request", () => {
      // Simulate a conversation with tool results coming back from CLI
      const messagesWithToolResults = [
        {
          role: "user",
          content: "Create a file /tmp/test.txt"
        },
        {
          role: "assistant",
          content: [
            { type: "text", text: "I'll create that file." },
            {
              type: "tool_use",
              id: "toolu_123",
              name: "Write",
              input: {
                file_path: "/tmp/test.txt",
                content: "Hello"
              }
            }
          ]
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_123",
              content: "File created successfully"
            }
          ]
        }
      ];

      // Verify structure
      assert.strictEqual(messagesWithToolResults.length, 3);
      assert.strictEqual(messagesWithToolResults[2].role, "user");
      assert.strictEqual(Array.isArray(messagesWithToolResults[2].content), true);
      assert.strictEqual(messagesWithToolResults[2].content[0].type, "tool_result");
      assert.strictEqual(messagesWithToolResults[2].content[0].tool_use_id, "toolu_123");
    });

    it("should convert tool_result blocks to OpenRouter format", () => {
      // Must include assistant message with tool_use first
      const anthropicMessages = [
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu_123",
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
              tool_use_id: "toolu_123",
              content: "File created successfully"
            }
          ]
        }
      ];

      const { convertAnthropicMessagesToOpenRouter } = require("../src/clients/openrouter-utils");
      const openRouterMessages = convertAnthropicMessagesToOpenRouter(anthropicMessages);

      // Should convert to tool role message for OpenRouter
      assert.strictEqual(openRouterMessages.length >= 2, true);
      // OpenRouter expects tool results as separate tool messages
      const toolMessage = openRouterMessages.find(m => m.role === "tool");
      assert.ok(toolMessage, "Tool message should be present");
    });
  });

  describe("Stop Reason Handling", () => {
    it("should set stop_reason to 'tool_use' when tools are present", () => {
      const mockResponse = {
        choices: [
          {
            message: {
              role: "assistant",
              content: "Using tool",
              tool_calls: [
                {
                  id: "call_1",
                  function: {
                    name: "Read",
                    arguments: "{}"
                  }
                }
              ]
            },
            finish_reason: "tool_calls"
          }
        ],
        model: "test-model",
        usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 }
      };

      const { convertOpenRouterResponseToAnthropic } = require("../src/clients/openrouter-utils");
      const result = convertOpenRouterResponseToAnthropic(mockResponse, "claude-sonnet-4-5");

      assert.strictEqual(result.stop_reason, "tool_use");
    });

    it("should set stop_reason to 'end_turn' when no tools", () => {
      const mockResponse = {
        choices: [
          {
            message: {
              role: "assistant",
              content: "Simple response"
            },
            finish_reason: "stop"
          }
        ],
        model: "test-model",
        usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 }
      };

      const { convertOpenRouterResponseToAnthropic } = require("../src/clients/openrouter-utils");
      const result = convertOpenRouterResponseToAnthropic(mockResponse, "claude-sonnet-4-5");

      assert.strictEqual(result.stop_reason, "end_turn");
    });
  });

  describe("Session Storage Format", () => {
    it("should store tool_use blocks in Anthropic format for session", () => {
      // Session content should always be in Anthropic format
      // regardless of provider
      const sessionContent = [
        {
          type: "text",
          text: "I'll help with that."
        },
        {
          type: "tool_use",
          id: "toolu_abc",
          name: "Write",
          input: {
            file_path: "/tmp/test.txt",
            content: "data"
          }
        }
      ];

      // Verify all blocks have correct structure
      sessionContent.forEach(block => {
        assert.strictEqual(typeof block.type, "string");
        if (block.type === "tool_use") {
          assert.strictEqual(typeof block.id, "string");
          assert.strictEqual(typeof block.name, "string");
          assert.strictEqual(typeof block.input, "object");
        }
      });
    });
  });
});
