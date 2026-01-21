const assert = require("assert");
const { describe, it, beforeEach, afterEach } = require("node:test");

describe("Azure OpenAI Routing Tests", () => {
  let routing;
  let originalConfig;

  beforeEach(() => {
    // Clear module cache
    delete require.cache[require.resolve("../src/config")];
    delete require.cache[require.resolve("../src/clients/routing")];

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
      process.env.PREFER_OLLAMA = "false";

      routing = require("../src/clients/routing");

      const provider = routing.determineProvider({ tools: [] });

      assert.strictEqual(provider, "azure-openai");
    });
  });

  describe("Hybrid Routing with Azure OpenAI", () => {
    it("should route moderate tool requests to azure-openai when available", () => {
      // Explicitly unset OpenRouter to ensure it's not available
      // Set to empty string instead of delete to prevent dotenv from reloading it
      process.env.OPENROUTER_API_KEY = "";

      process.env.PREFER_OLLAMA = "true";
      process.env.OLLAMA_ENDPOINT = "http://localhost:11434";
      process.env.OLLAMA_MODEL = "qwen2.5-coder:latest";
      process.env.FALLBACK_ENABLED = "true";
      process.env.OLLAMA_MAX_TOOLS_FOR_ROUTING = "3";
      process.env.OPENROUTER_MAX_TOOLS_FOR_ROUTING = "15";
      process.env.AZURE_OPENAI_ENDPOINT = "https://test.openai.azure.com";
      process.env.AZURE_OPENAI_API_KEY = "test-key";

      // Clear cache after env setup
      delete require.cache[require.resolve("../src/config/index.js")];
      delete require.cache[require.resolve("../src/clients/routing")];
      delete require.cache[require.resolve("../src/routing/index.js")];

      routing = require("../src/clients/routing");

      // 5 tools: more than Ollama threshold (3), less than OpenRouter threshold (15)
      const provider = routing.determineProvider({
        tools: [{}, {}, {}, {}, {}]
      });

      assert.strictEqual(provider, "azure-openai");
    });

    it("should prefer OpenRouter over Azure OpenAI when both configured", () => {
      process.env.PREFER_OLLAMA = "true";
      process.env.OLLAMA_ENDPOINT = "http://localhost:11434";
      process.env.OLLAMA_MODEL = "qwen2.5-coder:latest";
      process.env.FALLBACK_ENABLED = "true";
      process.env.OLLAMA_MAX_TOOLS_FOR_ROUTING = "3";
      process.env.OPENROUTER_MAX_TOOLS_FOR_ROUTING = "15";
      process.env.OPENROUTER_API_KEY = "openrouter-key";
      process.env.AZURE_OPENAI_ENDPOINT = "https://test.openai.azure.com";
      process.env.AZURE_OPENAI_API_KEY = "azure-key";

      // Clear cache after env setup
      delete require.cache[require.resolve("../src/config/index.js")];
      delete require.cache[require.resolve("../src/clients/routing")];
      delete require.cache[require.resolve("../src/routing/index.js")];

      routing = require("../src/clients/routing");

      // 5 tools: should prefer OpenRouter
      const provider = routing.determineProvider({
        tools: [{}, {}, {}, {}, {}]
      });

      assert.strictEqual(provider, "openrouter");
    });

    it("should route simple requests to Ollama even when Azure OpenAI configured", () => {
      process.env.PREFER_OLLAMA = "true";
      process.env.OLLAMA_ENDPOINT = "http://localhost:11434";
      process.env.OLLAMA_MODEL = "qwen2.5-coder:latest";
      process.env.FALLBACK_ENABLED = "true";
      process.env.OLLAMA_MAX_TOOLS_FOR_ROUTING = "3";
      process.env.AZURE_OPENAI_ENDPOINT = "https://test.openai.azure.com";
      process.env.AZURE_OPENAI_API_KEY = "test-key";

      // Clear cache after env setup
      delete require.cache[require.resolve("../src/config/index.js")];
      delete require.cache[require.resolve("../src/clients/routing")];
      delete require.cache[require.resolve("../src/routing/index.js")];

      routing = require("../src/clients/routing");

      // 2 tools: under Ollama threshold
      const provider = routing.determineProvider({
        tools: [{}, {}]
      });

      assert.strictEqual(provider, "ollama");
    });
  });

  describe("Fallback Configuration", () => {
    it("should support azure-openai as fallback provider", () => {
      process.env.PREFER_OLLAMA = "true";
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
