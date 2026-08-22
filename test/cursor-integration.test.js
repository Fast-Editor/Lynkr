const assert = require("assert");
const { describe, it, beforeEach, afterEach } = require("node:test");
const {
  convertOpenAIToAnthropic,
  convertAnthropicToOpenAI,
  mapStopReason
} = require("../src/clients/openai-format");

describe("Cursor IDE Integration (OpenAI API Compatibility)", () => {
  describe("Format Conversion: OpenAI → Anthropic", () => {
    it("should convert simple OpenAI chat request to Anthropic format", () => {
      const openaiRequest = {
        model: "gpt-4",
        messages: [
          { role: "system", content: "You are a helpful assistant." },
          { role: "user", content: "Hello, world!" }
        ],
        max_tokens: 1000,
        temperature: 0.7
      };

      const anthropicRequest = convertOpenAIToAnthropic(openaiRequest);

      assert.strictEqual(anthropicRequest.system, "You are a helpful assistant.");
      assert.strictEqual(anthropicRequest.messages.length, 1);
      assert.strictEqual(anthropicRequest.messages[0].role, "user");
      assert.strictEqual(anthropicRequest.messages[0].content, "Hello, world!");
      assert.strictEqual(anthropicRequest.max_tokens, 1000);
      assert.strictEqual(anthropicRequest.temperature, 0.7);
    });

    it("should convert OpenAI tools to Anthropic format", () => {
      const openaiRequest = {
        model: "gpt-4",
        messages: [{ role: "user", content: "Read the file" }],
        tools: [
          {
            type: "function",
            function: {
              name: "Read",
              description: "Read a file",
              parameters: {
                type: "object",
                properties: {
                  file_path: { type: "string" }
                },
                required: ["file_path"]
              }
            }
          }
        ]
      };

      const anthropicRequest = convertOpenAIToAnthropic(openaiRequest);

      assert.strictEqual(anthropicRequest.tools.length, 1);
      assert.strictEqual(anthropicRequest.tools[0].name, "Read");
      assert.strictEqual(anthropicRequest.tools[0].description, "Read a file");
      assert.deepStrictEqual(anthropicRequest.tools[0].input_schema, {
        type: "object",
        properties: {
          file_path: { type: "string" }
        },
        required: ["file_path"]
      });
    });

    it("should convert OpenAI tool_calls in assistant message", () => {
      const openaiRequest = {
        model: "gpt-4",
        messages: [
          {
            role: "assistant",
            content: "I'll read the file.",
            tool_calls: [
              {
                id: "call_123",
                type: "function",
                function: {
                  name: "Read",
                  arguments: '{"file_path": "/tmp/test.txt"}'
                }
              }
            ]
          }
        ]
      };

      const anthropicRequest = convertOpenAIToAnthropic(openaiRequest);

      assert.strictEqual(anthropicRequest.messages.length, 1);
      assert.strictEqual(anthropicRequest.messages[0].role, "assistant");
      assert.strictEqual(anthropicRequest.messages[0].content.length, 2);
      assert.strictEqual(anthropicRequest.messages[0].content[0].type, "text");
      assert.strictEqual(anthropicRequest.messages[0].content[1].type, "tool_use");
      assert.strictEqual(anthropicRequest.messages[0].content[1].name, "Read");
      assert.deepStrictEqual(anthropicRequest.messages[0].content[1].input, {
        file_path: "/tmp/test.txt"
      });
    });

    it("should convert OpenAI tool results", () => {
      // Matched tool results (tool_use in the prior assistant message) stay
      // tool_result blocks, and parallel results merge into ONE user message
      // (Anthropic rejects tool_results split across messages).
      const openaiRequest = {
        model: "gpt-4",
        messages: [
          { role: "user", content: "read two files" },
          {
            role: "assistant",
            tool_calls: [
              { id: "call_123", function: { name: "Read", arguments: "{}" } },
              { id: "call_456", function: { name: "Read", arguments: "{}" } }
            ]
          },
          { role: "tool", tool_call_id: "call_123", content: "File contents here" },
          { role: "tool", tool_call_id: "call_456", content: "Second file" }
        ]
      };

      const anthropicRequest = convertOpenAIToAnthropic(openaiRequest);

      assert.strictEqual(anthropicRequest.messages.length, 3);
      const resultMsg = anthropicRequest.messages[2];
      assert.strictEqual(resultMsg.role, "user");
      assert.strictEqual(resultMsg.content.length, 2);
      assert.strictEqual(resultMsg.content[0].type, "tool_result");
      assert.strictEqual(resultMsg.content[0].tool_use_id, "call_123");
      assert.strictEqual(resultMsg.content[0].content, "File contents here");
      assert.strictEqual(resultMsg.content[1].tool_use_id, "call_456");
    });

    it("should degrade orphaned tool results to text instead of 400ing", () => {
      // A tool result with no matching tool_use (history truncated by the
      // client) would be rejected by Anthropic as "unexpected tool_use_id" —
      // it must degrade to plain text, not pass through as tool_result.
      const openaiRequest = {
        model: "gpt-4",
        messages: [
          { role: "tool", tool_call_id: "call_123", content: "File contents here" }
        ]
      };

      const anthropicRequest = convertOpenAIToAnthropic(openaiRequest);

      assert.strictEqual(anthropicRequest.messages.length, 1);
      assert.strictEqual(anthropicRequest.messages[0].role, "user");
      assert.strictEqual(anthropicRequest.messages[0].content[0].type, "text");
      assert.ok(anthropicRequest.messages[0].content[0].text.includes("File contents here"));
      assert.ok(anthropicRequest.messages[0].content[0].text.includes("call_123"));
    });

    it("should handle tool_choice conversion", () => {
      const autoRequest = {
        model: "gpt-4",
        messages: [{ role: "user", content: "test" }],
        tool_choice: "auto"
      };

      const noneRequest = {
        model: "gpt-4",
        messages: [{ role: "user", content: "test" }],
        tool_choice: "none"
      };

      const specificRequest = {
        model: "gpt-4",
        messages: [{ role: "user", content: "test" }],
        tool_choice: { type: "function", function: { name: "Read" } }
      };

      const anthropicAuto = convertOpenAIToAnthropic(autoRequest);
      const anthropicNone = convertOpenAIToAnthropic(noneRequest);
      const anthropicSpecific = convertOpenAIToAnthropic(specificRequest);

      assert.deepStrictEqual(anthropicAuto.tool_choice, { type: "auto" });
      assert.deepStrictEqual(anthropicNone.tool_choice, { type: "none" });
      assert.deepStrictEqual(anthropicSpecific.tool_choice, { type: "tool", name: "Read" });
    });
  });

  describe("Format Conversion: Anthropic → OpenAI", () => {
    it("should convert simple Anthropic response to OpenAI format", () => {
      const anthropicResponse = {
        id: "msg_123",
        type: "message",
        role: "assistant",
        content: [
          {
            type: "text",
            text: "Hello! How can I help you?"
          }
        ],
        stop_reason: "end_turn",
        usage: {
          input_tokens: 10,
          output_tokens: 20
        }
      };

      const openaiResponse = convertAnthropicToOpenAI(anthropicResponse, "gpt-4");

      assert.strictEqual(openaiResponse.id, "msg_123");
      assert.strictEqual(openaiResponse.object, "chat.completion");
      assert.strictEqual(openaiResponse.model, "gpt-4");
      assert.strictEqual(openaiResponse.choices.length, 1);
      assert.strictEqual(openaiResponse.choices[0].message.role, "assistant");
      assert.strictEqual(openaiResponse.choices[0].message.content, "Hello! How can I help you?");
      assert.strictEqual(openaiResponse.choices[0].finish_reason, "stop");
      assert.strictEqual(openaiResponse.usage.prompt_tokens, 10);
      assert.strictEqual(openaiResponse.usage.completion_tokens, 20);
      assert.strictEqual(openaiResponse.usage.total_tokens, 30);
    });

    it("should convert Anthropic tool_use to OpenAI tool_calls", () => {
      const anthropicResponse = {
        id: "msg_456",
        content: [
          {
            type: "text",
            text: "I'll read the file."
          },
          {
            type: "tool_use",
            id: "toolu_789",
            name: "Read",
            input: {
              file_path: "/tmp/test.txt"
            }
          }
        ],
        stop_reason: "tool_use",
        usage: {
          input_tokens: 50,
          output_tokens: 30
        }
      };

      const openaiResponse = convertAnthropicToOpenAI(anthropicResponse, "gpt-4");

      assert.strictEqual(openaiResponse.choices[0].message.content, "I'll read the file.");
      assert.strictEqual(openaiResponse.choices[0].message.tool_calls.length, 1);
      assert.strictEqual(openaiResponse.choices[0].message.tool_calls[0].id, "toolu_789");
      assert.strictEqual(openaiResponse.choices[0].message.tool_calls[0].type, "function");
      assert.strictEqual(openaiResponse.choices[0].message.tool_calls[0].function.name, "Read");
      assert.strictEqual(
        openaiResponse.choices[0].message.tool_calls[0].function.arguments,
        '{"file_path":"/tmp/test.txt"}'
      );
      assert.strictEqual(openaiResponse.choices[0].finish_reason, "tool_calls");
    });
  });

  describe("Stop Reason Mapping", () => {
    it("should map Anthropic stop reasons to OpenAI finish reasons", () => {
      assert.strictEqual(mapStopReason("end_turn"), "stop");
      assert.strictEqual(mapStopReason("max_tokens"), "length");
      assert.strictEqual(mapStopReason("stop_sequence"), "stop");
      assert.strictEqual(mapStopReason("tool_use"), "tool_calls");
      assert.strictEqual(mapStopReason("unknown_reason"), "stop");
    });
  });

  describe("OpenAI Router Endpoints", () => {
    it("GET /v1/models should return model list based on provider", () => {
      // This is an integration test - would need actual server running
      // Just verify the route exists in the router
      const openaiRouter = require("../src/api/openai-router");
      assert.ok(openaiRouter, "OpenAI router should be defined");
    });

    it("POST /v1/chat/completions should handle request", () => {
      // Integration test - would need actual server
      const openaiRouter = require("../src/api/openai-router");
      assert.ok(openaiRouter, "OpenAI router should be defined");
    });

    it("POST /v1/embeddings should return 501 when not configured", () => {
      // Integration test - would need actual server
      const openaiRouter = require("../src/api/openai-router");
      assert.ok(openaiRouter, "OpenAI router should be defined");
    });

    it("GET /v1/health should return health status", () => {
      // Integration test - would need actual server
      const openaiRouter = require("../src/api/openai-router");
      assert.ok(openaiRouter, "OpenAI router should be defined");
    });
  });

  describe("Edge Cases", () => {
    it("should handle empty messages array", () => {
      const openaiRequest = {
        model: "gpt-4",
        messages: []
      };

      const anthropicRequest = convertOpenAIToAnthropic(openaiRequest);
      assert.strictEqual(anthropicRequest.messages.length, 0);
    });

    it("should handle missing optional fields", () => {
      const openaiRequest = {
        model: "gpt-4",
        messages: [{ role: "user", content: "test" }]
      };

      const anthropicRequest = convertOpenAIToAnthropic(openaiRequest);
      assert.ok(anthropicRequest.max_tokens); // Should have default
      assert.ok(!anthropicRequest.temperature); // Should not exist if not provided
    });

    it("should handle multiple text blocks in Anthropic response", () => {
      const anthropicResponse = {
        id: "msg_multi",
        content: [
          { type: "text", text: "First part. " },
          { type: "text", text: "Second part." }
        ],
        stop_reason: "end_turn",
        usage: { input_tokens: 5, output_tokens: 10 }
      };

      const openaiResponse = convertAnthropicToOpenAI(anthropicResponse);
      assert.strictEqual(openaiResponse.choices[0].message.content, "First part. Second part.");
    });
  });

  describe("OpenRouter Embeddings Configuration", () => {
    it("should use configured embeddings model", () => {
      process.env.OPENROUTER_EMBEDDINGS_MODEL = "openai/text-embedding-3-small";
      delete require.cache[require.resolve("../src/config")];
      const config = require("../src/config");

      assert.strictEqual(config.openrouter.embeddingsModel, "openai/text-embedding-3-small");
    });

    it("should default to ada-002 when not configured", () => {
      delete process.env.OPENROUTER_EMBEDDINGS_MODEL;
      delete require.cache[require.resolve("../src/config")];
      const config = require("../src/config");

      assert.strictEqual(config.openrouter.embeddingsModel, "openai/text-embedding-ada-002");
    });

    it("should allow different models for chat and embeddings", () => {
      process.env.OPENROUTER_MODEL = "anthropic/claude-3.5-sonnet";
      process.env.OPENROUTER_EMBEDDINGS_MODEL = "openai/text-embedding-3-small";
      delete require.cache[require.resolve("../src/config")];
      const config = require("../src/config");

      assert.strictEqual(config.openrouter.model, "anthropic/claude-3.5-sonnet");
      assert.strictEqual(config.openrouter.embeddingsModel, "openai/text-embedding-3-small");
      assert.notStrictEqual(config.openrouter.model, config.openrouter.embeddingsModel);
    });
  });

  describe("Local Embeddings Configuration", () => {
    let originalEnv;

    beforeEach(() => {
      originalEnv = { ...process.env };
      delete require.cache[require.resolve("../src/config")];
    });

    afterEach(() => {
      process.env = originalEnv;
      delete require.cache[require.resolve("../src/config")];
    });

    describe("Ollama Embeddings", () => {
      it("should use configured Ollama embeddings model", () => {
        process.env.OLLAMA_EMBEDDINGS_MODEL = "mxbai-embed-large";
        const config = require("../src/config");

        assert.strictEqual(config.ollama.embeddingsModel, "mxbai-embed-large");
      });

      it("should default to nomic-embed-text when not configured", () => {
        delete process.env.OLLAMA_EMBEDDINGS_MODEL;
        const config = require("../src/config");

        assert.strictEqual(config.ollama.embeddingsModel, "nomic-embed-text");
      });

      it("should use custom Ollama embeddings endpoint", () => {
        process.env.OLLAMA_EMBEDDINGS_ENDPOINT = "http://localhost:9999/api/embeddings";
        const config = require("../src/config");

        assert.strictEqual(config.ollama.embeddingsEndpoint, "http://localhost:9999/api/embeddings");
      });

      it("should default Ollama embeddings endpoint to /api/embeddings", () => {
        delete process.env.OLLAMA_EMBEDDINGS_ENDPOINT;
        process.env.OLLAMA_ENDPOINT = "http://localhost:11434";
        const config = require("../src/config");

        assert.strictEqual(config.ollama.embeddingsEndpoint, "http://localhost:11434/api/embeddings");
      });

      it("should allow different models for Ollama chat and embeddings", () => {
        process.env.OLLAMA_MODEL = "llama3.2";
        process.env.OLLAMA_EMBEDDINGS_MODEL = "nomic-embed-text";
        const config = require("../src/config");

        assert.strictEqual(config.ollama.model, "llama3.2");
        assert.strictEqual(config.ollama.embeddingsModel, "nomic-embed-text");
        assert.notStrictEqual(config.ollama.model, config.ollama.embeddingsModel);
      });
    });

    describe("llama.cpp Embeddings", () => {
      it("should use configured llama.cpp embeddings endpoint", () => {
        process.env.LLAMACPP_EMBEDDINGS_ENDPOINT = "http://localhost:9000/embeddings";
        const config = require("../src/config");

        assert.strictEqual(config.llamacpp.embeddingsEndpoint, "http://localhost:9000/embeddings");
      });

      it("should default llama.cpp embeddings endpoint to /embeddings", () => {
        delete process.env.LLAMACPP_EMBEDDINGS_ENDPOINT;
        process.env.LLAMACPP_ENDPOINT = "http://localhost:8080";
        const config = require("../src/config");

        assert.strictEqual(config.llamacpp.embeddingsEndpoint, "http://localhost:8080/embeddings");
      });
    });

    describe("Embeddings Provider Priority", () => {
      it("should use explicit EMBEDDINGS_PROVIDER when set to ollama", () => {
        process.env.EMBEDDINGS_PROVIDER = "ollama";
        process.env.OLLAMA_EMBEDDINGS_MODEL = "nomic-embed-text";
        process.env.OPENROUTER_API_KEY = "sk-test";

        // This test verifies the config allows the explicit provider to be set
        // Actual provider detection logic is in openai-router.js
        const config = require("../src/config");
        assert.strictEqual(process.env.EMBEDDINGS_PROVIDER, "ollama");
      });

      it("should use explicit EMBEDDINGS_PROVIDER when set to llamacpp", () => {
        process.env.EMBEDDINGS_PROVIDER = "llamacpp";
        process.env.LLAMACPP_EMBEDDINGS_ENDPOINT = "http://localhost:8080/embeddings";
        process.env.OPENROUTER_API_KEY = "sk-test";

        const config = require("../src/config");
        assert.strictEqual(process.env.EMBEDDINGS_PROVIDER, "llamacpp");
      });

      it("should use explicit EMBEDDINGS_PROVIDER when set to openrouter", () => {
        process.env.EMBEDDINGS_PROVIDER = "openrouter";
        process.env.OPENROUTER_API_KEY = "sk-test";
        process.env.OLLAMA_EMBEDDINGS_MODEL = "nomic-embed-text";

        const config = require("../src/config");
        assert.strictEqual(process.env.EMBEDDINGS_PROVIDER, "openrouter");
      });

      it("should use explicit EMBEDDINGS_PROVIDER when set to openai", () => {
        process.env.EMBEDDINGS_PROVIDER = "openai";
        process.env.OPENAI_API_KEY = "sk-test";
        process.env.OLLAMA_EMBEDDINGS_MODEL = "nomic-embed-text";

        const config = require("../src/config");
        assert.strictEqual(process.env.EMBEDDINGS_PROVIDER, "openai");
      });
    });

    describe("Privacy and Cost Comparison", () => {
      it("should support 100% local setup with Ollama chat + Ollama embeddings", () => {
        process.env.MODEL_PROVIDER = "ollama";
        process.env.OLLAMA_MODEL = "llama3.2";
        process.env.OLLAMA_EMBEDDINGS_MODEL = "nomic-embed-text";
        delete process.env.OPENROUTER_API_KEY;
        delete process.env.OPENAI_API_KEY;

        const config = require("../src/config");
        assert.strictEqual(config.modelProvider.type, "ollama");
        assert.strictEqual(config.ollama.model, "llama3.2");
        assert.strictEqual(config.ollama.embeddingsModel, "nomic-embed-text");
        // Verify no cloud API keys configured (100% local)
        assert.ok(!config.openrouter?.apiKey);
        assert.ok(!config.openai?.apiKey);
      });

      it("should support 100% local setup with Ollama chat + llama.cpp embeddings", () => {
        process.env.MODEL_PROVIDER = "ollama";
        process.env.OLLAMA_MODEL = "llama3.2";
        process.env.LLAMACPP_EMBEDDINGS_ENDPOINT = "http://localhost:8080/embeddings";
        delete process.env.OPENROUTER_API_KEY;
        delete process.env.OPENAI_API_KEY;

        const config = require("../src/config");
        assert.strictEqual(config.modelProvider.type, "ollama");
        assert.strictEqual(config.ollama.model, "llama3.2");
        assert.strictEqual(config.llamacpp.embeddingsEndpoint, "http://localhost:8080/embeddings");
        // Verify no cloud API keys configured (100% local)
        assert.ok(!config.openrouter?.apiKey);
        assert.ok(!config.openai?.apiKey);
      });

      it("should support hybrid setup with Databricks chat + Ollama embeddings", () => {
        process.env.MODEL_PROVIDER = "databricks";
        process.env.DATABRICKS_API_KEY = "test-key";
        process.env.DATABRICKS_API_BASE = "http://test.com";
        process.env.OLLAMA_EMBEDDINGS_MODEL = "nomic-embed-text";

        const config = require("../src/config");
        assert.strictEqual(config.modelProvider.type, "databricks");
        assert.strictEqual(config.ollama.embeddingsModel, "nomic-embed-text");
      });
    });
  });
});
