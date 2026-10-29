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

describe("Runcrate integration", () => {
  let originalEnv;
  let originalFetch;

  beforeEach(() => {
    originalEnv = { ...process.env };
    originalFetch = global.fetch;

    process.env.MODEL_PROVIDER = "runcrate";
    process.env.RUNCRATE_API_KEY = "runcrate-test-key";
    process.env.RUNCRATE_MODEL = "";
    process.env.RUNCRATE_ENDPOINT = "";
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

  it("accepts runcrate and applies safe defaults", () => {
    const config = require("../src/config");

    assert.equal(config.modelProvider.type, "runcrate");
    assert.equal(config.runcrate.model, "deepseek-ai/DeepSeek-V4.1-Flash");
    assert.equal(config.runcrate.endpoint, "https://api.runcrate.ai/v1/chat/completions");
  });

  it("requires RUNCRATE_API_KEY for primary routing", () => {
    process.env.RUNCRATE_API_KEY = "";
    clearModules();

    assert.throws(
      () => require("../src/config"),
      /Set RUNCRATE_API_KEY before starting the proxy/,
    );
  });

  it("honors custom model and endpoint", () => {
    process.env.RUNCRATE_MODEL = "zai-org/GLM-5.3";
    process.env.RUNCRATE_ENDPOINT = "https://ci.example/v1/chat/completions";
    clearModules();

    const config = require("../src/config");
    assert.equal(config.runcrate.model, "zai-org/GLM-5.3");
    assert.equal(config.runcrate.endpoint, "https://ci.example/v1/chat/completions");
  });

  it("converts Anthropic messages and tools to one Runcrate request", async () => {
    const calls = [];
    global.fetch = async (url, options) => {
      calls.push({ url, options });
      return new Response(JSON.stringify({
        id: "chatcmpl-runcrate-test",
        choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 },
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    const { invokeRuncrate } = require("../src/clients/databricks");
    const result = await invokeRuncrate({
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
    assert.equal(calls[0].url, "https://api.runcrate.ai/v1/chat/completions");
    assert.equal(calls[0].options.headers.Authorization, "Bearer runcrate-test-key");

    const request = JSON.parse(calls[0].options.body);
    assert.equal(request.model, "deepseek-ai/DeepSeek-V4.1-Flash");
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

    const { invokeRuncrate } = require("../src/clients/databricks");
    const result = await invokeRuncrate({
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
    assert.equal(decision.provider, "runcrate");
    assert.equal(decision.method, "static");

    const { supportsReasoningContent } = require("../src/clients/provider-capabilities");
    assert.equal(supportsReasoningContent("runcrate"), true);

    const { shouldTransform } = require("../src/orchestrator/sse-transformer");
    assert.equal(shouldTransform(true, "runcrate"), true);
  });
});
