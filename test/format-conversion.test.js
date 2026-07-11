const assert = require("assert");
const { describe, it, beforeEach, afterEach } = require("node:test");

describe("Enhanced Format Conversion", () => {
  let openrouterUtils;

  beforeEach(() => {
    // Set MODEL_PROVIDER to avoid validation errors
    process.env.MODEL_PROVIDER = "databricks";
    process.env.DATABRICKS_API_KEY = "test-key";
    process.env.DATABRICKS_API_BASE = "http://test.com";

    // Clear module cache
    delete require.cache[require.resolve("../src/clients/openrouter-utils")];
    delete require.cache[require.resolve("../src/config")];
    openrouterUtils = require("../src/clients/openrouter-utils");
  });

  describe("Anthropic to OpenRouter Conversion", () => {
    describe("Message Conversion", () => {
      it("should convert simple text messages", () => {
        const anthropicMessages = [
          {
            role: "user",
            content: "Hello, how are you?"
          }
        ];

        const result = openrouterUtils.convertAnthropicMessagesToOpenRouter(anthropicMessages);

        assert.strictEqual(result.length, 1);
        assert.strictEqual(result[0].role, "user");
        assert.strictEqual(result[0].content, "Hello, how are you?");
      });

      it("should convert messages with content blocks", () => {
        const anthropicMessages = [
          {
            role: "user",
            content: [
              { type: "text", text: "Please read this file" }
            ]
          }
        ];

        const result = openrouterUtils.convertAnthropicMessagesToOpenRouter(anthropicMessages);

        assert.strictEqual(result.length, 1);
        assert.strictEqual(result[0].role, "user");
        assert.strictEqual(result[0].content, "Please read this file");
      });

      it("should handle multiple text blocks", () => {
        const anthropicMessages = [
          {
            role: "user",
            content: [
              { type: "text", text: "First part" },
              { type: "text", text: "Second part" }
            ]
          }
        ];

        const result = openrouterUtils.convertAnthropicMessagesToOpenRouter(anthropicMessages);

        assert.strictEqual(result.length, 1);
        assert.strictEqual(result[0].content, "First part\nSecond part");
      });

      it("should convert assistant messages with tool_use blocks", () => {
        const anthropicMessages = [
          {
            role: "assistant",
            content: [
              { type: "text", text: "I'll read that file" },
              {
                type: "tool_use",
                id: "toolu_123",
                name: "Read",
                input: { file_path: "/tmp/test.txt" }
              }
            ]
          }
        ];

        const result = openrouterUtils.convertAnthropicMessagesToOpenRouter(anthropicMessages);

        assert.strictEqual(result.length, 1);
        assert.strictEqual(result[0].role, "assistant");
        assert.strictEqual(result[0].content, "I'll read that file");
        assert.strictEqual(Array.isArray(result[0].tool_calls), true);
        assert.strictEqual(result[0].tool_calls.length, 1);
        assert.strictEqual(result[0].tool_calls[0].id, "toolu_123");
        assert.strictEqual(result[0].tool_calls[0].function.name, "Read");
      });

      it("should convert tool_result blocks to tool messages", () => {
        // Must include the assistant message with tool_use first
        // otherwise tool_result is orphaned and gets removed
        const anthropicMessages = [
          {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "toolu_123",
                name: "Read",
                input: { file_path: "/tmp/test.txt" }
              }
            ]
          },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "toolu_123",
                content: "File content here"
              }
            ]
          }
        ];

        const result = openrouterUtils.convertAnthropicMessagesToOpenRouter(anthropicMessages);

        // Tool results should be converted to tool role messages
        const toolMessage = result.find(m => m.role === "tool");
        assert.ok(toolMessage, "Tool message should be present");
        assert.strictEqual(toolMessage.tool_call_id, "toolu_123");
        assert.strictEqual(toolMessage.content, "File content here");
      });

      it("should handle text content separate from tool_result", () => {
        // Note: OpenRouter validation requires tool messages to immediately follow
        // the assistant message with tool_calls. A user message in between will
        // cause the tool message to be filtered as orphaned.
        const anthropicMessages = [
          {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "toolu_123",
                name: "Write",
                input: { file_path: "/tmp/test.txt", content: "data" }
              }
            ]
          },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "toolu_123",
                content: "Success"
              }
            ]
          },
          {
            role: "user",
            content: "Here's additional feedback"
          }
        ];

        const result = openrouterUtils.convertAnthropicMessagesToOpenRouter(anthropicMessages);

        // Should have assistant with tool_calls, tool message, and user message
        const assistantMsg = result.find(m => m.role === "assistant");
        const toolMsg = result.find(m => m.role === "tool");
        const userMsg = result.find(m => m.role === "user" && m.content === "Here's additional feedback");

        assert.ok(assistantMsg, "Assistant message should be present");
        assert.ok(toolMsg, "Tool message should be present");
        assert.ok(userMsg, "User message should be present");
        assert.strictEqual(toolMsg.content, "Success");
      });
    });

    describe("Tool Conversion", () => {
      it("should convert Anthropic tools to OpenRouter format", () => {
        const anthropicTools = [
          {
            name: "Write",
            description: "Write a file to the filesystem",
            input_schema: {
              type: "object",
              properties: {
                file_path: { type: "string", description: "Path to file" },
                content: { type: "string", description: "File content" }
              },
              required: ["file_path", "content"]
            }
          }
        ];

        const result = openrouterUtils.convertAnthropicToolsToOpenRouter(anthropicTools);

        assert.strictEqual(result.length, 1);
        assert.strictEqual(result[0].type, "function");
        assert.strictEqual(result[0].function.name, "Write");
        assert.strictEqual(result[0].function.description, "Write a file to the filesystem");
        assert.deepStrictEqual(result[0].function.parameters, anthropicTools[0].input_schema);
      });

      it("should handle tools without descriptions", () => {
        const anthropicTools = [
          {
            name: "TestTool",
            input_schema: {
              type: "object",
              properties: {}
            }
          }
        ];

        const result = openrouterUtils.convertAnthropicToolsToOpenRouter(anthropicTools);

        assert.strictEqual(result.length, 1);
        assert.strictEqual(result[0].function.name, "TestTool");
        assert.strictEqual(result[0].function.description, "");
      });

      it("should handle empty tools array", () => {
        const result = openrouterUtils.convertAnthropicToolsToOpenRouter([]);
        assert.strictEqual(result.length, 0);
      });

      it("should convert multiple tools", () => {
        const anthropicTools = [
          {
            name: "Read",
            description: "Read a file",
            input_schema: { type: "object", properties: {} }
          },
          {
            name: "Write",
            description: "Write a file",
            input_schema: { type: "object", properties: {} }
          },
          {
            name: "Execute",
            description: "Execute a command",
            input_schema: { type: "object", properties: {} }
          }
        ];

        const result = openrouterUtils.convertAnthropicToolsToOpenRouter(anthropicTools);

        assert.strictEqual(result.length, 3);
        assert.strictEqual(result[0].function.name, "Read");
        assert.strictEqual(result[1].function.name, "Write");
        assert.strictEqual(result[2].function.name, "Execute");
      });
    });
  });

  describe("OpenRouter to Anthropic Conversion", () => {
    describe("Response Conversion", () => {
      it("should convert text-only response", () => {
        const openRouterResponse = {
          choices: [
            {
              message: {
                role: "assistant",
                content: "Hello! I'm here to help."
              },
              finish_reason: "stop"
            }
          ],
          model: "openai/gpt-4o-mini",
          usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 }
        };

        const result = openrouterUtils.convertOpenRouterResponseToAnthropic(
          openRouterResponse,
          "test-model"
        );

        assert.strictEqual(result.type, "message");
        assert.strictEqual(result.role, "assistant");
        assert.strictEqual(result.content.length, 1);
        assert.strictEqual(result.content[0].type, "text");
        assert.strictEqual(result.content[0].text, "Hello! I'm here to help.");
        assert.strictEqual(result.stop_reason, "end_turn");
      });

      it("should convert response with tool calls", () => {
        const openRouterResponse = {
          choices: [
            {
              message: {
                role: "assistant",
                content: "I'll read that file",
                tool_calls: [
                  {
                    id: "call_abc123",
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
          usage: { prompt_tokens: 15, completion_tokens: 25, total_tokens: 40 }
        };

        const result = openrouterUtils.convertOpenRouterResponseToAnthropic(
          openRouterResponse,
          "test-model"
        );

        assert.strictEqual(result.content.length, 2);
        assert.strictEqual(result.content[0].type, "text");
        assert.strictEqual(result.content[1].type, "tool_use");
        assert.strictEqual(result.content[1].id, "call_abc123");
        assert.strictEqual(result.content[1].name, "Read");
        assert.deepStrictEqual(result.content[1].input, { file_path: "/tmp/test.txt" });
        assert.strictEqual(result.stop_reason, "tool_use");
      });

      it("should convert response with multiple tool calls", () => {
        const openRouterResponse = {
          choices: [
            {
              message: {
                role: "assistant",
                content: "Processing multiple operations",
                tool_calls: [
                  {
                    id: "call_1",
                    type: "function",
                    function: {
                      name: "Read",
                      arguments: JSON.stringify({ file_path: "/input.txt" })
                    }
                  },
                  {
                    id: "call_2",
                    type: "function",
                    function: {
                      name: "Write",
                      arguments: JSON.stringify({
                        file_path: "/output.txt",
                        content: "result"
                      })
                    }
                  }
                ]
              },
              finish_reason: "tool_calls"
            }
          ],
          model: "openai/gpt-4o-mini",
          usage: { prompt_tokens: 20, completion_tokens: 40, total_tokens: 60 }
        };

        const result = openrouterUtils.convertOpenRouterResponseToAnthropic(
          openRouterResponse,
          "test-model"
        );

        assert.strictEqual(result.content.length, 3); // 1 text + 2 tool_use
        assert.strictEqual(result.content[0].type, "text");
        assert.strictEqual(result.content[1].type, "tool_use");
        assert.strictEqual(result.content[1].name, "Read");
        assert.strictEqual(result.content[2].type, "tool_use");
        assert.strictEqual(result.content[2].name, "Write");
      });

      it("should generate unique IDs for tools", () => {
        const openRouterResponse = {
          choices: [
            {
              message: {
                role: "assistant",
                content: "Using tools",
                tool_calls: [
                  {
                    id: "call_1",
                    type: "function",
                    function: { name: "Tool1", arguments: "{}" }
                  },
                  {
                    id: "call_2",
                    type: "function",
                    function: { name: "Tool2", arguments: "{}" }
                  }
                ]
              },
              finish_reason: "tool_calls"
            }
          ],
          model: "test-model",
          usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 }
        };

        const result = openrouterUtils.convertOpenRouterResponseToAnthropic(
          openRouterResponse,
          "test-model"
        );

        const tool1Id = result.content[1].id;
        const tool2Id = result.content[2].id;

        assert.strictEqual(tool1Id !== tool2Id, true);
        assert.strictEqual(typeof tool1Id, "string");
        assert.strictEqual(typeof tool2Id, "string");
      });

      it("should map finish_reason correctly", () => {
        const testCases = [
          { finish_reason: "stop", expected: "end_turn" },
          { finish_reason: "tool_calls", expected: "tool_use" },
          { finish_reason: "length", expected: "max_tokens" }
        ];

        testCases.forEach(({ finish_reason, expected }) => {
          const response = {
            choices: [
              {
                message: {
                  role: "assistant",
                  content: "Test",
                  ...(finish_reason === "tool_calls" && {
                    tool_calls: [
                      {
                        id: "test",
                        function: { name: "test", arguments: "{}" }
                      }
                    ]
                  })
                },
                finish_reason
              }
            ],
            model: "test-model",
            usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 }
          };

          const result = openrouterUtils.convertOpenRouterResponseToAnthropic(
            response,
            "test-model"
          );

          assert.strictEqual(result.stop_reason, expected);
        });
      });

      it("should include proper message ID format", () => {
        const response = {
          choices: [
            {
              message: {
                role: "assistant",
                content: "Response"
              },
              finish_reason: "stop"
            }
          ],
          id: "chatcmpl-123",
          model: "openai/gpt-4o-mini",
          usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 }
        };

        const result = openrouterUtils.convertOpenRouterResponseToAnthropic(
          response,
          "test-model"
        );

        assert.strictEqual(typeof result.id, "string");
        assert.strictEqual(result.id.length > 0, true);
      });

      it("should preserve usage metadata", () => {
        const response = {
          choices: [
            {
              message: {
                role: "assistant",
                content: "Test"
              },
              finish_reason: "stop"
            }
          ],
          model: "openai/gpt-4o-mini",
          usage: {
            prompt_tokens: 100,
            completion_tokens: 50,
            total_tokens: 150
          }
        };

        const result = openrouterUtils.convertOpenRouterResponseToAnthropic(
          response,
          "test-model"
        );

        assert.strictEqual(result.usage.input_tokens, 100);
        assert.strictEqual(result.usage.output_tokens, 50);
      });
    });
  });

  describe("Round-Trip Conversion", () => {
    it("should maintain data integrity through round-trip conversion", () => {
      const originalMessage = {
        role: "user",
        content: "Please write to /tmp/test.txt"
      };

      // Convert to OpenRouter
      const openRouterFormat = openrouterUtils.convertAnthropicMessagesToOpenRouter([
        originalMessage
      ]);

      // Verify conversion
      assert.strictEqual(openRouterFormat[0].role, "user");
      assert.strictEqual(openRouterFormat[0].content, "Please write to /tmp/test.txt");
    });

    it("should handle complex conversation with tools", () => {
      const conversation = [
        {
          role: "user",
          content: "Read /tmp/input.txt and write to /tmp/output.txt"
        },
        {
          role: "assistant",
          content: [
            { type: "text", text: "I'll do that for you" },
            {
              type: "tool_use",
              id: "toolu_1",
              name: "Read",
              input: { file_path: "/tmp/input.txt" }
            }
          ]
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_1",
              content: "File contents"
            }
          ]
        }
      ];

      // Convert to OpenRouter
      const openRouterFormat = openrouterUtils.convertAnthropicMessagesToOpenRouter(
        conversation
      );

      // Verify structure is maintained
      assert.strictEqual(openRouterFormat.length >= 3, true);

      // Check user message
      const userMsgs = openRouterFormat.filter(m => m.role === "user");
      assert.strictEqual(userMsgs.length >= 1, true);

      // Check assistant message with tool calls
      const assistantMsgs = openRouterFormat.filter(m => m.role === "assistant");
      assert.strictEqual(assistantMsgs.length >= 1, true);
      assert.strictEqual(Array.isArray(assistantMsgs[0].tool_calls), true);

      // Check tool message
      const toolMsgs = openRouterFormat.filter(m => m.role === "tool");
      assert.strictEqual(toolMsgs.length >= 1, true);
    });
  });
});

