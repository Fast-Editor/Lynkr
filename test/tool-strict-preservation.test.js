const assert = require("assert");
const { describe, it } = require("node:test");

process.env.MODEL_PROVIDER = process.env.MODEL_PROVIDER || "databricks";
process.env.DATABRICKS_API_KEY = process.env.DATABRICKS_API_KEY || "test-key";
process.env.DATABRICKS_API_BASE = process.env.DATABRICKS_API_BASE || "http://test.com";

const { convertAnthropicToolsToOpenRouter } = require("../src/clients/openrouter-utils");
const { convertOpenAIToAnthropic } = require("../src/clients/openai-format");
const { ensureAnthropicToolFormat } = require("../src/orchestrator");

const schema = { type: "object", properties: { a: { type: "string" } }, required: ["a"], additionalProperties: false };

// Regression tests for the tool `strict` flag being dropped by tool rebuilds (issue #116).
describe("tool strict flag preservation", () => {
  it("convertAnthropicToolsToOpenRouter keeps strict true and false", () => {
    const out = convertAnthropicToolsToOpenRouter([
      { name: "t1", description: "d", strict: true, input_schema: schema },
      { name: "t2", description: "d", strict: false, input_schema: schema },
    ]);
    assert.strictEqual(out[0].function.strict, true);
    assert.strictEqual(out[1].function.strict, false);
  });

  it("convertAnthropicToolsToOpenRouter omits strict when unset", () => {
    const [tool] = convertAnthropicToolsToOpenRouter([{ name: "t", input_schema: schema }]);
    assert.ok(!("strict" in tool.function));
  });

  it("convertOpenAIToAnthropic keeps strict", () => {
    const out = convertOpenAIToAnthropic({
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      tools: [{ type: "function", function: { name: "t", strict: true, parameters: schema } }],
    });
    assert.strictEqual(out.tools[0].strict, true);
    assert.deepStrictEqual(out.tools[0].input_schema, schema);
  });

  it("convertOpenAIToAnthropic omits strict when unset", () => {
    const out = convertOpenAIToAnthropic({
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      tools: [{ type: "function", function: { name: "t", parameters: schema } }],
    });
    assert.ok(!("strict" in out.tools[0]));
  });

  it("ensureAnthropicToolFormat keeps strict from both tool shapes", () => {
    const out = ensureAnthropicToolFormat([
      { type: "function", function: { name: "t1", strict: true, parameters: schema } },
      { name: "t2", description: "d", strict: true, input_schema: schema },
      { name: "t3", description: "d", input_schema: schema },
    ]);
    assert.strictEqual(out[0].strict, true);
    assert.strictEqual(out[1].strict, true);
    assert.ok(!("strict" in out[2]));
  });

  it("OpenAI Chat tool survives the full round trip to the OpenAI-format upstream", () => {
    const anthropic = convertOpenAIToAnthropic({
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      tools: [{ type: "function", function: { name: "t", strict: true, parameters: schema } }],
    });
    const [forwarded] = convertAnthropicToolsToOpenRouter(ensureAnthropicToolFormat(anthropic.tools));
    assert.strictEqual(forwarded.function.strict, true);
  });
});
