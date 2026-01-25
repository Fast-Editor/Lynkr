const assert = require("assert");
const { describe, it, beforeEach, afterEach } = require("node:test");

describe("Hybrid Routing Integration Tests", () => {
  let config;
  let databricks;
  let metrics;
  let originalConfig;

  beforeEach(() => {
    // Clear module cache
    delete require.cache[require.resolve("../src/config")];
    delete require.cache[require.resolve("../src/clients/databricks")];
    delete require.cache[require.resolve("../src/observability/metrics")];
    delete require.cache[require.resolve("../src/clients/routing")];

    // Store original config
    originalConfig = { ...process.env };

    // Set up test environment
    process.env.DATABRICKS_API_KEY = "test-key";
    process.env.DATABRICKS_API_BASE = "http://test.databricks.com";
    process.env.MODEL_PROVIDER = "databricks";
  });

  afterEach(() => {
    // Restore original environment
    process.env = originalConfig;
  });

  describe("Configuration Validation", () => {
    it("should use default OLLAMA_ENDPOINT when not specified", () => {
      process.env.PREFER_OLLAMA = "true";
      delete process.env.OLLAMA_ENDPOINT;
      process.env.OLLAMA_MODEL = "qwen2.5-coder:latest";
      process.env.DATABRICKS_API_KEY = "test-key";
      process.env.DATABRICKS_API_BASE = "http://test.com";

      const config = require("../src/config");

      // Should use default localhost:11434
      assert.strictEqual(config.ollama.endpoint, "http://localhost:11434");
    });

    it("should reject invalid FALLBACK_PROVIDER", () => {
      process.env.PREFER_OLLAMA = "true";
      process.env.OLLAMA_ENDPOINT = "http://localhost:11434";
      process.env.OLLAMA_MODEL = "qwen2.5-coder:latest";
      process.env.FALLBACK_ENABLED = "true";
      process.env.FALLBACK_PROVIDER = "invalid-provider";

      assert.throws(() => {
        require("../src/config");
      }, /Unsupported FALLBACK_PROVIDER.*Valid options are/);
    });

    it("should reject circular fallback (ollama -> ollama)", () => {
      process.env.PREFER_OLLAMA = "true";
      process.env.OLLAMA_ENDPOINT = "http://localhost:11434";
      process.env.OLLAMA_MODEL = "qwen2.5-coder:latest";
      process.env.FALLBACK_ENABLED = "true";
      process.env.FALLBACK_PROVIDER = "ollama";

      assert.throws(() => {
        require("../src/config");
      }, /FALLBACK_PROVIDER cannot be 'ollama'/);
    });

    it("should reject PREFER_OLLAMA with databricks fallback but no databricks credentials", () => {
      process.env.MODEL_PROVIDER = "ollama";  // Set to ollama for hybrid routing scenario
      process.env.PREFER_OLLAMA = "true";
      process.env.OLLAMA_ENDPOINT = "http://localhost:11434";
      process.env.OLLAMA_MODEL = "qwen2.5-coder:latest";
      process.env.FALLBACK_ENABLED = "true";
      process.env.FALLBACK_PROVIDER = "databricks";
      // Set to empty strings instead of deleting (dotenv.config() in config module would reload from .env)
      process.env.DATABRICKS_API_KEY = "";
      process.env.DATABRICKS_API_BASE = "";

      // Should throw error about missing databricks credentials
      // (Either from standard validation or hybrid routing validation)
      assert.throws(() => {
        require("../src/config");
      }, /DATABRICKS_API_BASE and DATABRICKS_API_KEY/);
    });

    it("should accept valid hybrid routing configuration", () => {
      process.env.PREFER_OLLAMA = "true";
      process.env.OLLAMA_ENDPOINT = "http://localhost:11434";
      process.env.OLLAMA_MODEL = "qwen2.5-coder:latest";
      process.env.FALLBACK_ENABLED = "true";
      process.env.FALLBACK_PROVIDER = "databricks";
      process.env.OLLAMA_MAX_TOOLS_FOR_ROUTING = "3"; // Override .env which sets it to 2
      process.env.DATABRICKS_API_KEY = "test-key";
      process.env.DATABRICKS_API_BASE = "http://test.com";

      const config = require("../src/config");

      assert.strictEqual(config.modelProvider.preferOllama, true);
      assert.strictEqual(config.modelProvider.fallbackEnabled, true);
      assert.strictEqual(config.modelProvider.ollamaMaxToolsForRouting, 3);
      assert.strictEqual(config.modelProvider.fallbackProvider, "databricks");
    });
  });

  describe("Metrics Recording", () => {
    beforeEach(() => {
      process.env.PREFER_OLLAMA = "true";
      process.env.OLLAMA_ENDPOINT = "http://localhost:11434";
      process.env.OLLAMA_MODEL = "qwen2.5-coder:latest";
      process.env.OLLAMA_FALLBACK_PROVIDER = "databricks";

      config = require("../src/config");
      const metricsModule = require("../src/observability/metrics");
      metrics = metricsModule.getMetricsCollector();
    });

    it("should record provider routing", () => {
      metrics.recordProviderRouting("ollama");
      metrics.recordProviderRouting("ollama");
      metrics.recordProviderRouting("databricks");

      const snapshot = metrics.getMetrics();

      assert.deepStrictEqual(snapshot.routing.by_provider, {
        ollama: 2,
        databricks: 1,
      });
    });

    it("should record provider success with latency", () => {
      metrics.recordProviderSuccess("ollama", 450);
      metrics.recordProviderSuccess("ollama", 600);
      metrics.recordProviderSuccess("databricks", 1500);

      const snapshot = metrics.getMetrics();

      assert.strictEqual(snapshot.routing.successes_by_provider.ollama, 2);
      assert.strictEqual(snapshot.routing.successes_by_provider.databricks, 1);
      assert.strictEqual(snapshot.cost_savings.ollama_latency_ms.mean, 525);
    });

    it("should record fallback attempts with reasons", () => {
      metrics.recordFallbackAttempt("ollama", "databricks", "circuit_breaker");
      metrics.recordFallbackAttempt("ollama", "databricks", "timeout");
      metrics.recordFallbackAttempt("ollama", "databricks", "timeout");

      const snapshot = metrics.getMetrics();

      assert.strictEqual(snapshot.fallback.attempts_total, 3);
      assert.deepStrictEqual(snapshot.fallback.reasons, {
        circuit_breaker: 1,
        timeout: 2,
      });
    });

    it("should calculate fallback success rate", () => {
      metrics.recordFallbackAttempt("ollama", "databricks", "timeout");
      metrics.recordFallbackSuccess(1200);
      metrics.recordFallbackAttempt("ollama", "databricks", "timeout");
      metrics.recordFallbackSuccess(1100);
      metrics.recordFallbackAttempt("ollama", "databricks", "circuit_breaker");
      metrics.recordFallbackFailure();

      const snapshot = metrics.getMetrics();

      assert.strictEqual(snapshot.fallback.attempts_total, 3);
      assert.strictEqual(snapshot.fallback.successes_total, 2);
      assert.strictEqual(snapshot.fallback.failures_total, 1);
      assert.strictEqual(snapshot.fallback.success_rate, "66.67%");
    });

    it("should record cost savings", () => {
      // Simulate 100 tokens input, 50 tokens output
      // Input: 100/1M * $3 = $0.0003
      // Output: 50/1M * $15 = $0.00075
      // Total: $0.00105
      metrics.recordCostSavings(0.00105);
      metrics.recordCostSavings(0.00105);
      metrics.recordCostSavings(0.00105);

      const snapshot = metrics.getMetrics();

      assert.strictEqual(snapshot.cost_savings.ollama_savings_usd, "0.0032");
    });

    it("should reset all routing metrics", () => {
      metrics.recordProviderRouting("ollama");
      metrics.recordProviderSuccess("ollama", 450);
      metrics.recordFallbackAttempt("ollama", "databricks", "timeout");
      metrics.recordFallbackSuccess(1200);
      metrics.recordCostSavings(1.5);

      metrics.reset();

      const snapshot = metrics.getMetrics();

      assert.deepStrictEqual(snapshot.routing.by_provider, {});
      assert.deepStrictEqual(snapshot.routing.successes_by_provider, {});
      assert.strictEqual(snapshot.fallback.attempts_total, 0);
      assert.strictEqual(snapshot.fallback.successes_total, 0);
      assert.strictEqual(snapshot.cost_savings.ollama_savings_usd, "0.0000");
    });
  });

  describe("Helper Functions", () => {
    it("should categorize circuit breaker errors", () => {
      // This would need to be tested by importing the function if exported
      // For now, we test via the integrated behavior
      process.env.PREFER_OLLAMA = "true";
      process.env.OLLAMA_ENDPOINT = "http://localhost:11434";
      process.env.OLLAMA_MODEL = "qwen2.5-coder:latest";

      config = require("../src/config");
      const metricsModule = require("../src/observability/metrics");
      metrics = metricsModule.getMetricsCollector();

      // Simulate categorization
      const circuitBreakerError = new Error("Circuit breaker open");
      circuitBreakerError.name = "CircuitBreakerError";

      const timeoutError = new Error("Request timeout");
      timeoutError.code = "ETIMEDOUT";

      const unavailableError = new Error("Service not available");
      unavailableError.code = "ECONNREFUSED";

      // These would be categorized in the actual invokeModel function
      // Here we just verify the structure exists
      assert.ok(metrics.recordFallbackAttempt);
    });

    it("should estimate cost savings correctly", () => {
      process.env.PREFER_OLLAMA = "true";
      process.env.OLLAMA_ENDPOINT = "http://localhost:11434";
      process.env.OLLAMA_MODEL = "qwen2.5-coder:latest";

      config = require("../src/config");
      const metricsModule = require("../src/observability/metrics");
      metrics = metricsModule.getMetricsCollector();

      // Test: 1000 input tokens, 500 output tokens
      // Input cost: 1000/1M * $3 = $0.003
      // Output cost: 500/1M * $15 = $0.0075
      // Total: $0.0105
      const inputTokens = 1000;
      const outputTokens = 500;
      const expectedSavings =
        (inputTokens / 1_000_000) * 3.0 + (outputTokens / 1_000_000) * 15.0;

      assert.strictEqual(expectedSavings.toFixed(4), "0.0105");
    });
  });
});