describe("reasoning_content passback for thinking models (kimi/minimax multi-turn)", () => {
  const { convertAnthropicMessagesToOpenRouter } = require("../src/clients/openrouter-utils");

  it("re-emits assistant thinking blocks as reasoning_content alongside tool_calls", () => {
    const out = convertAnthropicMessagesToOpenRouter([
      { role: "user", content: "review the orchestrator" },
      { role: "assistant", content: [
        { type: "thinking", thinking: "I should list the directory first, then read index.js" },
        { type: "text", text: "Let me look around." },
        { type: "tool_use", id: "t1", name: "Read", input: { file_path: "src/orchestrator/index.js" } },
      ]},
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "…file…" }] },
    ]);
    const assistant = out.find(m => m.role === "assistant");
    assert.ok(assistant.tool_calls?.length === 1);
    assert.match(assistant.reasoning_content, /list the directory first/);
  });

  it("re-emits thinking on plain assistant turns too", () => {
    const out = convertAnthropicMessagesToOpenRouter([
      { role: "assistant", content: [
        { type: "thinking", thinking: "the user greeted me" },
        { type: "text", text: "Hello!" },
      ]},
    ]);
    assert.strictEqual(out[0].reasoning_content, "the user greeted me");
    assert.strictEqual(out[0].content, "Hello!");
  });

  it("omits reasoning_content when there was no thinking", () => {
    const out = convertAnthropicMessagesToOpenRouter([
      { role: "assistant", content: [{ type: "text", text: "plain" }] },
    ]);
    assert.strictEqual("reasoning_content" in out[0], false);
  });
});
