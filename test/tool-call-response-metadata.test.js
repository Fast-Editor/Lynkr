const assert = require("assert");
const { describe, it } = require("node:test");

// Regression coverage for issue #78: tool-call responses reported the wrong
// (client-requested / default) model and could zero out usage, because
// toAnthropicResponse() built model from the client request instead of the
// actual provider response.

const { toAnthropicResponse } = require("../src/orchestrator/index");

function toolCallResponse(overrides = {}) {
  return {
    id: "chatcmpl-abc",
    model: "databricks-claude-3-7-sonnet", // model the provider actually served
    choices: [
      {
        finish_reason: "tool_calls",
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_1",
              function: { name: "get_weather", arguments: '{"city":"SF"}' },
            },
          ],
        },
      },
    ],
    usage: { prompt_tokens: 120, completion_tokens: 18 },
    ...overrides,
  };
}

describe("toAnthropicResponse model field (issue #78)", () => {
  it("reports the provider's actual model, not the requested alias", () => {
    const out = toAnthropicResponse(toolCallResponse(), "claude-sonnet-4-5", false);
    assert.strictEqual(out.model, "databricks-claude-3-7-sonnet");
  });

  it("falls back to requestedModel when the provider omits model", () => {
    const out = toAnthropicResponse(
      toolCallResponse({ model: undefined }),
      "claude-sonnet-4-5",
      false
    );
    assert.strictEqual(out.model, "claude-sonnet-4-5");
  });

  it("falls back to requestedModel when the provider model is blank", () => {
    const out = toAnthropicResponse(
      toolCallResponse({ model: "   " }),
      "claude-sonnet-4-5",
      false
    );
    assert.strictEqual(out.model, "claude-sonnet-4-5");
  });

  it("emits a tool_use content block with parsed input", () => {
    const out = toAnthropicResponse(toolCallResponse(), "req-model", false);
    const toolUse = out.content.find((b) => b.type === "tool_use");
    assert.ok(toolUse, "expected a tool_use block");
    assert.strictEqual(toolUse.name, "get_weather");
    assert.deepStrictEqual(toolUse.input, { city: "SF" });
    assert.strictEqual(out.stop_reason, "tool_use");
  });
});

describe("toAnthropicResponse usage field (issue #78)", () => {
  it("maps OpenAI-shaped usage", () => {
    const out = toAnthropicResponse(toolCallResponse(), "m", false);
    assert.strictEqual(out.usage.input_tokens, 120);
    assert.strictEqual(out.usage.output_tokens, 18);
  });

  it("also accepts already-Anthropic-shaped usage field names", () => {
    const out = toAnthropicResponse(
      toolCallResponse({ usage: { input_tokens: 55, output_tokens: 9 } }),
      "m",
      false
    );
    assert.strictEqual(out.usage.input_tokens, 55);
    assert.strictEqual(out.usage.output_tokens, 9);
  });

  it("defaults to zero when usage is absent (no throw)", () => {
    const out = toAnthropicResponse(toolCallResponse({ usage: undefined }), "m", false);
    assert.strictEqual(out.usage.input_tokens, 0);
    assert.strictEqual(out.usage.output_tokens, 0);
  });
});
