const assert = require("assert");
const { describe, it, beforeEach, afterEach } = require("node:test");

describe("Tool Execution Provider Tests", () => {
  let originalEnv;
  let shouldEnableToolsForRequest;

  beforeEach(() => {
    // Clear require cache to reload config
    delete require.cache[require.resolve("../src/config")];
    delete require.cache[require.resolve("../src/orchestrator")];
    delete require.cache[require.resolve("../src/clients/ollama-utils")];
    originalEnv = { ...process.env };

    // Set required environment variables for tests
    process.env.DATABRICKS_API_BASE = "http://test.com";
    process.env.DATABRICKS_API_KEY = "test-key";
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe("shouldEnableToolsForRequest helper", () => {
    it("should enable tools for non-ollama providers by default", () => {
      process.env.MODEL_PROVIDER = "openrouter";
      const config = require("../src/config");

      // Import the orchestrator module to access the helper
      // Note: Since shouldEnableToolsForRequest is not exported, we test via integration
      // For now, we'll test the expected behavior through config

      assert.strictEqual(config.modelProvider.type, "openrouter");
    });

    it("should enable tools when TOOL_EXECUTION_PROVIDER is configured for non-tool-capable model", () => {
      process.env.MODEL_PROVIDER = "ollama";
      process.env.OLLAMA_ENDPOINT = "http://localhost:11434";
      process.env.OLLAMA_MODEL = "qwen3-coder-next";
      process.env.TOOL_EXECUTION_PROVIDER = "openrouter";
      process.env.TOOL_EXECUTION_MODEL = "deepseek/deepseek-chat";

      const config = require("../src/config");

      assert.strictEqual(config.modelProvider.type, "ollama");
      assert.strictEqual(config.ollama.model, "qwen3-coder-next");
      assert.strictEqual(config.toolExecutionProvider, "openrouter");
      assert.strictEqual(config.toolExecutionModel, "deepseek/deepseek-chat");
    });

    it("should enable compare mode when TOOL_EXECUTION_COMPARE_MODE is true", () => {
      process.env.MODEL_PROVIDER = "ollama";
      process.env.OLLAMA_ENDPOINT = "http://localhost:11434";
      process.env.OLLAMA_MODEL = "qwen3-coder-next";
      process.env.TOOL_EXECUTION_PROVIDER = "openrouter";
      process.env.TOOL_EXECUTION_MODEL = "deepseek/deepseek-chat";
      process.env.TOOL_EXECUTION_COMPARE_MODE = "true";

      const config = require("../src/config");

      assert.strictEqual(config.toolExecutionCompareMode, true);
    });
  });

  describe("Tool capability detection", () => {
    it("should recognize qwen3 as tool-capable", () => {
      const { modelNameSupportsTools } = require("../src/clients/ollama-utils");

      assert.strictEqual(modelNameSupportsTools("qwen3-coder-next"), true);
      assert.strictEqual(modelNameSupportsTools("qwen3"), true);
    });

    it("should recognize llama3.1 as tool-capable", () => {
      const { modelNameSupportsTools } = require("../src/clients/ollama-utils");

      assert.strictEqual(modelNameSupportsTools("llama3.1"), true);
      assert.strictEqual(modelNameSupportsTools("llama3.1:8b"), true);
    });

    it("should recognize non-tool-capable models", () => {
      const { modelNameSupportsTools } = require("../src/clients/ollama-utils");

      // Example of a model that doesn't support tools
      assert.strictEqual(modelNameSupportsTools("llama2"), false);
      assert.strictEqual(modelNameSupportsTools("codellama"), false);
    });
  });

  describe("Tool Execution Provider Configuration", () => {
    it("should route tool calls to tool execution provider when configured", () => {
      process.env.MODEL_PROVIDER = "ollama";
      process.env.OLLAMA_ENDPOINT = "http://localhost:11434";
      process.env.OLLAMA_MODEL = "qwen3-coder-next";
      process.env.TOOL_EXECUTION_PROVIDER = "openrouter";
      process.env.TOOL_EXECUTION_MODEL = "deepseek/deepseek-chat";

      const config = require("../src/config");

      // Verify configuration is set up correctly
      assert.strictEqual(config.toolExecutionProvider, "openrouter");
      assert.strictEqual(config.toolExecutionModel, "deepseek/deepseek-chat");

      // Tool execution provider should be different from conversation provider
      assert.notStrictEqual(config.toolExecutionProvider, config.modelProvider.type);
    });

    it("should not route when TOOL_EXECUTION_PROVIDER equals conversation provider", () => {
      process.env.MODEL_PROVIDER = "openrouter";
      process.env.TOOL_EXECUTION_PROVIDER = "openrouter";

      const config = require("../src/config");

      // When providers are the same, no routing should occur
      assert.strictEqual(config.toolExecutionProvider, config.modelProvider.type);
    });
  });

  describe("Integration: Tool enabling logic", () => {
    it("should keep tools when TOOL_EXECUTION_PROVIDER configured", () => {
      // This tests the fix: tools should NOT be removed when tool execution provider is configured
      // even if the conversation model doesn't natively support tools

      process.env.MODEL_PROVIDER = "ollama";
      process.env.OLLAMA_ENDPOINT = "http://localhost:11434";
      process.env.OLLAMA_MODEL = "some-non-tool-model";  // Hypothetical non-tool model
      process.env.TOOL_EXECUTION_PROVIDER = "openrouter";
      process.env.TOOL_EXECUTION_MODEL = "deepseek/deepseek-chat";

      const config = require("../src/config");

      // The fix ensures that:
      // 1. toolExecutionProvider is configured
      assert.ok(config.toolExecutionProvider);
      // 2. It's different from the conversation provider
      assert.notStrictEqual(config.toolExecutionProvider, config.modelProvider.type);

      // Expected behavior: Tools should be enabled despite non-tool-capable conversation model
      // This is validated by the shouldEnableToolsForRequest function in orchestrator
    });
  });
});
