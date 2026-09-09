/**
 * Fireworks AI error resilience.
 *
 * Fireworks rides the shared OpenAI↔Anthropic converters, so this file pins
 * the converter behaviors the Fireworks path depends on most — especially
 * the cases that differ across OpenAI-compatible upstreams in production:
 * finish_reason "stop" arriving WITH tool_calls (the Moonshot precedent),
 * missing/empty choices, and upstream error payloads passing through
 * without being mistaken for completions.
 */

const assert = require("assert");
const { describe, it } = require("node:test");

const { convertOpenAIToAnthropic } = require("../src/clients/databricks");

function toolCallCompletion({ finishReason = "tool_calls", content = null } = {}) {
  return {
    id: "chatcmpl-fw",
    object: "chat.completion",
    created: 0,
    model: "accounts/fireworks/models/kimi-k2-instruct-0905",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content,
          tool_calls: [
            {
              id: "call_fw1",
              type: "function",
              function: { name: "get_weather", arguments: '{"location":"SF"}' },
            },
          ],
        },
        finish_reason: finishReason,
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

describe("fireworks tool-call responses", () => {
  it("marks stop_reason tool_use when finish_reason is tool_calls", () => {
    const out = convertOpenAIToAnthropic(toolCallCompletion());
    assert.equal(out.stop_reason, "tool_use");
    const toolUse = out.content.find((b) => b.type === "tool_use");
    assert.ok(toolUse);
    assert.equal(toolUse.name, "get_weather");
    assert.deepEqual(toolUse.input, { location: "SF" });
  });

  it("marks stop_reason tool_use even when finish_reason is stop with tool_calls present", () => {
    // The Moonshot precedent (databricks.js stop-reason comment): some
    // OpenAI-compatible upstreams say "stop" while carrying tool_calls.
    // The CLI only executes tools on stop_reason tool_use.
    const out = convertOpenAIToAnthropic(toolCallCompletion({ finishReason: "stop" }));
    assert.equal(out.stop_reason, "tool_use");
  });

  it("keeps text content alongside tool calls", () => {
    const out = convertOpenAIToAnthropic(toolCallCompletion({ content: "checking…" }));
    assert.ok(out.content.some((b) => b.type === "text"));
    assert.ok(out.content.some((b) => b.type === "tool_use"));
  });
});

describe("fireworks malformed responses", () => {
  it("passes through a response with no choices instead of fabricating blocks", () => {
    const errPayload = { error: { message: "model not found", type: "invalid_request_error" } };
    const out = convertOpenAIToAnthropic(errPayload);
    assert.deepEqual(out, errPayload);
  });

  it("handles empty content without crashing", () => {
    const out = convertOpenAIToAnthropic({
      id: "chatcmpl-fw",
      object: "chat.completion",
      created: 0,
      model: "accounts/fireworks/models/kimi-k2-instruct-0905",
      choices: [{ index: 0, message: { role: "assistant", content: "" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 0, total_tokens: 1 },
    });
    assert.equal(out.role, "assistant");
    assert.ok(Array.isArray(out.content));
  });

  it("recovers tool calls degraded to XML/text content", () => {
    const out = convertOpenAIToAnthropic({
      id: "chatcmpl-fw",
      object: "chat.completion",
      created: 0,
      model: "accounts/fireworks/models/llama-3.1-8b-instruct",
      choices: [{
        index: 0,
        message: {
          role: "assistant",
          content: '<invoke name="get_weather">\n<parameter name="location">SF</parameter>\n</invoke>',
        },
        finish_reason: "stop",
      }],
      usage: { prompt_tokens: 10, completion_tokens: 12, total_tokens: 22 },
    });
    const toolUse = out.content.find((b) => b.type === "tool_use");
    assert.ok(toolUse, "expected XML degraded tool call to be extracted");
    assert.equal(toolUse.name, "get_weather");
  });
});
