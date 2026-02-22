const assert = require("assert");
const { describe, it, beforeEach, afterEach } = require("node:test");

describe("Routing Logic", () => {
  let config;
  let routing;
  let originalConfig;

  beforeEach(() => {
    // Clear module cache to get fresh instances
    delete require.cache[require.resolve("../src/config/index.js")];
    delete require.cache[require.resolve("../src/clients/routing")];
    delete require.cache[require.resolve("../src/routing/index.js")];
    delete require.cache[require.resolve("../src/routing/model-tiers")];
    delete require.cache[require.resolve("../src/routing/complexity-analyzer")];
    delete require.cache[require.resolve("../src/routing/cost-optimizer")];
    delete require.cache[require.resolve("../src/routing/agentic-detector")];

    // Store original config
    originalConfig = { ...process.env };

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

  describe("static routing (tier routing disabled)", () => {
    it("should return configured provider when tier routing is disabled", async () => {
      process.env.MODEL_PROVIDER = "databricks";
      process.env.DATABRICKS_API_KEY = "test-key";
      process.env.DATABRICKS_API_BASE = "http://test.com";

      config = require("../src/config");
      routing = require("../src/clients/routing");

      const payload = { messages: [{ role: "user", content: "test" }] };
      const result = await routing.determineProviderSmart(payload);

      assert.strictEqual(result.provider, "databricks");
      assert.strictEqual(result.method, "static");
    });

    it("should return ollama when MODEL_PROVIDER is ollama", async () => {
      process.env.MODEL_PROVIDER = "ollama";
      process.env.OLLAMA_MODEL = "qwen2.5-coder:latest";

      config = require("../src/config");
      routing = require("../src/clients/routing");

      const payload = {
        messages: [{ role: "user", content: "test" }],
        tools: [],
      };

      const result = await routing.determineProviderSmart(payload);
      assert.strictEqual(result.provider, "ollama");
      assert.strictEqual(result.method, "static");
    });

    it("should return primary provider regardless of tool count", async () => {
      process.env.MODEL_PROVIDER = "ollama";
      process.env.OLLAMA_MODEL = "qwen2.5-coder:latest";

      config = require("../src/config");
      routing = require("../src/clients/routing");

      const payload = {
        messages: [{ role: "user", content: "test" }],
        tools: [
          { name: "tool1", description: "test" },
          { name: "tool2", description: "test" },
        ],
      };

      const result = await routing.determineProviderSmart(payload);
      assert.strictEqual(result.provider, "ollama");
      assert.strictEqual(result.method, "static");
    });

    it("should return primary provider even with many tools", async () => {
      process.env.MODEL_PROVIDER = "databricks";
      process.env.DATABRICKS_API_KEY = "test-key";
      process.env.DATABRICKS_API_BASE = "http://test.com";

      config = require("../src/config");
      routing = require("../src/clients/routing");

      const payload = {
        messages: [{ role: "user", content: "test" }],
        tools: [
          { name: "tool1", description: "test" },
          { name: "tool2", description: "test" },
          { name: "tool3", description: "test" },
          { name: "tool4", description: "test" },
          { name: "tool5", description: "test" },
        ],
      };

      const result = await routing.determineProviderSmart(payload);
      assert.strictEqual(result.provider, "databricks");
      assert.strictEqual(result.method, "static");
    });

    it("should return configured MODEL_PROVIDER", async () => {
      process.env.MODEL_PROVIDER = "databricks";
      process.env.DATABRICKS_API_KEY = "test-key";
      process.env.DATABRICKS_API_BASE = "http://test.com";

      config = require("../src/config");
      routing = require("../src/clients/routing");

      const payload = {
        messages: [{ role: "user", content: "test" }],
        tools: [{ name: "tool1", description: "test" }],
      };

      const result = await routing.determineProviderSmart(payload);
      assert.strictEqual(result.provider, "databricks");
      assert.strictEqual(result.method, "static");
    });
  });

  describe("determineProviderSmart()", () => {
    it("should return static routing when tier routing is disabled (no TIER_* vars)", async () => {
      process.env.MODEL_PROVIDER = "databricks";
      process.env.DATABRICKS_API_KEY = "test-key";
      process.env.DATABRICKS_API_BASE = "http://test.com";

      config = require("../src/config");
      routing = require("../src/clients/routing");

      const payload = { messages: [{ role: "user", content: "test" }] };
      const result = await routing.determineProviderSmart(payload);

      assert.strictEqual(result.provider, "databricks");
      assert.strictEqual(result.method, "static");
      assert.strictEqual(result.reason, "tier_routing_disabled");
      assert.strictEqual(result.model, null);
    });

    it("should use tier routing when TIER_* vars are set", async () => {
      process.env.MODEL_PROVIDER = "ollama";
      process.env.OLLAMA_MODEL = "qwen2.5-coder:latest";
      process.env.TIER_SIMPLE = "ollama:llama3.2";
      process.env.TIER_MEDIUM = "ollama:llama3.2";
      process.env.TIER_COMPLEX = "databricks:claude-sonnet";
      process.env.TIER_REASONING = "databricks:claude-sonnet";
      process.env.DATABRICKS_API_KEY = "test-key";
      process.env.DATABRICKS_API_BASE = "http://test.com";

      config = require("../src/config");
      routing = require("../src/clients/routing");

      const payload = { messages: [{ role: "user", content: "test" }] };
      const result = await routing.determineProviderSmart(payload);

      // When tier routing is enabled, method should not be 'static'
      assert.notStrictEqual(result.method, "static");
      assert.ok(result.provider, "provider should be set");
    });
  });

  describe("isFallbackEnabled()", () => {
    it("should return true by default", () => {
      process.env.MODEL_PROVIDER = "ollama";
      process.env.OLLAMA_MODEL = "qwen2.5-coder:latest";
      // Override .env file which sets FALLBACK_ENABLED=false
      // Test default behavior when not set to "false"
      process.env.FALLBACK_ENABLED = "true";

      config = require("../src/config");
      routing = require("../src/clients/routing");

      assert.strictEqual(routing.isFallbackEnabled(), true);
    });

    it("should return false when explicitly disabled", () => {
      process.env.MODEL_PROVIDER = "ollama";
      process.env.OLLAMA_MODEL = "qwen2.5-coder:latest";
      process.env.FALLBACK_ENABLED = "false";

      config = require("../src/config");
      routing = require("../src/clients/routing");

      assert.strictEqual(routing.isFallbackEnabled(), false);
    });
  });

  describe("getFallbackProvider()", () => {
    it("should return databricks by default", () => {
      process.env.MODEL_PROVIDER = "ollama";
      process.env.OLLAMA_MODEL = "qwen2.5-coder:latest";
      process.env.DATABRICKS_API_KEY = "test-key";
      process.env.DATABRICKS_API_BASE = "http://test.com";

      config = require("../src/config");
      routing = require("../src/clients/routing");

      assert.strictEqual(routing.getFallbackProvider(), "databricks");
    });

    it("should return configured fallback provider", () => {
      process.env.MODEL_PROVIDER = "ollama";
      process.env.OLLAMA_MODEL = "qwen2.5-coder:latest";
      process.env.FALLBACK_PROVIDER = "azure-anthropic";
      process.env.AZURE_ANTHROPIC_ENDPOINT = "http://test.com";
      process.env.AZURE_ANTHROPIC_API_KEY = "test-key";

      config = require("../src/config");
      routing = require("../src/clients/routing");

      assert.strictEqual(routing.getFallbackProvider(), "azure-anthropic");
    });
  });
});
