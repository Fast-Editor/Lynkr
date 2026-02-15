const assert = require("assert");
const { describe, it, beforeEach, afterEach } = require("node:test");

describe("Azure OpenAI Routing Tests", () => {
  let routing;
  let originalConfig;

  beforeEach(() => {
    // Clear module cache
    delete require.cache[require.resolve("../src/config")];
    delete require.cache[require.resolve("../src/clients/routing")];
    delete require.cache[require.resolve("../src/routing/index.js")];
    delete require.cache[require.resolve("../src/routing/model-tiers")];
    delete require.cache[require.resolve("../src/routing/complexity-analyzer")];
    delete require.cache[require.resolve("../src/routing/cost-optimizer")];
    delete require.cache[require.resolve("../src/routing/agentic-detector")];

    // Store original config
    originalConfig = { ...process.env };

    // Clean OpenRouter config from previous tests
    delete process.env.OPENROUTER_API_KEY;

    // Base config for routing tests
    process.env.MODEL_PROVIDER = "databricks"; // Set default to avoid validation errors
    process.env.DATABRICKS_API_KEY = "test-key";
    process.env.DATABRICKS_API_BASE = "http://test.com";

    // Explicitly set valid fallback to override any local .env pollution (e.g. lmstudio)
    process.env.FALLBACK_PROVIDER = "databricks";

    // Ensure no TIER_* vars leak between tests
    process.env.TIER_SIMPLE = "";
    process.env.TIER_MEDIUM = "";
    process.env.TIER_COMPLEX = "";
    process.env.TIER_REASONING = "";
  });

  afterEach(() => {
    // Restore original environment
    process.env = originalConfig;
  });

  describe("Primary Provider Routing", () => {
    it("should route to azure-openai when set as MODEL_PROVIDER", () => {
      process.env.MODEL_PROVIDER = "azure-openai";
      process.env.AZURE_OPENAI_ENDPOINT = "https://test.openai.azure.com";
      process.env.AZURE_OPENAI_API_KEY = "test-key";

      routing = require("../src/clients/routing");

      const provider = routing.determineProviderSync({ tools: [] });

      assert.strictEqual(provider, "azure-openai");
    });
  });

  describe("Static Routing with Azure OpenAI", () => {
    it("should return primary provider regardless of tool count (tier routing disabled)", () => {
      process.env.MODEL_PROVIDER = "azure-openai";
      process.env.AZURE_OPENAI_ENDPOINT = "https://test.openai.azure.com";
      process.env.AZURE_OPENAI_API_KEY = "test-key";

      // Clear cache after env setup
      delete require.cache[require.resolve("../src/config/index.js")];
      delete require.cache[require.resolve("../src/clients/routing")];
      delete require.cache[require.resolve("../src/routing/index.js")];

      routing = require("../src/clients/routing");

      // 5 tools: determineProviderSync always returns primary provider
      const provider = routing.determineProviderSync({
        tools: [{}, {}, {}, {}, {}]
      });

      assert.strictEqual(provider, "azure-openai");
    });

    it("should return primary provider for simple requests", () => {
      process.env.MODEL_PROVIDER = "azure-openai";
      process.env.AZURE_OPENAI_ENDPOINT = "https://test.openai.azure.com";
      process.env.AZURE_OPENAI_API_KEY = "test-key";

      // Clear cache after env setup
      delete require.cache[require.resolve("../src/config/index.js")];
      delete require.cache[require.resolve("../src/clients/routing")];
      delete require.cache[require.resolve("../src/routing/index.js")];

      routing = require("../src/clients/routing");

      // 2 tools: determineProviderSync always returns primary provider
      const provider = routing.determineProviderSync({
        tools: [{}, {}]
      });

      assert.strictEqual(provider, "azure-openai");
    });

    it("should return static routing from determineProviderSmart when tiers disabled", async () => {
      process.env.MODEL_PROVIDER = "azure-openai";
      process.env.AZURE_OPENAI_ENDPOINT = "https://test.openai.azure.com";
      process.env.AZURE_OPENAI_API_KEY = "test-key";

      // Clear cache after env setup
      delete require.cache[require.resolve("../src/config/index.js")];
      delete require.cache[require.resolve("../src/clients/routing")];
      delete require.cache[require.resolve("../src/routing/index.js")];

      routing = require("../src/clients/routing");

      const result = await routing.determineProviderSmart({
        messages: [{ role: "user", content: "test" }],
        tools: [{}, {}]
      });

      assert.strictEqual(result.provider, "azure-openai");
      assert.strictEqual(result.method, "static");
      assert.strictEqual(result.reason, "tier_routing_disabled");
    });
  });

  describe("Fallback Configuration", () => {
    it("should support azure-openai as fallback provider", () => {
      process.env.MODEL_PROVIDER = "ollama";
      process.env.OLLAMA_ENDPOINT = "http://localhost:11434";
      process.env.OLLAMA_MODEL = "qwen2.5-coder:latest";
      process.env.FALLBACK_ENABLED = "true";
      process.env.FALLBACK_PROVIDER = "azure-openai";
      process.env.AZURE_OPENAI_ENDPOINT = "https://test.openai.azure.com";
      process.env.AZURE_OPENAI_API_KEY = "test-key";

      // Clear cache after env setup
      delete require.cache[require.resolve("../src/config/index.js")];
      delete require.cache[require.resolve("../src/clients/routing")];
      delete require.cache[require.resolve("../src/routing/index.js")];

      routing = require("../src/clients/routing");

      const fallbackProvider = routing.getFallbackProvider();

      assert.strictEqual(fallbackProvider, "azure-openai");
    });

    it("should return true for fallback enabled", () => {
      process.env.FALLBACK_ENABLED = "true";

      // Clear cache after env setup
      delete require.cache[require.resolve("../src/config/index.js")];
      delete require.cache[require.resolve("../src/clients/routing")];
      delete require.cache[require.resolve("../src/routing/index.js")];

      routing = require("../src/clients/routing");

      assert.strictEqual(routing.isFallbackEnabled(), true);
    });

    it("should return false when fallback disabled", () => {
      process.env.FALLBACK_ENABLED = "false";

      // Clear cache after env setup
      delete require.cache[require.resolve("../src/config/index.js")];
      delete require.cache[require.resolve("../src/clients/routing")];
      delete require.cache[require.resolve("../src/routing/index.js")];

      routing = require("../src/clients/routing");

      assert.strictEqual(routing.isFallbackEnabled(), false);
    });
  });
});
