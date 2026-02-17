const assert = require("assert");
const { describe, it } = require("node:test");

const { applyToonCompression } = require("../src/context/toon");

function createLargeJsonString() {
  return JSON.stringify({
    rows: Array.from({ length: 8 }, (_, idx) => ({
      id: idx + 1,
      label: `item-${idx + 1}`,
      value: `value-${idx + 1}`.repeat(20),
    })),
  });
}

describe("TOON compression", () => {
  it("is a no-op when TOON is disabled", () => {
    const payload = {
      stream: false,
      tool_choice: { type: "auto" },
      tools: [{ name: "Read", input_schema: { type: "object", properties: {} } }],
      messages: [{ role: "user", content: createLargeJsonString() }],
    };
    const before = JSON.parse(JSON.stringify(payload));

    const { payload: after, stats } = applyToonCompression(
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

    const { payload: after, stats } = applyToonCompression(
      payload,
      { enabled: true, minBytes: 1, failOpen: true, logStats: false },
      {
        encode: () => {
          throw new Error("simulated toon encode failure");
        },
      },
    );

    assert.strictEqual(after.messages[0].content, original);
    assert.strictEqual(stats.failureCount, 1);
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

    const { payload: after, stats } = applyToonCompression(
      payload,
      { enabled: true, minBytes: 1, failOpen: false, logStats: false },
      { encode: () => "rows[1]{id,label,value}:\n  1,item-1,value-1" },
    );

    assert.strictEqual(after.messages[0].content, "rows[1]{id,label,value}:\n  1,item-1,value-1");
    assert.strictEqual(after.messages[1].content, beforeToolRoleContent);
    assert.deepStrictEqual(after.tools, beforeTools);
    assert.deepStrictEqual(after.tool_choice, beforeToolChoice);
    assert.strictEqual(after.stream, true);
    assert.strictEqual(after.model, "kimi-k2.5");
    assert.strictEqual(stats.convertedCount, 1);
  });
});
