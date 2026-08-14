"use strict";

const assert = require("node:assert/strict");
const { describe, it, beforeEach, afterEach } = require("node:test");

function clearModules() {
  for (const modulePath of [
    "../src/config",
    "../src/clients/databricks",
    "../src/clients/routing",
    "../src/routing",
    "../src/orchestrator/sse-transformer",
    "../src/clients/provider-capabilities",
  ]) {
    delete require.cache[require.resolve(modulePath)];
  }
}

describe("Atlas Cloud integration", () => {
  let originalEnv;
  let originalFetch;

  beforeEach(() => {
    originalEnv = { ...process.env };
    originalFetch = global.fetch;

    process.env.MODEL_PROVIDER = "atlas";
    process.env.ATLASCLOUD_API_KEY = "atlas-test-key";
    process.env.ATLASCLOUD_MODEL = "";
    process.env.ATLASCLOUD_ENDPOINT = "";
    process.env.FALLBACK_ENABLED = "false";
    process.env.TIER_SIMPLE = "";
    process.env.TIER_MEDIUM = "";
    process.env.TIER_COMPLEX = "";
    process.env.TIER_REASONING = "";
    process.env.LOG_FILE_ENABLED = "false";
    clearModules();
  });

  afterEach(() => {
    process.env = originalEnv;
    global.fetch = originalFetch;
    clearModules();
  });

  it("accepts atlas and applies safe defaults", () => {
    const config = require("../src/config");

    assert.equal(config.modelProvider.type, "atlas");
    assert.equal(config.atlas.model, "qwen/qwen3.8-max");
    assert.equal(config.atlas.endpoint, "https://api.atlascloud.ai/v1/chat/completions");
  });

  it("requires ATLASCLOUD_API_KEY for primary routing", () => {
    process.env.ATLASCLOUD_API_KEY = "";
    clearModules();

    assert.throws(
      () => require("../src/config"),
      /Set ATLASCLOUD_API_KEY before starting the proxy/,
    );
  });

  it("honors custom model and endpoint", () => {
    process.env.ATLASCLOUD_MODEL = "deepseek-ai/deepseek-v3.2";
    process.env.ATLASCLOUD_ENDPOINT = "https://atlas.example/v1/chat/completions";
    clearModules();

    const config = require("../src/config");
    assert.equal(config.atlas.model, "deepseek-ai/deepseek-v3.2");
    assert.equal(config.atlas.endpoint, "https://atlas.example/v1/chat/completions");
  });

  it("converts Anthropic messages and tools to one Atlas request", async () => {
    const calls = [];
    global.fetch = async (url, options) => {
      calls.push({ url, options });
      return new Response(JSON.stringify({
        id: "chatcmpl-atlas-test",
        choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 },
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    const { invokeAtlas } = require("../src/clients/databricks");
    const result = await invokeAtlas({
      system: "Be concise.",
      messages: [{ role: "user", content: "Say ok" }],
      tools: [{
        name: "get_weather",
        description: "Get weather",
        input_schema: {
          type: "object",
          properties: { city: { type: "string" } },
          required: ["city"],
        },
      }],
      max_tokens: 32,
      stream: false,
    });

    assert.equal(result.ok, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://api.atlascloud.ai/v1/chat/completions");
    assert.equal(calls[0].options.headers.Authorization, "Bearer atlas-test-key");

    const request = JSON.parse(calls[0].options.body);
    assert.equal(request.model, "qwen/qwen3.8-max");
    assert.deepEqual(request.messages[0], { role: "system", content: "Be concise." });
    assert.deepEqual(request.messages[1], { role: "user", content: "Say ok" });
    assert.equal(request.tools[0].type, "function");
    assert.equal(request.tools[0].function.name, "get_weather");
    assert.equal(request.parallel_tool_calls, false);
    assert.equal(request.tool_choice, "auto");
  });

  it("does not replay a failed billable POST", async () => {
    let calls = 0;
    global.fetch = async () => {
      calls += 1;
      return new Response(JSON.stringify({ error: { message: "temporary" } }), {
        status: 503,
        headers: { "content-type": "application/json" },
      });
    };

    const { invokeAtlas } = require("../src/clients/databricks");
    const result = await invokeAtlas({
      messages: [{ role: "user", content: "hello" }],
      tools: [{ name: "noop", description: "No-op", input_schema: { type: "object" } }],
      stream: false,
    });

    assert.equal(result.status, 503);
    assert.equal(calls, 1);
  });

  it("supports static routing, reasoning content, and OpenAI SSE transforms", async () => {
    const routing = require("../src/clients/routing");
    const decision = await routing.determineProviderSmart({
      messages: [{ role: "user", content: "hello" }],
    });
    assert.equal(decision.provider, "atlas");
    assert.equal(decision.method, "static");

    const { supportsReasoningContent } = require("../src/clients/provider-capabilities");
    assert.equal(supportsReasoningContent("atlas"), true);

    const { shouldTransform } = require("../src/orchestrator/sse-transformer");
    assert.equal(shouldTransform(true, "atlas"), true);
  });
});
