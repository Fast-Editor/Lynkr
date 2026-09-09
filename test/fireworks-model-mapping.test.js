/**
 * Tests for Fireworks AI model mapping (invokeFireworks).
 *
 * invokeFireworks is modeled on invokeBaidu: Anthropic model names map to
 * Fireworks serverless ids, tier-selected ids (e.g.
 * TIER_COMPLEX=fireworks:accounts/fireworks/models/glm-5p2) reach the wire
 * unchanged, and the response is converted to Anthropic shape before
 * returning.
 *
 * NOTE: the modelMap and sampling defaults in invokeFireworks are best-effort
 * from public docs, not yet probed against a live key (see the NOTE at the
 * top of invokeFireworks in src/clients/databricks.js). These tests pin
 * current behavior, not confirmed-correct behavior.
 */

process.env.DATABRICKS_API_KEY = process.env.DATABRICKS_API_KEY || "test-key";
process.env.DATABRICKS_API_BASE = process.env.DATABRICKS_API_BASE || "http://test.com";
process.env.FIREWORKS_API_KEY = process.env.FIREWORKS_API_KEY || "test-key";
// Pin unconditionally: the test asserts the shipped default mapping, and a
// developer's real .env (e.g. FIREWORKS_MODEL=...) otherwise leaks into the
// config singleton and fails the fallback-model assertion.
process.env.FIREWORKS_MODEL = "accounts/fireworks/models/kimi-k2-instruct-0905";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");

const { invokeFireworks } = require("../src/clients/databricks");

let captured;
const realFetch = global.fetch;

function okCompletion(model) {
  return new Response(
    JSON.stringify({
      id: "chatcmpl-test",
      object: "chat.completion",
      created: 0,
      model,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "ok" },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

beforeEach(() => {
  captured = null;
  global.fetch = async (url, init) => {
    captured = { url: String(url), body: JSON.parse(init.body), headers: init.headers };
    return okCompletion(captured.body.model);
  };
});

afterEach(() => {
  global.fetch = realFetch;
});

const USER_MSG = [{ role: "user", content: "hi" }];

describe("fireworks model mapping", () => {
  it("passes tier-selected serverless ids through instead of the .env default", async () => {
    await invokeFireworks({ _tierModel: "accounts/fireworks/models/glm-5p2", model: "claude-sonnet-4-5", messages: USER_MSG });
    assert.equal(captured.body.model, "accounts/fireworks/models/glm-5p2");
  });

  it("passes tier-selected family slugs through", async () => {
    await invokeFireworks({ _tierModel: "deepseek-v3p1", model: "claude-sonnet-4-5", messages: USER_MSG });
    assert.equal(captured.body.model, "deepseek-v3p1");
  });

  it("maps claude sonnet names to Kimi K2 Instruct", async () => {
    await invokeFireworks({ model: "claude-sonnet-4-5", messages: USER_MSG });
    assert.equal(captured.body.model, "accounts/fireworks/models/kimi-k2-instruct-0905");
  });

  it("maps claude opus names to GLM", async () => {
    await invokeFireworks({ model: "claude-opus-4-5", messages: USER_MSG });
    assert.equal(captured.body.model, "accounts/fireworks/models/glm-5p2");
  });

  it("maps claude haiku names to a small fast model", async () => {
    await invokeFireworks({ model: "claude-haiku-4-5", messages: USER_MSG });
    assert.equal(captured.body.model, "accounts/fireworks/models/llama-3.1-8b-instruct");
  });

  it("falls back to the .env default model for unrecognized names", async () => {
    await invokeFireworks({ model: "some-unmapped-model", messages: USER_MSG });
    assert.equal(captured.body.model, "accounts/fireworks/models/kimi-k2-instruct-0905");
  });

  it("posts to the Fireworks inference endpoint", async () => {
    await invokeFireworks({ model: "claude-sonnet-4-5", messages: USER_MSG });
    assert.equal(captured.url, "https://api.fireworks.ai/inference/v1/chat/completions");
  });
});

describe("fireworks request shape", () => {
  it("sends a bearer auth header with the configured API key", async () => {
    await invokeFireworks({ model: "claude-sonnet-4-5", messages: USER_MSG });
    assert.equal(captured.headers.Authorization, "Bearer test-key");
  });

  it("prepends system content as a system-role message", async () => {
    await invokeFireworks({ model: "claude-sonnet-4-5", system: "be terse", messages: USER_MSG });
    assert.equal(captured.body.messages[0].role, "system");
    assert.equal(captured.body.messages[0].content, "be terse");
  });

  it("converts Anthropic tools to OpenAI function-calling shape", async () => {
    const tools = [
      { name: "get_weather", description: "get weather", input_schema: { type: "object", properties: {} } },
    ];
    await invokeFireworks({ model: "claude-sonnet-4-5", messages: USER_MSG, tools });
    assert.equal(captured.body.tools[0].type, "function");
    assert.equal(captured.body.tools[0].function.name, "get_weather");
    assert.equal(captured.body.tool_choice, "auto");
    assert.equal(captured.body.parallel_tool_calls, false);
  });

  it("throws a clear error when FIREWORKS_API_KEY is not configured", async () => {
    const config = require("../src/config");
    const original = config.fireworks.apiKey;
    config.fireworks.apiKey = null;
    try {
      await assert.rejects(
        invokeFireworks({ model: "claude-sonnet-4-5", messages: USER_MSG }),
        /Fireworks API key is not configured/,
      );
    } finally {
      config.fireworks.apiKey = original;
    }
  });

  it("throws a typed 429 so tier-fallback climbs instead of hanging", async () => {
    const config = require("../src/config");
    const originalRetry = config.apiRetry;
    config.apiRetry = { maxRetries: 1, initialDelay: 1, maxDelay: 5 };
    global.fetch = async () => new Response(
      JSON.stringify({ error: { message: "Too Many Requests", type: "rate_limit_error" } }),
      { status: 429, headers: { "content-type": "application/json" } },
    );
    try {
      await assert.rejects(
        invokeFireworks({ model: "claude-sonnet-4-5", messages: USER_MSG }),
        (err) => err.status === 429 && /Fireworks rate-limited/.test(err.message),
      );
    } finally {
      config.apiRetry = originalRetry;
    }
  });
});

describe("fireworks response conversion", () => {
  it("converts the OpenAI-shaped completion to Anthropic content blocks", async () => {
    const response = await invokeFireworks({ model: "claude-sonnet-4-5", messages: USER_MSG });
    assert.equal(response.json.content[0].type, "text");
    assert.equal(response.json.content[0].text, "ok");
  });
});
