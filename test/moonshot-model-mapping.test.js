/**
 * Tests for Moonshot model mapping + pinned sampling params (invokeMoonshot).
 *
 * Every current kimi-k* model on api.moonshot.ai only accepts temperature: 1
 * ("invalid temperature: only 1 is allowed for this model" otherwise), and
 * kimi-k2-turbo-preview / kimi-k2-thinking no longer exist. Tier-selected ids
 * like TIER_REASONING=moonshot:kimi-k2.6 must reach the wire unchanged.
 */

process.env.DATABRICKS_API_KEY = process.env.DATABRICKS_API_KEY || "test-key";
process.env.DATABRICKS_API_BASE = process.env.DATABRICKS_API_BASE || "http://test.com";
process.env.MOONSHOT_API_KEY = process.env.MOONSHOT_API_KEY || "test-key";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");

const { invokeMoonshot } = require("../src/clients/databricks");

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
    captured = { url: String(url), body: JSON.parse(init.body) };
    return okCompletion(captured.body.model);
  };
});

afterEach(() => {
  global.fetch = realFetch;
});

const USER_MSG = [{ role: "user", content: "hi" }];

describe("moonshot model mapping", () => {
  it("passes tier-selected kimi ids through instead of the .env default", async () => {
    await invokeMoonshot({ _tierModel: "kimi-k2.6", model: "claude-sonnet-4-5", messages: USER_MSG });
    assert.equal(captured.body.model, "kimi-k2.6");
  });

  it("maps claude model names to a live kimi model", async () => {
    await invokeMoonshot({ model: "claude-sonnet-4-5", messages: USER_MSG });
    assert.equal(captured.body.model, "kimi-k2.6");
  });

  it("remaps retired ids still present in older tier configs", async () => {
    await invokeMoonshot({ _tierModel: "kimi-k2-thinking", messages: USER_MSG });
    assert.equal(captured.body.model, "kimi-k3");

    await invokeMoonshot({ _tierModel: "kimi-k2-turbo-preview", messages: USER_MSG });
    assert.equal(captured.body.model, "kimi-k2.6");
  });

  it("remaps moonshot-v1-auto to a fixed model", async () => {
    await invokeMoonshot({ model: "moonshot-v1-auto", messages: USER_MSG });
    assert.equal(captured.body.model, "moonshot-v1-128k");
  });
});

describe("moonshot pinned sampling params", () => {
  for (const model of ["kimi-k2.6", "kimi-k3", "kimi-k2.7-code"]) {
    it(`pins temperature=1 and top_p=0.95 for ${model}`, async () => {
      await invokeMoonshot({ _tierModel: model, messages: USER_MSG, temperature: 0.7, top_p: 1.0 });
      assert.equal(captured.body.temperature, 1);
      assert.equal(captured.body.top_p, 0.95);
    });
  }

  it("keeps caller-supplied sampling params for moonshot-v1 models", async () => {
    await invokeMoonshot({ model: "moonshot-v1-128k", messages: USER_MSG, temperature: 0.3, top_p: 0.9 });
    assert.equal(captured.body.temperature, 0.3);
    assert.equal(captured.body.top_p, 0.9);
  });
});
