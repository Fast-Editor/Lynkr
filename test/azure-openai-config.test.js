const assert = require("assert");
const { describe, it, beforeEach, afterEach } = require("node:test");

describe("Azure OpenAI Configuration Tests", () => {
  let originalConfig;

  beforeEach(() => {
    // Clear module cache
    delete require.cache[require.resolve("../src/config")];

    // Store original config
    originalConfig = { ...process.env };

    // Set Azure OpenAI environment variables to empty strings to override .env values
    // (deleting them would cause dotenv to reload from .env file)
    process.env.AZURE_OPENAI_ENDPOINT = "";
    process.env.AZURE_OPENAI_API_KEY = "";
    process.env.AZURE_OPENAI_DEPLOYMENT = "";
    process.env.AZURE_OPENAI_API_VERSION = "";
  });

  afterEach(() => {
    // Restore original environment
    process.env = originalConfig;
  });

  describe("Configuration Loading", () => {
    it("should load Azure OpenAI configuration with all values set", () => {
      process.env.AZURE_OPENAI_ENDPOINT = "https://test-resource.openai.azure.com";
      process.env.AZURE_OPENAI_API_KEY = "test-api-key";
      process.env.AZURE_OPENAI_DEPLOYMENT = "gpt-4o";
      process.env.AZURE_OPENAI_API_VERSION = "2024-08-01-preview";
      process.env.MODEL_PROVIDER = "databricks";
      process.env.DATABRICKS_API_KEY = "test-key";
      process.env.DATABRICKS_API_BASE = "http://test.com";

      const config = require("../src/config");

      assert.strictEqual(config.azureOpenAI.endpoint, "https://test-resource.openai.azure.com");
      assert.strictEqual(config.azureOpenAI.apiKey, "test-api-key");
      assert.strictEqual(config.azureOpenAI.deployment, "gpt-4o");
      assert.strictEqual(config.azureOpenAI.apiVersion, "2024-08-01-preview");
    });

    it("should use default values when optional fields not set", () => {
      process.env.AZURE_OPENAI_ENDPOINT = "https://test-resource.openai.azure.com";
      process.env.AZURE_OPENAI_API_KEY = "test-api-key";
      // Keep as empty strings (don't delete) to prevent dotenv from reloading
      process.env.AZURE_OPENAI_DEPLOYMENT = "";
      process.env.AZURE_OPENAI_API_VERSION = "";
      process.env.MODEL_PROVIDER = "databricks";
      process.env.DATABRICKS_API_KEY = "test-key";
      process.env.DATABRICKS_API_BASE = "http://test.com";

      const config = require("../src/config");

      assert.strictEqual(config.azureOpenAI.deployment, "gpt-4o");
      assert.strictEqual(config.azureOpenAI.apiVersion, "2024-08-01-preview");
    });

    it("should load null values when Azure OpenAI not configured", () => {
      // Keep as empty strings (don't delete) to prevent dotenv from reloading
      process.env.AZURE_OPENAI_ENDPOINT = "";
      process.env.AZURE_OPENAI_API_KEY = "";
      process.env.MODEL_PROVIDER = "databricks";
      process.env.DATABRICKS_API_KEY = "test-key";
      process.env.DATABRICKS_API_BASE = "http://test.com";

      const config = require("../src/config");

      assert.strictEqual(config.azureOpenAI.endpoint, null);
      assert.strictEqual(config.azureOpenAI.apiKey, null);
      assert.strictEqual(config.azureOpenAI.deployment, "gpt-4o"); // default
      assert.strictEqual(config.azureOpenAI.apiVersion, "2024-08-01-preview"); // default
    });
  });

  describe("Primary Provider Validation", () => {
    it("should accept azure-openai as MODEL_PROVIDER", () => {
      process.env.MODEL_PROVIDER = "azure-openai";
      process.env.AZURE_OPENAI_ENDPOINT = "https://test-resource.openai.azure.com";
      process.env.AZURE_OPENAI_API_KEY = "test-api-key";

      const config = require("../src/config");

      assert.strictEqual(config.modelProvider.type, "azure-openai");
    });

    it("should throw error when azure-openai is primary provider without endpoint", () => {
      process.env.MODEL_PROVIDER = "azure-openai";
      process.env.AZURE_OPENAI_ENDPOINT = ""; // Empty string, not deleted
      process.env.AZURE_OPENAI_API_KEY = "test-api-key";

      assert.throws(() => {
        require("../src/config");
      }, /AZURE_OPENAI_ENDPOINT and AZURE_OPENAI_API_KEY/);
    });

    it("should throw error when azure-openai is primary provider without API key", () => {
      process.env.MODEL_PROVIDER = "azure-openai";
      process.env.AZURE_OPENAI_ENDPOINT = "https://test-resource.openai.azure.com";
      process.env.AZURE_OPENAI_API_KEY = ""; // Empty string, not deleted

      assert.throws(() => {
        require("../src/config");
      }, /AZURE_OPENAI_ENDPOINT and AZURE_OPENAI_API_KEY/);
    });

    it("should throw error when azure-openai is primary provider without both", () => {
      process.env.MODEL_PROVIDER = "azure-openai";
      process.env.AZURE_OPENAI_ENDPOINT = ""; // Empty string, not deleted
      process.env.AZURE_OPENAI_API_KEY = ""; // Empty string, not deleted

      assert.throws(() => {
        require("../src/config");
      }, /AZURE_OPENAI_ENDPOINT and AZURE_OPENAI_API_KEY/);
    });
  });

  describe("Fallback Provider Validation", () => {
    it("should accept azure-openai as fallback provider with credentials", () => {
      process.env.PREFER_OLLAMA = "true";
      process.env.OLLAMA_ENDPOINT = "http://localhost:11434";
      process.env.OLLAMA_MODEL = "qwen2.5-coder:latest";
      process.env.FALLBACK_ENABLED = "true";
      process.env.FALLBACK_PROVIDER = "azure-openai";
      process.env.AZURE_OPENAI_ENDPOINT = "https://test-resource.openai.azure.com";
      process.env.AZURE_OPENAI_API_KEY = "test-api-key";
      process.env.DATABRICKS_API_KEY = "test-key";
      process.env.DATABRICKS_API_BASE = "http://test.com";

      const config = require("../src/config");

      assert.strictEqual(config.modelProvider.fallbackProvider, "azure-openai");
    });

    it("should reject when azure-openai is fallback but credentials missing", () => {
      process.env.MODEL_PROVIDER = "ollama"; // Set to ollama for hybrid routing scenario
      process.env.PREFER_OLLAMA = "true";
      process.env.OLLAMA_ENDPOINT = "http://localhost:11434";
      process.env.OLLAMA_MODEL = "qwen2.5-coder:latest";
      process.env.FALLBACK_ENABLED = "true";
      process.env.FALLBACK_PROVIDER = "azure-openai";
      // Set to empty strings instead of deleting (dotenv.config() in config module would reload from .env)
      process.env.AZURE_OPENAI_ENDPOINT = "";
      process.env.AZURE_OPENAI_API_KEY = "";
      process.env.DATABRICKS_API_KEY = "test-key";
      process.env.DATABRICKS_API_BASE = "http://test.com";

      // Should throw error about missing Azure OpenAI credentials (fail-fast validation)
      assert.throws(() => {
        require("../src/config");
      }, /AZURE_OPENAI_ENDPOINT and AZURE_OPENAI_API_KEY/);
    });
  });

  describe("Deployment and API Version Defaults", () => {
    it("should use gpt-4o as default deployment", () => {
      // Keep as empty string (don't delete) to prevent dotenv from reloading from .env
      process.env.AZURE_OPENAI_DEPLOYMENT = "";
      process.env.MODEL_PROVIDER = "azure-openai";
      process.env.AZURE_OPENAI_ENDPOINT = "https://test-resource.openai.azure.com";
      process.env.AZURE_OPENAI_API_KEY = "test-api-key";

      const config = require("../src/config");

      assert.strictEqual(config.azureOpenAI.deployment, "gpt-4o");
    });

    it("should use custom deployment when specified", () => {
      process.env.AZURE_OPENAI_DEPLOYMENT = "gpt-5";
      process.env.MODEL_PROVIDER = "databricks";
      process.env.DATABRICKS_API_KEY = "test-key";
      process.env.DATABRICKS_API_BASE = "http://test.com";

      const config = require("../src/config");

      assert.strictEqual(config.azureOpenAI.deployment, "gpt-5");
    });

    it("should use 2024-08-01-preview as default API version", () => {
      // Keep as empty string (don't delete) to prevent dotenv from reloading from .env
      process.env.AZURE_OPENAI_API_VERSION = "";
      process.env.MODEL_PROVIDER = "databricks";
      process.env.DATABRICKS_API_KEY = "test-key";
      process.env.DATABRICKS_API_BASE = "http://test.com";

      const config = require("../src/config");

      assert.strictEqual(config.azureOpenAI.apiVersion, "2024-08-01-preview");
    });

    it("should use custom API version when specified", () => {
      process.env.AZURE_OPENAI_API_VERSION = "2025-01-01-preview";
      process.env.MODEL_PROVIDER = "databricks";
      process.env.DATABRICKS_API_KEY = "test-key";
      process.env.DATABRICKS_API_BASE = "http://test.com";

      const config = require("../src/config");

      assert.strictEqual(config.azureOpenAI.apiVersion, "2025-01-01-preview");
    });
  });
});
