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
    delete require.cache[require.resolve("../src/clients/ollama-utils")];

    // Store original config
    originalConfig = { ...process.env };
    
    // Explicitly set valid fallback to override any local .env pollution (e.g. lmstudio)
    process.env.FALLBACK_PROVIDER = "databricks";
  });

  afterEach(() => {
    // Restore original environment
    process.env = originalConfig;
  });

  describe("determineProvider()", () => {
    it("should return configured provider when PREFER_OLLAMA is false", () => {
      process.env.MODEL_PROVIDER = "databricks";
      process.env.PREFER_OLLAMA = "false";

      config = require("../src/config");
      routing = require("../src/clients/routing");

      const payload = { messages: [{ role: "user", content: "test" }] };
      const provider = routing.determineProvider(payload);

      assert.strictEqual(provider, "databricks");
    });

    it("should route to ollama when no tools and PREFER_OLLAMA is true", () => {
      process.env.MODEL_PROVIDER = "ollama";
      process.env.PREFER_OLLAMA = "true";
      process.env.OLLAMA_MODEL = "qwen2.5-coder:latest";

      config = require("../src/config");
      routing = require("../src/clients/routing");

      const payload = {
        messages: [{ role: "user", content: "test" }],
        tools: [],
      };

      const provider = routing.determineProvider(payload);
      assert.strictEqual(provider, "ollama");
    });

    it("should route to ollama when tool count < threshold", () => {
      process.env.MODEL_PROVIDER = "ollama";
      process.env.PREFER_OLLAMA = "true";
      process.env.OLLAMA_MODEL = "qwen2.5-coder:latest";
      process.env.OLLAMA_MAX_TOOLS_FOR_ROUTING = "3";

      config = require("../src/config");
      routing = require("../src/clients/routing");

      const payload = {
        messages: [{ role: "user", content: "test" }],
        tools: [
          { name: "tool1", description: "test" },
          { name: "tool2", description: "test" },
        ],
      };

      const provider = routing.determineProvider(payload);
      assert.strictEqual(provider, "ollama");
    });

    it("should route to cloud when tool count >= threshold", () => {
      process.env.MODEL_PROVIDER = "ollama";
      process.env.PREFER_OLLAMA = "true";
      process.env.OLLAMA_MODEL = "qwen2.5-coder:latest";
      process.env.OLLAMA_MAX_TOOLS_FOR_ROUTING = "3";
      process.env.OPENROUTER_MAX_TOOLS_FOR_ROUTING = "3"; // Set same as ollama to skip openrouter tier
      process.env.FALLBACK_PROVIDER = "databricks";
      process.env.FALLBACK_ENABLED = "true"; // Ensure fallback is enabled
      process.env.DATABRICKS_API_KEY = "test-key";
      process.env.DATABRICKS_API_BASE = "http://test.com";
      // Set Azure OpenAI to empty to prevent dotenv from loading .env values
      // dotenv won't override existing vars, even if empty
      process.env.AZURE_OPENAI_ENDPOINT = "";
      process.env.AZURE_OPENAI_API_KEY = "";
      process.env.OPENROUTER_API_KEY = "";

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

      const provider = routing.determineProvider(payload);
      assert.strictEqual(provider, "databricks");
    });

    it("should route to cloud when model doesn't support tools", () => {
      process.env.MODEL_PROVIDER = "ollama";
      process.env.PREFER_OLLAMA = "true";
      process.env.OLLAMA_MODEL = "llama3:latest"; // Non-tool-capable model
      process.env.OLLAMA_FALLBACK_PROVIDER = "databricks";
      process.env.FALLBACK_ENABLED = "true"; // Ensure fallback is enabled
      process.env.DATABRICKS_API_KEY = "test-key";
      process.env.DATABRICKS_API_BASE = "http://test.com";

      config = require("../src/config");
      routing = require("../src/clients/routing");

      const payload = {
        messages: [{ role: "user", content: "test" }],
        tools: [{ name: "tool1", description: "test" }],
      };

      const provider = routing.determineProvider(payload);
      assert.strictEqual(provider, "databricks");
    });

    it("should use custom max tools threshold", () => {
      process.env.MODEL_PROVIDER = "ollama";
      process.env.PREFER_OLLAMA = "true";
      process.env.OLLAMA_MODEL = "qwen2.5-coder:latest";
      process.env.OLLAMA_MAX_TOOLS_FOR_ROUTING = "5";
      process.env.OLLAMA_FALLBACK_PROVIDER = "databricks";
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
        ],
      };

      // 4 tools < 5, should route to ollama
      const provider = routing.determineProvider(payload);
      assert.strictEqual(provider, "ollama");
    });
  });

  describe("isFallbackEnabled()", () => {
    it("should return true by default", () => {
      process.env.MODEL_PROVIDER = "ollama";
      process.env.PREFER_OLLAMA = "true";
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
      process.env.PREFER_OLLAMA = "true";
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
      process.env.PREFER_OLLAMA = "true";
      process.env.OLLAMA_MODEL = "qwen2.5-coder:latest";
      process.env.DATABRICKS_API_KEY = "test-key";
      process.env.DATABRICKS_API_BASE = "http://test.com";

      config = require("../src/config");
      routing = require("../src/clients/routing");

      assert.strictEqual(routing.getFallbackProvider(), "databricks");
    });

    it("should return configured fallback provider", () => {
      process.env.MODEL_PROVIDER = "ollama";
      process.env.PREFER_OLLAMA = "true";
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
