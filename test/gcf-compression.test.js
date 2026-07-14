const assert = require("assert");
const { describe, it } = require("node:test");

const { applyGcfCompression } = require("../src/context/gcf");

function createLargeJsonString() {
  return JSON.stringify({
    rows: Array.from({ length: 8 }, (_, idx) => ({
      id: idx + 1,
      label: `item-${idx + 1}`,
      value: `value-${idx + 1}`.repeat(20),
    })),
  });
}

// A short, valid GCF generic-profile string used as the mock encoder output.
// It is intentionally much smaller than the input so the "never grow" guard converts it.
const GCF_MOCK = "GCF profile=generic\n## rows [1]{id,label,value}\n1|item-1|value-1";

describe("GCF compression", () => {
  it("is a no-op when GCF is disabled", () => {
    const payload = {
      stream: false,
      tool_choice: { type: "auto" },
      tools: [{ name: "Read", input_schema: { type: "object", properties: {} } }],
      messages: [{ role: "user", content: createLargeJsonString() }],
    };
    const before = JSON.parse(JSON.stringify(payload));

    const { payload: after, stats } = applyGcfCompression(
      payload,
      { enabled: false, minBytes: 1, failOpen: true },
      { encode: () => "should-not-run" },
    );

    assert.deepStrictEqual(after, before);
    assert.strictEqual(stats.enabled, false);
    assert.strictEqual(stats.convertedCount, 0);
  });

  it("falls back safely when encoder throws (fail-open)", () => {
    const payload = {
      messages: [{ role: "user", content: createLargeJsonString() }],
    };
    const original = payload.messages[0].content;

    const { payload: after, stats } = applyGcfCompression(
      payload,
      { enabled: true, minBytes: 1, failOpen: true, logStats: false },
      {
        encode: () => {
          throw new Error("simulated gcf encode failure");
        },
      },
    );

    assert.strictEqual(after.messages[0].content, original);
    assert.strictEqual(stats.failureCount, 1);
    assert.strictEqual(stats.convertedCount, 0);
  });

  it("keeps the JSON when the encoded form has more tokens (never grow)", () => {
    const payload = {
      messages: [{ role: "user", content: createLargeJsonString() }],
    };
    const original = payload.messages[0].content;

    const { payload: after, stats } = applyGcfCompression(
      payload,
      { enabled: true, minBytes: 1, failOpen: false, logStats: false },
      { encode: () => "word ".repeat(3000) }, // far more tokens than the input
    );

    assert.strictEqual(after.messages[0].content, original);
    assert.strictEqual(stats.skippedByGrowth, 1);
    assert.strictEqual(stats.convertedCount, 0);
  });

  it("keeps the JSON when round-trip verification does not reproduce the input", () => {
    const payload = {
      messages: [{ role: "user", content: createLargeJsonString() }],
    };
    const original = payload.messages[0].content;

    const { payload: after, stats } = applyGcfCompression(
      payload,
      { enabled: true, minBytes: 1, failOpen: false, logStats: false }, // verify defaults on
      { encode: () => GCF_MOCK, decode: () => ({ corrupted: true }) }, // decode disagrees with input
    );

    assert.strictEqual(after.messages[0].content, original);
    assert.strictEqual(stats.skippedByVerify, 1);
    assert.strictEqual(stats.convertedCount, 0);
  });

  it("does not mutate protocol fields while compressing eligible message content", () => {
    const payload = {
      model: "kimi-k2.5",
      stream: true,
      tool_choice: { type: "tool", name: "Read" },
      tools: [
        {
          name: "Read",
          description: "Read files",
          input_schema: {
            type: "object",
            properties: { file_path: { type: "string" } },
            required: ["file_path"],
          },
        },
      ],
      messages: [
        { role: "user", content: createLargeJsonString() },
        { role: "tool", content: createLargeJsonString() }, // tool role should never be touched
      ],
    };
    const beforeTools = JSON.parse(JSON.stringify(payload.tools));
    const beforeToolChoice = JSON.parse(JSON.stringify(payload.tool_choice));
    const beforeToolRoleContent = payload.messages[1].content;

    const { payload: after, stats } = applyGcfCompression(
      payload,
      { enabled: true, minBytes: 1, failOpen: false, logStats: false },
      { encode: () => GCF_MOCK, decode: () => JSON.parse(createLargeJsonString()) },
    );

    assert.strictEqual(after.messages[0].content, GCF_MOCK);
    assert.strictEqual(after.messages[1].content, beforeToolRoleContent);
    assert.deepStrictEqual(after.tools, beforeTools);
    assert.deepStrictEqual(after.tool_choice, beforeToolChoice);
    assert.strictEqual(after.stream, true);
    assert.strictEqual(after.model, "kimi-k2.5");
    assert.strictEqual(stats.convertedCount, 1);
  });

  it("compresses Anthropic text blocks while preserving tool protocol blocks", () => {
    const largeJson = createLargeJsonString();
    const payload = {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: largeJson },
            { type: "input_text", input_text: largeJson },
            {
              type: "tool_result",
              tool_use_id: "toolu_123",
              content: largeJson,
              is_error: false,
            },
          ],
        },
      ],
    };

    const originalToolResultContent = payload.messages[0].content[2].content;

    const { payload: after, stats } = applyGcfCompression(
      payload,
      { enabled: true, minBytes: 1, failOpen: false, logStats: false },
      { encode: () => GCF_MOCK, decode: () => JSON.parse(largeJson) },
    );

    assert.strictEqual(after.messages[0].content[0].text, GCF_MOCK);
    assert.strictEqual(after.messages[0].content[1].input_text, GCF_MOCK);
    assert.strictEqual(after.messages[0].content[2].content, originalToolResultContent);
    assert.strictEqual(stats.convertedCount, 2);
  });
});
