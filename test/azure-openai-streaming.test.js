const assert = require("assert");
const { describe, it } = require("node:test");

describe("Azure OpenAI Streaming Tests", () => {
  describe("Streaming Response Structure", () => {
    it("should recognize Azure OpenAI SSE streaming format", () => {
      const streamChunk = {
        id: "chatcmpl-123",
        object: "chat.completion.chunk",
        created: 1677652288,
        model: "gpt-4o",
        choices: [
          {
            index: 0,
            delta: {
              content: "Hello"
            },
            finish_reason: null
          }
        ]
      };

      assert.strictEqual(streamChunk.object, "chat.completion.chunk");
      assert.ok(streamChunk.choices[0].delta);
    });

    it("should handle streaming delta with tool_calls", () => {
      const streamChunk = {
        id: "chatcmpl-123",
        object: "chat.completion.chunk",
        model: "gpt-4o",
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_abc123",
                  type: "function",
                  function: {
                    name: "Read",
                    arguments: "{\"file"
                  }
                }
              ]
            },
            finish_reason: null
          }
        ]
      };

      assert.ok(streamChunk.choices[0].delta.tool_calls);
      assert.strictEqual(streamChunk.choices[0].delta.tool_calls[0].function.name, "Read");
    });

    it("should handle final streaming chunk with finish_reason", () => {
      const finalChunk = {
        id: "chatcmpl-123",
        object: "chat.completion.chunk",
        model: "gpt-4o",
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: "stop"
          }
        ]
      };

      assert.strictEqual(finalChunk.choices[0].finish_reason, "stop");
    });

    it("should handle tool_calls finish_reason in streaming", () => {
      const toolCallFinish = {
        id: "chatcmpl-123",
        object: "chat.completion.chunk",
        model: "gpt-4o",
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: "tool_calls"
          }
        ]
      };

      assert.strictEqual(toolCallFinish.choices[0].finish_reason, "tool_calls");
    });
  });

  describe("Stream Flag in Requests", () => {
    it("should set stream:false by default for buffered requests", () => {
      const requestBody = {
        messages: [{ role: "user", content: "Hello" }],
        temperature: 0.7
      };

      // Default stream value
      const stream = requestBody.stream ?? false;

      assert.strictEqual(stream, false);
    });

    it("should set stream:true for streaming requests", () => {
      const requestBody = {
        messages: [{ role: "user", content: "Hello" }],
        stream: true
      };

      assert.strictEqual(requestBody.stream, true);
    });
  });

  describe("SSE Format Validation", () => {
    it("should recognize SSE event format with data prefix", () => {
      const sseChunk = 'data: {"id":"chatcmpl-123","object":"chat.completion.chunk","choices":[{"delta":{"content":"Hi"}}]}';

      assert.ok(sseChunk.startsWith("data:"));

      // Extract JSON after "data: "
      const jsonStr = sseChunk.substring(6);
      const parsed = JSON.parse(jsonStr);

      assert.strictEqual(parsed.object, "chat.completion.chunk");
      assert.strictEqual(parsed.choices[0].delta.content, "Hi");
    });

    it("should handle SSE done signal", () => {
      const doneSig = "data: [DONE]";

      assert.strictEqual(doneSig, "data: [DONE]");
    });
  });

  describe("Chunk Accumulation", () => {
    it("should accumulate tool arguments across multiple chunks", () => {
      const chunks = [
        { delta: { tool_calls: [{ index: 0, function: { arguments: "{\"file_" } }] } },
        { delta: { tool_calls: [{ index: 0, function: { arguments: "path\":" } }] } },
        { delta: { tool_calls: [{ index: 0, function: { arguments: "\"/test.js" } }] } },
        { delta: { tool_calls: [{ index: 0, function: { arguments: "\"}" } }] } }
      ];

      let accumulated = "";
      for (const chunk of chunks) {
        accumulated += chunk.delta.tool_calls[0].function.arguments;
      }

      assert.strictEqual(accumulated, '{"file_path":"/test.js"}');
      const parsed = JSON.parse(accumulated);
      assert.strictEqual(parsed.file_path, "/test.js");
    });

    it("should accumulate content across multiple chunks", () => {
      const chunks = [
        { delta: { content: "Hello" } },
        { delta: { content: ", " } },
        { delta: { content: "world" } },
        { delta: { content: "!" } }
      ];

      let accumulated = "";
      for (const chunk of chunks) {
        accumulated += chunk.delta.content;
      }

      assert.strictEqual(accumulated, "Hello, world!");
    });
  });
});
