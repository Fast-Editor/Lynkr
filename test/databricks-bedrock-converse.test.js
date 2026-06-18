/**
 * Tests for the Bedrock Converse request normalization.
 *
 * invokeModel runs injectPromptCaching() before dispatching to a provider,
 * which rewrites string `system` / message `content` into Anthropic
 * cache_control blocks. The Bedrock Converse API has no cache_control
 * concept and requires plain-string system and message content, so the
 * Bedrock path must flatten those shapes back before building the request.
 */

const assert = require("assert");
const { describe, it, beforeEach, afterEach } = require("node:test");

const { injectPromptCaching } = require("../src/clients/prompt-cache-injection");

describe("Bedrock Converse normalization", () => {
  let originalEnv;
  let normalizeBodyForConverse;

  beforeEach(() => {
    originalEnv = { ...process.env };
    // databricks.js loads ../config at require time; give it valid creds.
    process.env.MODEL_PROVIDER = "databricks";
    process.env.DATABRICKS_API_KEY = "test-key";
    process.env.DATABRICKS_API_BASE = "http://test.com";

    delete require.cache[require.resolve("../src/config")];
    delete require.cache[require.resolve("../src/clients/databricks")];
    ({ normalizeBodyForConverse } = require("../src/clients/databricks"));
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("flattens a cache_control-injected system prompt back to a string", () => {
    const body = {
      system: "You are a helpful assistant",
      messages: [{ role: "user", content: "Hello" }],
    };

    // Simulate the injection that invokeModel performs before dispatch.
    injectPromptCaching(body, "bedrock");
    assert.ok(Array.isArray(body.system), "precondition: injection made system an array");

    const normalized = normalizeBodyForConverse(body);

    assert.strictEqual(typeof normalized.system, "string");
    assert.strictEqual(normalized.system, "You are a helpful assistant");
  });

  it("flattens injected message content back to plain strings", () => {
    const body = {
      system: "sys",
      messages: [
        { role: "user", content: "first" },
        { role: "assistant", content: "second" },
        { role: "user", content: "third" },
      ],
    };

    injectPromptCaching(body, "bedrock");

    const normalized = normalizeBodyForConverse(body);

    for (const msg of normalized.messages) {
      assert.strictEqual(typeof msg.content, "string");
    }
    assert.strictEqual(normalized.messages[0].content, "first");
    assert.strictEqual(normalized.messages[2].content, "third");
  });

  it("produces a Converse-valid system shape ([{text:string}])", () => {
    const body = {
      system: "cached system prompt",
      messages: [{ role: "user", content: "hi" }],
    };

    injectPromptCaching(body, "bedrock");
    const normalized = normalizeBodyForConverse(body);

    // Mirror how invokeBedrock builds the Converse system field.
    const converseSystem = [{ text: normalized.system }];
    assert.strictEqual(converseSystem.length, 1);
    assert.strictEqual(typeof converseSystem[0].text, "string");
    assert.strictEqual(converseSystem[0].text, "cached system prompt");
  });

  it("produces Converse-valid content blocks ({text:string})", () => {
    const body = {
      system: "sys",
      messages: [{ role: "user", content: "question" }],
    };

    injectPromptCaching(body, "bedrock");
    const normalized = normalizeBodyForConverse(body);

    // Mirror how invokeBedrock maps message content for Converse.
    const blocks = Array.isArray(normalized.messages[0].content)
      ? normalized.messages[0].content.map(c => ({ text: c.text || c.content || "" }))
      : [{ text: normalized.messages[0].content }];

    assert.strictEqual(blocks.length, 1);
    assert.strictEqual(typeof blocks[0].text, "string");
    assert.strictEqual(blocks[0].text, "question");
  });

  it("does not strip cache_control from the caller's original body", () => {
    const body = {
      system: "sys",
      messages: [{ role: "user", content: "hi" }],
    };

    injectPromptCaching(body, "bedrock");
    normalizeBodyForConverse(body);

    // Normalization works on a copy, leaving the injected body untouched.
    assert.ok(Array.isArray(body.system));
    assert.deepStrictEqual(body.system[0].cache_control, { type: "ephemeral" });
  });

  it("handles array system blocks without cache_control", () => {
    const body = {
      system: [
        { type: "text", text: "Part A" },
        { type: "text", text: "Part B" },
      ],
      messages: [],
    };

    const normalized = normalizeBodyForConverse(body);
    assert.strictEqual(normalized.system, "Part APart B");
  });
});
