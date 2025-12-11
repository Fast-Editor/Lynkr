const assert = require("assert");
const { describe, it, beforeEach } = require("node:test");

describe("Azure OpenAI Format Conversion", () => {
  let openrouterUtils;

  beforeEach(() => {
    // Clear module cache
    delete require.cache[require.resolve("../src/clients/openrouter-utils")];
    openrouterUtils = require("../src/clients/openrouter-utils");
  });

  describe("Anthropic to Azure OpenAI (OpenAI format) Conversion", () => {
    it("should convert simple Anthropic messages to OpenAI format", () => {
      const anthropicMessages = [
        {
          role: "user",
          content: "Hello, Azure OpenAI!"
        }
      ];

      const result = openrouterUtils.convertAnthropicMessagesToOpenRouter(anthropicMessages);

      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].role, "user");
      assert.strictEqual(result[0].content, "Hello, Azure OpenAI!");
    });

    it("should convert Anthropic content blocks to OpenAI text content", () => {
      const anthropicMessages = [
        {
          role: "user",
          content: [
            { type: "text", text: "Analyze this code" },
            { type: "text", text: "and provide feedback" }
          ]
        }
      ];

      const result = openrouterUtils.convertAnthropicMessagesToOpenRouter(anthropicMessages);

      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].content, "Analyze this code\nand provide feedback");
    });

    it("should convert Anthropic tool_use to OpenAI tool_calls", () => {
      const anthropicMessages = [
        {
          role: "assistant",
          content: [
            { type: "text", text: "I'll read that file" },
            {
              type: "tool_use",
              id: "toolu_abc123",
              name: "Read",
              input: { file_path: "/app/test.js" }
            }
          ]
        }
      ];

      const result = openrouterUtils.convertAnthropicMessagesToOpenRouter(anthropicMessages);

      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].role, "assistant");
      assert.strictEqual(result[0].content, "I'll read that file");
      assert.ok(Array.isArray(result[0].tool_calls));
      assert.strictEqual(result[0].tool_calls.length, 1);
      assert.strictEqual(result[0].tool_calls[0].id, "toolu_abc123");
      assert.strictEqual(result[0].tool_calls[0].type, "function");
      assert.strictEqual(result[0].tool_calls[0].function.name, "Read");
      assert.strictEqual(result[0].tool_calls[0].function.arguments, '{"file_path":"/app/test.js"}');
    });

    it("should convert Anthropic tool definitions to OpenAI tools format", () => {
      const anthropicTools = [
        {
          name: "Write",
          description: "Write content to a file",
          input_schema: {
            type: "object",
            properties: {
              file_path: { type: "string" },
              content: { type: "string" }
            },
            required: ["file_path", "content"]
          }
        }
      ];

      const result = openrouterUtils.convertAnthropicToolsToOpenRouter(anthropicTools);

      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].type, "function");
      assert.strictEqual(result[0].function.name, "Write");
      assert.strictEqual(result[0].function.description, "Write content to a file");
      assert.deepStrictEqual(result[0].function.parameters, anthropicTools[0].input_schema);
    });

    it("should handle multiple tool conversions", () => {
      const anthropicTools = [
        {
          name: "Read",
          description: "Read file",
          input_schema: {
            type: "object",
            properties: { file_path: { type: "string" } }
          }
        },
        {
          name: "Write",
          description: "Write file",
          input_schema: {
            type: "object",
            properties: { file_path: { type: "string" }, content: { type: "string" } }
          }
        }
      ];

      const result = openrouterUtils.convertAnthropicToolsToOpenRouter(anthropicTools);

      assert.strictEqual(result.length, 2);
      assert.strictEqual(result[0].function.name, "Read");
      assert.strictEqual(result[1].function.name, "Write");
    });
  });

  describe("Azure OpenAI to Anthropic Conversion", () => {
    it("should convert OpenAI text response to Anthropic format", () => {
      const azureOpenAIResponse = {
        choices: [
          {
            message: {
              role: "assistant",
              content: "Hello from Azure OpenAI!"
            },
            finish_reason: "stop"
          }
        ],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 5,
          total_tokens: 15
        }
      };

      const result = openrouterUtils.convertOpenRouterResponseToAnthropic(
        azureOpenAIResponse,
        "gpt-4o"
      );

      assert.strictEqual(result.role, "assistant");
      assert.ok(Array.isArray(result.content));
      assert.strictEqual(result.content.length, 1);
      assert.strictEqual(result.content[0].type, "text");
      assert.strictEqual(result.content[0].text, "Hello from Azure OpenAI!");
      assert.strictEqual(result.stop_reason, "end_turn");
      assert.strictEqual(result.usage.input_tokens, 10);
      assert.strictEqual(result.usage.output_tokens, 5);
    });

    it("should convert OpenAI tool_calls to Anthropic tool_use", () => {
      const azureOpenAIResponse = {
        choices: [
          {
            message: {
              role: "assistant",
              content: "I'll execute that bash command",
              tool_calls: [
                {
                  id: "call_xyz789",
                  type: "function",
                  function: {
                    name: "Bash",
                    arguments: '{"command": "ls -la"}'
                  }
                }
              ]
            },
            finish_reason: "tool_calls"
          }
        ],
        usage: {
          prompt_tokens: 20,
          completion_tokens: 10
        }
      };

      const result = openrouterUtils.convertOpenRouterResponseToAnthropic(
        azureOpenAIResponse,
        "gpt-4o"
      );

      assert.strictEqual(result.role, "assistant");
      assert.ok(Array.isArray(result.content));
      assert.strictEqual(result.content.length, 2);

      // Text content
      assert.strictEqual(result.content[0].type, "text");
      assert.strictEqual(result.content[0].text, "I'll execute that bash command");

      // Tool use
      assert.strictEqual(result.content[1].type, "tool_use");
      assert.strictEqual(result.content[1].id, "call_xyz789");
      assert.strictEqual(result.content[1].name, "Bash");
      assert.deepStrictEqual(result.content[1].input, { command: "ls -la" });

      assert.strictEqual(result.stop_reason, "tool_use");
    });

    it("should handle multiple tool calls", () => {
      const azureOpenAIResponse = {
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
                    arguments: '{"file_path": "/app/file1.js"}'
                  }
                },
                {
                  id: "call_2",
                  type: "function",
                  function: {
                    name: "Read",
                    arguments: '{"file_path": "/app/file2.js"}'
                  }
                }
              ]
            },
            finish_reason: "tool_calls"
          }
        ]
      };

      const result = openrouterUtils.convertOpenRouterResponseToAnthropic(
        azureOpenAIResponse,
        "gpt-4o"
      );

      assert.strictEqual(result.content.length, 2);
      assert.strictEqual(result.content[0].type, "tool_use");
      assert.strictEqual(result.content[0].name, "Read");
      assert.strictEqual(result.content[1].type, "tool_use");
      assert.strictEqual(result.content[1].name, "Read");
    });

    it("should handle empty/null content gracefully", () => {
      const azureOpenAIResponse = {
        choices: [
          {
            message: {
              role: "assistant",
              content: null
            },
            finish_reason: "stop"
          }
        ]
      };

      const result = openrouterUtils.convertOpenRouterResponseToAnthropic(
        azureOpenAIResponse,
        "gpt-4o"
      );

      assert.strictEqual(result.role, "assistant");
      assert.ok(Array.isArray(result.content));
      // OpenRouter utils creates an empty text block for null content
      assert.strictEqual(result.content.length, 1);
      assert.strictEqual(result.content[0].type, "text");
      assert.strictEqual(result.content[0].text, "");
    });

    it("should convert finish_reason correctly", () => {
      const stopResponse = {
        choices: [{ message: { role: "assistant", content: "Done" }, finish_reason: "stop" }]
      };
      const toolCallsResponse = {
        choices: [{
          message: { role: "assistant", content: null, tool_calls: [{ id: "1", type: "function", function: { name: "Test", arguments: "{}" } }] },
          finish_reason: "tool_calls"
        }]
      };
      const lengthResponse = {
        choices: [{ message: { role: "assistant", content: "Text" }, finish_reason: "length" }]
      };

      const stopResult = openrouterUtils.convertOpenRouterResponseToAnthropic(stopResponse, "gpt-4o");
      const toolCallsResult = openrouterUtils.convertOpenRouterResponseToAnthropic(toolCallsResponse, "gpt-4o");
      const lengthResult = openrouterUtils.convertOpenRouterResponseToAnthropic(lengthResponse, "gpt-4o");

      assert.strictEqual(stopResult.stop_reason, "end_turn");
      assert.strictEqual(toolCallsResult.stop_reason, "tool_use");
      assert.strictEqual(lengthResult.stop_reason, "max_tokens");
    });
  });

  describe("Round-Trip Integrity", () => {
    it("should maintain data integrity through Anthropic -> OpenAI -> Anthropic conversion", () => {
      // Original Anthropic format
      const originalTools = [
        {
          name: "Bash",
          description: "Execute bash command",
          input_schema: {
            type: "object",
            properties: {
              command: { type: "string", description: "The command to execute" }
            },
            required: ["command"]
          }
        }
      ];

      // Convert to OpenAI format
      const openAITools = openrouterUtils.convertAnthropicToolsToOpenRouter(originalTools);

      // Verify OpenAI format structure
      assert.strictEqual(openAITools[0].type, "function");
      assert.strictEqual(openAITools[0].function.name, "Bash");
      assert.strictEqual(openAITools[0].function.description, "Execute bash command");

      // Verify schema is preserved
      assert.deepStrictEqual(openAITools[0].function.parameters, originalTools[0].input_schema);
    });

    it("should handle text-only conversation round-trip", () => {
      const anthropicMessages = [
        { role: "user", content: "Hello" },
        { role: "assistant", content: [{ type: "text", text: "Hi there!" }] },
        { role: "user", content: "How are you?" }
      ];

      const openAIMessages = openrouterUtils.convertAnthropicMessagesToOpenRouter(anthropicMessages);

      assert.strictEqual(openAIMessages.length, 3);
      assert.strictEqual(openAIMessages[0].content, "Hello");
      assert.strictEqual(openAIMessages[1].content, "Hi there!");
      assert.strictEqual(openAIMessages[2].content, "How are you?");
    });
  });
});
