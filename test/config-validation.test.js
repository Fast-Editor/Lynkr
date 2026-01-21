const assert = require("assert");
const { describe, it, beforeEach, afterEach } = require("node:test");

describe("Config Validation Tests", () => {
  let originalEnv;

  beforeEach(() => {
    delete require.cache[require.resolve("../src/config")];
    originalEnv = { ...process.env };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe("MODEL_PROVIDER Validation", () => {
    it("should throw error for invalid provider", () => {
      process.env.MODEL_PROVIDER = "openaix";

      assert.throws(
        () => require("../src/config"),
        /Unsupported MODEL_PROVIDER.*openaix.*Valid options are:/
      );
    });

    it("should throw error for completely invalid provider", () => {
      process.env.MODEL_PROVIDER = "invalid";

      assert.throws(
        () => require("../src/config"),
        /Unsupported MODEL_PROVIDER.*invalid.*Valid options are:/
      );
    });

    it("should throw error for typo 'ollamma'", () => {
      process.env.MODEL_PROVIDER = "ollamma";

      assert.throws(
        () => require("../src/config"),
        /Unsupported MODEL_PROVIDER.*ollamma.*Valid options are:/
      );
    });

    it("should throw error for partial name 'azure'", () => {
      process.env.MODEL_PROVIDER = "azure";

      assert.throws(
        () => require("../src/config"),
        /Unsupported MODEL_PROVIDER.*azure.*Valid options are:/
      );
    });

    it("should list all valid providers in error message", () => {
      process.env.MODEL_PROVIDER = "invalid";

      try {
        require("../src/config");
        assert.fail("Should have thrown an error");
      } catch (err) {
        const message = err.message;
        // Check that all valid providers are listed
        assert.match(message, /azure-anthropic/);
        assert.match(message, /azure-openai/);
        assert.match(message, /bedrock/);
        assert.match(message, /databricks/);
        assert.match(message, /llamacpp/);
        assert.match(message, /lmstudio/);
        assert.match(message, /ollama/);
        assert.match(message, /openai/);
        assert.match(message, /openrouter/);
      }
    });

    it("should accept valid provider 'ollama'", () => {
      process.env.MODEL_PROVIDER = "ollama";
      process.env.OLLAMA_ENDPOINT = "http://localhost:11434";
      process.env.FALLBACK_ENABLED = "false";

      const config = require("../src/config");

      assert.strictEqual(config.modelProvider.type, "ollama");
    });

    it("should accept valid provider 'databricks'", () => {
      process.env.MODEL_PROVIDER = "databricks";
      process.env.DATABRICKS_API_BASE = "http://test.com";
      process.env.DATABRICKS_API_KEY = "test-key";

      const config = require("../src/config");

      assert.strictEqual(config.modelProvider.type, "databricks");
    });

    it("should accept valid provider 'azure-anthropic'", () => {
      process.env.MODEL_PROVIDER = "azure-anthropic";
      process.env.AZURE_ANTHROPIC_ENDPOINT = "http://test.com";
      process.env.AZURE_ANTHROPIC_API_KEY = "test-key";

      const config = require("../src/config");

      assert.strictEqual(config.modelProvider.type, "azure-anthropic");
    });

    it("should accept valid provider 'azure-openai'", () => {
      process.env.MODEL_PROVIDER = "azure-openai";
      process.env.AZURE_OPENAI_ENDPOINT = "https://test-resource.openai.azure.com";
      process.env.AZURE_OPENAI_API_KEY = "test-key";

      const config = require("../src/config");

      assert.strictEqual(config.modelProvider.type, "azure-openai");
    });

    it("should accept valid provider 'openai'", () => {
      process.env.MODEL_PROVIDER = "openai";
      process.env.OPENAI_API_KEY = "test-key";

      const config = require("../src/config");

      assert.strictEqual(config.modelProvider.type, "openai");
    });

    it("should accept valid provider 'openrouter'", () => {
      process.env.MODEL_PROVIDER = "openrouter";
      process.env.OPENROUTER_API_KEY = "test-key";
      process.env.DATABRICKS_API_BASE = "http://test.com";
      process.env.DATABRICKS_API_KEY = "test-key";

      const config = require("../src/config");

      assert.strictEqual(config.modelProvider.type, "openrouter");
    });

    it("should accept valid provider 'llamacpp'", () => {
      process.env.MODEL_PROVIDER = "llamacpp";
      process.env.LLAMACPP_ENDPOINT = "http://localhost:8080";
      process.env.DATABRICKS_API_BASE = "http://test.com";
      process.env.DATABRICKS_API_KEY = "test-key";

      const config = require("../src/config");

      assert.strictEqual(config.modelProvider.type, "llamacpp");
    });

    it("should accept valid provider 'lmstudio'", () => {
      process.env.MODEL_PROVIDER = "lmstudio";
      process.env.LMSTUDIO_ENDPOINT = "http://localhost:1234";
      process.env.DATABRICKS_API_BASE = "http://test.com";
      process.env.DATABRICKS_API_KEY = "test-key";

      const config = require("../src/config");

      assert.strictEqual(config.modelProvider.type, "lmstudio");
    });

    it("should accept valid provider 'bedrock'", () => {
      process.env.MODEL_PROVIDER = "bedrock";
      process.env.AWS_BEDROCK_API_KEY = "test-key";

      const config = require("../src/config");

      assert.strictEqual(config.modelProvider.type, "bedrock");
    });

    it("should accept uppercase provider name 'OLLAMA'", () => {
      process.env.MODEL_PROVIDER = "OLLAMA";
      process.env.OLLAMA_ENDPOINT = "http://localhost:11434";
      process.env.FALLBACK_ENABLED = "false";

      const config = require("../src/config");

      assert.strictEqual(config.modelProvider.type, "ollama");
    });

    it("should accept mixed-case provider name 'Databricks'", () => {
      process.env.MODEL_PROVIDER = "Databricks";
      process.env.DATABRICKS_API_BASE = "http://test.com";
      process.env.DATABRICKS_API_KEY = "test-key";

      const config = require("../src/config");

      assert.strictEqual(config.modelProvider.type, "databricks");
    });

    it("should default to 'databricks' when MODEL_PROVIDER not set", () => {
      delete process.env.MODEL_PROVIDER;
      process.env.DATABRICKS_API_BASE = "http://test.com";
      process.env.DATABRICKS_API_KEY = "test-key";

      const config = require("../src/config");

      assert.strictEqual(config.modelProvider.type, "databricks");
    });

    it("should show original case in error message for case-sensitive debugging", () => {
      process.env.MODEL_PROVIDER = "OpEnAIx";

      try {
        require("../src/config");
        assert.fail("Should have thrown an error");
      } catch (err) {
        // Error message should show original case for debugging
        assert.match(err.message, /OpEnAIx/);
      }
    });
  });
});
