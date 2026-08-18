/**
 * Tests for Baidu Qianfan (ERNIE) model mapping (invokeBaidu).
 *
 * invokeBaidu is modeled on invokeMoonshot: Anthropic model names map to a
 * live ERNIE model id, tier-selected ids (e.g. TIER_REASONING=baidu:ernie-x1.1)
 * reach the wire unchanged, and the response is converted to Anthropic shape
 * before returning.
 *
 * NOTE: the modelMap and sampling defaults in invokeBaidu are best-effort
 * from public docs, not yet probed against a live key (see the NOTE at the
 * top of invokeBaidu in src/clients/databricks.js). These tests pin current
 * behavior, not confirmed-correct behavior.
 */

process.env.DATABRICKS_API_KEY = process.env.DATABRICKS_API_KEY || "test-key";
process.env.DATABRICKS_API_BASE = process.env.DATABRICKS_API_BASE || "http://test.com";
process.env.BAIDU_API_KEY = process.env.BAIDU_API_KEY || "test-key";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");

const { invokeBaidu } = require("../src/clients/databricks");

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

describe("baidu model mapping", () => {
  it("passes tier-selected ERNIE ids through instead of the .env default", async () => {
    await invokeBaidu({ _tierModel: "ernie-x1.1", model: "claude-sonnet-4-5", messages: USER_MSG });
    assert.equal(captured.body.model, "ernie-x1.1");
  });

  it("maps claude sonnet names to ERNIE 4.5 Turbo", async () => {
    await invokeBaidu({ model: "claude-sonnet-4-5", messages: USER_MSG });
    assert.equal(captured.body.model, "ernie-4.5-turbo-128k");
  });

  it("maps claude haiku names to ERNIE Speed", async () => {
    await invokeBaidu({ model: "claude-haiku-4-5", messages: USER_MSG });
    assert.equal(captured.body.model, "ernie-speed-8k");
  });

  it("maps claude opus to the ERNIE reasoning model", async () => {
    await invokeBaidu({ model: "claude-opus-4-5", messages: USER_MSG });
    assert.equal(captured.body.model, "ernie-x1.1");
  });

  it("falls back to the .env default model for unrecognized names", async () => {
    await invokeBaidu({ model: "some-unmapped-model", messages: USER_MSG });
    assert.equal(captured.body.model, "ernie-4.5-turbo-128k");
  });
});

describe("baidu request shape", () => {
  it("sends a bearer auth header with the configured API key", async () => {
    await invokeBaidu({ model: "claude-sonnet-4-5", messages: USER_MSG });
    assert.equal(captured.headers.Authorization, "Bearer test-key");
  });

  it("prepends system content as a system-role message", async () => {
    await invokeBaidu({ model: "claude-sonnet-4-5", system: "be terse", messages: USER_MSG });
    assert.equal(captured.body.messages[0].role, "system");
    assert.equal(captured.body.messages[0].content, "be terse");
  });

  it("converts Anthropic tools to OpenAI function-calling shape", async () => {
    const tools = [
      { name: "get_weather", description: "get weather", input_schema: { type: "object", properties: {} } },
    ];
    await invokeBaidu({ model: "claude-sonnet-4-5", messages: USER_MSG, tools });
    assert.equal(captured.body.tools[0].type, "function");
    assert.equal(captured.body.tools[0].function.name, "get_weather");
    assert.equal(captured.body.tool_choice, "auto");
    assert.equal(captured.body.parallel_tool_calls, false);
  });

  it("throws a clear error when BAIDU_API_KEY is not configured", async () => {
    const config = require("../src/config");
    const original = config.baidu.apiKey;
    config.baidu.apiKey = null;
    try {
      await assert.rejects(
        invokeBaidu({ model: "claude-sonnet-4-5", messages: USER_MSG }),
        /Baidu API key is not configured/,
      );
    } finally {
      config.baidu.apiKey = original;
    }
  });
});

describe("baidu response conversion", () => {
  it("converts the OpenAI-shaped completion to Anthropic content blocks", async () => {
    const response = await invokeBaidu({ model: "claude-sonnet-4-5", messages: USER_MSG });
    assert.equal(response.json.content[0].type, "text");
    assert.equal(response.json.content[0].text, "ok");
  });
});
