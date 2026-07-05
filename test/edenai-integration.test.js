const assert = require("assert");
const { describe, it, beforeEach, afterEach } = require("node:test");

// Eden AI is an OpenAI-compatible gateway (provider/model naming, EU/GDPR).
// These tests mirror the OpenRouter provider wiring.
describe("Eden AI provider", () => {
  let originalEnv;

  beforeEach(() => {
    delete require.cache[require.resolve("../src/config/index.js")];
    delete require.cache[require.resolve("../src/clients/routing")];
    delete require.cache[require.resolve("../src/routing/index.js")];
    delete require.cache[require.resolve("../src/routing/model-tiers")];
    delete require.cache[require.resolve("../src/clients/provider-capabilities")];

    originalEnv = { ...process.env };
    process.env.FALLBACK_PROVIDER = "databricks";
    process.env.TIER_SIMPLE = "";
    process.env.TIER_MEDIUM = "";
    process.env.TIER_COMPLEX = "";
    process.env.TIER_REASONING = "";
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe("config", () => {
    it("populates config.edenai from EDENAI_* env with sensible defaults", () => {
      process.env.MODEL_PROVIDER = "edenai";
      process.env.EDENAI_API_KEY = "test-edenai-key";
      const config = require("../src/config");

      assert.strictEqual(config.edenai.apiKey, "test-edenai-key");
      assert.strictEqual(config.edenai.model, "openai/gpt-4o-mini");
      assert.strictEqual(config.edenai.endpoint, "https://api.edenai.run/v3/chat/completions");
      assert.strictEqual(config.edenai.embeddingsModel, "openai/text-embedding-ada-002");
    });

    it("honours EDENAI_MODEL / EDENAI_ENDPOINT overrides", () => {
      process.env.MODEL_PROVIDER = "edenai";
      process.env.EDENAI_API_KEY = "test-edenai-key";
      process.env.EDENAI_MODEL = "anthropic/claude-sonnet-4-5";
      process.env.EDENAI_ENDPOINT = "https://api.eu.edenai.run/v3/chat/completions";
      const config = require("../src/config");

      assert.strictEqual(config.edenai.model, "anthropic/claude-sonnet-4-5");
      assert.strictEqual(config.edenai.endpoint, "https://api.eu.edenai.run/v3/chat/completions");
    });

    it("accepts MODEL_PROVIDER=edenai (in SUPPORTED_MODEL_PROVIDERS)", () => {
      process.env.MODEL_PROVIDER = "edenai";
      process.env.EDENAI_API_KEY = "test-edenai-key";
      assert.doesNotThrow(() => require("../src/config"));
    });
  });

  describe("routing", () => {
    it("returns edenai for static routing when MODEL_PROVIDER=edenai", async () => {
      process.env.MODEL_PROVIDER = "edenai";
      process.env.EDENAI_API_KEY = "test-edenai-key";

      require("../src/config");
      const routing = require("../src/clients/routing");

      const payload = { messages: [{ role: "user", content: "test" }] };
      const result = await routing.determineProviderSmart(payload);

      assert.strictEqual(result.provider, "edenai");
      assert.strictEqual(result.method, "static");
    });
  });

  describe("capabilities", () => {
    it("treats edenai as a reasoning_content provider (OpenAI-compatible)", () => {
      const { supportsReasoningContent, getThinkingBehavior } =
        require("../src/clients/provider-capabilities");
      assert.strictEqual(supportsReasoningContent("edenai"), true);
      assert.strictEqual(getThinkingBehavior("edenai"), "reasoning_content");
    });
  });

  // Live end-to-end test — only runs when a real key is present AND EDENAI_LIVE=1.
  // In CI, scope EDENAI_API_KEY to this step's env only (never at workflow/job level).
  describe("live endpoint (gated)", () => {
    it("returns an OpenAI-shaped completion from api.edenai.run/v3", async (t) => {
      if (process.env.EDENAI_LIVE !== "1" || !process.env.EDENAI_API_KEY) {
        t.skip("set EDENAI_LIVE=1 and EDENAI_API_KEY to run the live test");
        return;
      }
      const res = await fetch("https://api.edenai.run/v3/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${process.env.EDENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: process.env.EDENAI_MODEL || "openai/gpt-4o-mini",
          messages: [{ role: "user", content: "Say the single word: pong" }],
          max_tokens: 10,
        }),
      });
      assert.strictEqual(res.status, 200);
      const json = await res.json();
      assert.ok(Array.isArray(json.choices) && json.choices.length > 0, "response has choices[]");
      assert.strictEqual(typeof json.choices[0].message.content, "string");
    });
  });
});
