const assert = require("assert");
const { describe, it, beforeEach } = require("node:test");

describe("Dual Ollama Endpoint Routing", () => {
  let ollamaUtils;

  beforeEach(() => {
    // Set minimum config to avoid validation errors
    process.env.MODEL_PROVIDER = "ollama";
    process.env.OLLAMA_ENDPOINT = "http://192.168.100.201:11434";
    process.env.OLLAMA_MODEL = "qwen2.5-coder:latest";

    // Clear relevant module caches
    delete require.cache[require.resolve("../src/clients/ollama-utils")];
    delete require.cache[require.resolve("../src/config")];
  });

  describe("isCloudModel()", () => {
    beforeEach(() => {
      delete process.env.OLLAMA_CLOUD_ENDPOINT;
      delete process.env.OLLAMA_API_KEY;
      delete require.cache[require.resolve("../src/clients/ollama-utils")];
      delete require.cache[require.resolve("../src/config")];
      ollamaUtils = require("../src/clients/ollama-utils");
    });

    it("should detect cloud models with -cloud in tag", () => {
      assert.strictEqual(ollamaUtils.isCloudModel("deepseek-v3.1:671b-cloud"), true);
      assert.strictEqual(ollamaUtils.isCloudModel("nemotron-3-nano:30b-cloud"), true);
    });

    it("should detect cloud models with :cloud tag", () => {
      assert.strictEqual(ollamaUtils.isCloudModel("glm-4.7:cloud"), true);
      assert.strictEqual(ollamaUtils.isCloudModel("some-model:cloud"), true);
    });

    it("should detect cloud models case-insensitively", () => {
      assert.strictEqual(ollamaUtils.isCloudModel("deepseek-v3.1:671b-CLOUD"), true);
      assert.strictEqual(ollamaUtils.isCloudModel("model:tag-Cloud"), true);
      assert.strictEqual(ollamaUtils.isCloudModel("glm-4.7:CLOUD"), true);
    });

    it("should return false for local models", () => {
      assert.strictEqual(ollamaUtils.isCloudModel("qwen2.5-coder:latest"), false);
      assert.strictEqual(ollamaUtils.isCloudModel("llama3.1:8b"), false);
      assert.strictEqual(ollamaUtils.isCloudModel("mistral-nemo"), false);
    });

    it("should handle null/undefined/empty", () => {
      assert.strictEqual(ollamaUtils.isCloudModel(null), false);
      assert.strictEqual(ollamaUtils.isCloudModel(undefined), false);
      assert.strictEqual(ollamaUtils.isCloudModel(""), false);
      assert.strictEqual(ollamaUtils.isCloudModel(123), false);
    });
  });

  describe("getOllamaEndpointForModel()", () => {
    it("should route cloud models to cloud endpoint when configured", () => {
      process.env.OLLAMA_CLOUD_ENDPOINT = "https://ollama.com";
      delete require.cache[require.resolve("../src/clients/ollama-utils")];
      delete require.cache[require.resolve("../src/config")];
      ollamaUtils = require("../src/clients/ollama-utils");

      assert.strictEqual(
        ollamaUtils.getOllamaEndpointForModel("deepseek-v3.1:671b-cloud"),
        "https://ollama.com"
      );
    });

    it("should route local models to local endpoint even when cloud is configured", () => {
      process.env.OLLAMA_CLOUD_ENDPOINT = "https://ollama.com";
      delete require.cache[require.resolve("../src/clients/ollama-utils")];
      delete require.cache[require.resolve("../src/config")];
      ollamaUtils = require("../src/clients/ollama-utils");

      assert.strictEqual(
        ollamaUtils.getOllamaEndpointForModel("qwen2.5-coder:latest"),
        "http://192.168.100.201:11434"
      );
    });

    it("should route cloud models to local endpoint when no cloud endpoint configured", () => {
      delete process.env.OLLAMA_CLOUD_ENDPOINT;
      delete require.cache[require.resolve("../src/clients/ollama-utils")];
      delete require.cache[require.resolve("../src/config")];
      ollamaUtils = require("../src/clients/ollama-utils");

      // Without cloud endpoint, even cloud-named models use local endpoint
      assert.strictEqual(
        ollamaUtils.getOllamaEndpointForModel("deepseek-v3.1:671b-cloud"),
        "http://192.168.100.201:11434"
      );
    });

    it("should fall back to localhost when no endpoint configured at all", () => {
      delete process.env.OLLAMA_ENDPOINT;
      delete process.env.OLLAMA_CLOUD_ENDPOINT;
      process.env.MODEL_PROVIDER = "databricks";
      process.env.DATABRICKS_API_KEY = "test-key";
      process.env.DATABRICKS_API_BASE = "http://test.com";
      delete require.cache[require.resolve("../src/clients/ollama-utils")];
      delete require.cache[require.resolve("../src/config")];
      ollamaUtils = require("../src/clients/ollama-utils");

      assert.strictEqual(
        ollamaUtils.getOllamaEndpointForModel("some-model"),
        "http://localhost:11434"
      );
    });
  });

  describe("Cloud-only configuration (no OLLAMA_ENDPOINT)", () => {
    beforeEach(() => {
      delete process.env.OLLAMA_ENDPOINT;
      process.env.OLLAMA_CLOUD_ENDPOINT = "https://ollama.com";
      process.env.OLLAMA_MODEL = "glm-4.7:cloud";
      process.env.MODEL_PROVIDER = "ollama";
      delete require.cache[require.resolve("../src/clients/ollama-utils")];
      delete require.cache[require.resolve("../src/config")];
      ollamaUtils = require("../src/clients/ollama-utils");
    });

    it("should route cloud model to cloud endpoint", () => {
      assert.strictEqual(
        ollamaUtils.getOllamaEndpointForModel("glm-4.7:cloud"),
        "https://ollama.com"
      );
    });

    it("should route non-cloud model to cloud endpoint as fallback", () => {
      // In cloud-only mode, even non-cloud-named models go to cloud endpoint
      assert.strictEqual(
        ollamaUtils.getOllamaEndpointForModel("some-local-model"),
        "https://ollama.com"
      );
    });

    it("should pass config validation with only cloud endpoint", () => {
      // If we got here without throwing, validation passed
      const config = require("../src/config");
      assert.strictEqual(config.ollama.endpoint, null);
      assert.strictEqual(config.ollama.cloudEndpoint, "https://ollama.com");
      assert.strictEqual(config.ollama.model, "glm-4.7:cloud");
    });

    it("should have null embeddings endpoint when no local endpoint", () => {
      const config = require("../src/config");
      assert.strictEqual(config.ollama.embeddingsEndpoint, null);
    });
  });

  describe("Config validation", () => {
    it("should throw when MODEL_PROVIDER=ollama but no model set", () => {
      delete process.env.OLLAMA_MODEL;
      process.env.OLLAMA_ENDPOINT = "http://localhost:11434";
      process.env.MODEL_PROVIDER = "ollama";
      delete require.cache[require.resolve("../src/config")];

      assert.throws(
        () => require("../src/config"),
        { message: /OLLAMA_MODEL is required/ }
      );
    });

    it("should throw when MODEL_PROVIDER=ollama but no endpoints set", () => {
      delete process.env.OLLAMA_ENDPOINT;
      delete process.env.OLLAMA_CLOUD_ENDPOINT;
      process.env.OLLAMA_MODEL = "qwen2.5-coder:latest";
      process.env.MODEL_PROVIDER = "ollama";
      delete require.cache[require.resolve("../src/config")];

      assert.throws(
        () => require("../src/config"),
        { message: /OLLAMA_ENDPOINT.*OLLAMA_CLOUD_ENDPOINT/ }
      );
    });

    it("should accept local-only config", () => {
      process.env.OLLAMA_ENDPOINT = "http://localhost:11434";
      process.env.OLLAMA_MODEL = "qwen2.5-coder:latest";
      delete process.env.OLLAMA_CLOUD_ENDPOINT;
      process.env.MODEL_PROVIDER = "ollama";
      delete require.cache[require.resolve("../src/config")];

      const config = require("../src/config");
      assert.strictEqual(config.ollama.endpoint, "http://localhost:11434");
      assert.strictEqual(config.ollama.cloudEndpoint, null);
    });
  });

  describe("getOllamaHeaders() with model-aware auth", () => {
    it("should include auth for cloud models when API key and cloud endpoint configured", () => {
      process.env.OLLAMA_API_KEY = "test-key-123";
      process.env.OLLAMA_CLOUD_ENDPOINT = "https://ollama.com";
      delete require.cache[require.resolve("../src/clients/ollama-utils")];
      delete require.cache[require.resolve("../src/config")];
      ollamaUtils = require("../src/clients/ollama-utils");

      const headers = ollamaUtils.getOllamaHeaders("deepseek-v3.1:671b-cloud");
      assert.strictEqual(headers["Authorization"], "Bearer test-key-123");
      assert.strictEqual(headers["Content-Type"], "application/json");
    });

    it("should NOT include auth for local models when cloud endpoint is configured", () => {
      process.env.OLLAMA_API_KEY = "test-key-123";
      process.env.OLLAMA_CLOUD_ENDPOINT = "https://ollama.com";
      delete require.cache[require.resolve("../src/clients/ollama-utils")];
      delete require.cache[require.resolve("../src/config")];
      ollamaUtils = require("../src/clients/ollama-utils");

      const headers = ollamaUtils.getOllamaHeaders("qwen2.5-coder:latest");
      assert.strictEqual(headers["Authorization"], undefined);
      assert.strictEqual(headers["Content-Type"], "application/json");
    });

    it("should include auth for ALL models when no cloud endpoint (legacy compat)", () => {
      process.env.OLLAMA_API_KEY = "test-key-123";
      delete process.env.OLLAMA_CLOUD_ENDPOINT;
      delete require.cache[require.resolve("../src/clients/ollama-utils")];
      delete require.cache[require.resolve("../src/config")];
      ollamaUtils = require("../src/clients/ollama-utils");

      const localHeaders = ollamaUtils.getOllamaHeaders("qwen2.5-coder:latest");
      assert.strictEqual(localHeaders["Authorization"], "Bearer test-key-123");

      const cloudHeaders = ollamaUtils.getOllamaHeaders("deepseek-v3.1:671b-cloud");
      assert.strictEqual(cloudHeaders["Authorization"], "Bearer test-key-123");
    });

    it("should NOT include auth for any model when no API key", () => {
      delete process.env.OLLAMA_API_KEY;
      process.env.OLLAMA_CLOUD_ENDPOINT = "https://ollama.com";
      delete require.cache[require.resolve("../src/clients/ollama-utils")];
      delete require.cache[require.resolve("../src/config")];
      ollamaUtils = require("../src/clients/ollama-utils");

      const headers = ollamaUtils.getOllamaHeaders("deepseek-v3.1:671b-cloud");
      assert.strictEqual(headers["Authorization"], undefined);
    });

    it("should NOT include auth when called without model arg and cloud endpoint is set", () => {
      process.env.OLLAMA_API_KEY = "test-key-123";
      process.env.OLLAMA_CLOUD_ENDPOINT = "https://ollama.com";
      delete require.cache[require.resolve("../src/clients/ollama-utils")];
      delete require.cache[require.resolve("../src/config")];
      ollamaUtils = require("../src/clients/ollama-utils");

      // No model arg = not a cloud model, and cloud endpoint is set, so no auth
      const headers = ollamaUtils.getOllamaHeaders();
      assert.strictEqual(headers["Authorization"], undefined);
    });

    it("should include auth when called without model arg and no cloud endpoint (legacy)", () => {
      process.env.OLLAMA_API_KEY = "test-key-123";
      delete process.env.OLLAMA_CLOUD_ENDPOINT;
      delete require.cache[require.resolve("../src/clients/ollama-utils")];
      delete require.cache[require.resolve("../src/config")];
      ollamaUtils = require("../src/clients/ollama-utils");

      // No cloud endpoint = legacy mode, auth sent to all
      const headers = ollamaUtils.getOllamaHeaders();
      assert.strictEqual(headers["Authorization"], "Bearer test-key-123");
    });
  });
});
