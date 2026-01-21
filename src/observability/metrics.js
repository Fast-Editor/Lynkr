const config = require("../config");
const logger = require("../logger");

/**
 * High-performance metrics collection
 *
 * Optimizations:
 * - In-memory counters (no I/O overhead)
 * - Lazy histogram calculations
 * - Minimal object allocation
 * - Lock-free counters
 */

class MetricsCollector {
  constructor() {
    // Request metrics
    this.requestCount = 0;
    this.requestErrors = 0;
    this.requestLatencies = [];
    this.requestsByStatus = new Map();
    this.requestsByEndpoint = new Map();

    // Token metrics
    this.tokensInput = 0;
    this.tokensOutput = 0;
    this.tokensTotal = 0;

    // Cost metrics
    this.totalCost = 0;

    // Budget metrics
    this.budgetBlocks = 0;
    this.rateLimitBlocks = 0;

    // API metrics
    this.databricksRequests = 0;
    this.databricksErrors = 0;
    this.databricksRetries = 0;

    // System metrics
    this.startTime = Date.now();
    this.lastResetTime = Date.now();

    // Routing metrics
    this.providerRoutingCounts = new Map(); // provider -> count
    this.providerSuccesses = new Map();     // provider -> count
    this.providerFailures = new Map();      // provider -> count
    this.fallbackAttempts = 0;
    this.fallbackSuccesses = 0;
    this.fallbackFailures = 0;
    this.fallbackReasons = new Map();       // reason -> count
    this.ollamaLatencies = [];
    this.fallbackLatencies = [];
    this.estimatedCostSavings = 0;

    // Histogram buckets for latency (in ms)
    this.latencyBuckets = [10, 50, 100, 200, 500, 1000, 2000, 5000, 10000];

    // Performance: Circular buffer for latency (reduced from 10000 to 1000)
    this.maxLatencyBuffer = 1000;
  }

  /**
   * Add value to circular buffer (prevents unbounded growth)
   */
  addToBuffer(buffer, value, maxSize) {
    buffer.push(value);
    if (buffer.length > maxSize) {
      buffer.shift(); // Remove oldest entry
    }
  }

  /**
   * Record HTTP request
   */
  recordRequest(method, path, status, durationMs) {
    this.requestCount++;

    if (status >= 400) {
      this.requestErrors++;
    }

    // Track by status code
    const statusCount = this.requestsByStatus.get(status) || 0;
    this.requestsByStatus.set(status, statusCount + 1);

    // Track by endpoint
    const endpoint = `${method} ${path}`;
    const endpointCount = this.requestsByEndpoint.get(endpoint) || 0;
    this.requestsByEndpoint.set(endpoint, endpointCount + 1);

    // Record latency with circular buffer
    this.addToBuffer(this.requestLatencies, durationMs, this.maxLatencyBuffer);
  }

  /**
   * Record token usage
   */
  recordTokens(input, output) {
    this.tokensInput += input || 0;
    this.tokensOutput += output || 0;
    this.tokensTotal += (input || 0) + (output || 0);
  }

  /**
   * Record cost
   */
  recordCost(costUsd) {
    this.totalCost += costUsd || 0;
  }

  /**
   * Record budget block
   */
  recordBudgetBlock() {
    this.budgetBlocks++;
  }

  /**
   * Record rate limit block
   */
  recordRateLimitBlock() {
    this.rateLimitBlocks++;
  }

  /**
   * Record Databricks API call
   */
  recordDatabricksRequest(success, retries = 0) {
    this.databricksRequests++;
    if (!success) {
      this.databricksErrors++;
    }
    this.databricksRetries += retries;
  }

  /**
   * Record provider routing decision
   */
  recordProviderRouting(provider) {
    const count = this.providerRoutingCounts.get(provider) || 0;
    this.providerRoutingCounts.set(provider, count + 1);
  }

  /**
   * Record provider success
   */
  recordProviderSuccess(provider, latencyMs) {
    const count = this.providerSuccesses.get(provider) || 0;
    this.providerSuccesses.set(provider, count + 1);

    if (provider === "ollama") {
      this.addToBuffer(this.ollamaLatencies, latencyMs, this.maxLatencyBuffer);
    }
  }

  /**
   * Record provider failure
   */
  recordProviderFailure(provider) {
    const count = this.providerFailures.get(provider) || 0;
    this.providerFailures.set(provider, count + 1);
  }

  /**
   * Record fallback attempt
   */
  recordFallbackAttempt(fromProvider, toProvider, reason) {
    this.fallbackAttempts++;
    const count = this.fallbackReasons.get(reason) || 0;
    this.fallbackReasons.set(reason, count + 1);
  }

  /**
   * Record fallback success
   */
  recordFallbackSuccess(latencyMs) {
    this.fallbackSuccesses++;
    this.addToBuffer(this.fallbackLatencies, latencyMs, this.maxLatencyBuffer);
  }

  /**
   * Record fallback failure
   */
  recordFallbackFailure() {
    this.fallbackFailures++;
  }

  /**
   * Record cost savings from using Ollama
   */
  recordCostSavings(savingsUsd) {
    this.estimatedCostSavings += savingsUsd;
  }

  /**
   * Get current metrics snapshot
   */
  getMetrics() {
    const now = Date.now();
    const uptime = now - this.startTime;
    const periodSeconds = (now - this.lastResetTime) / 1000;

    // Calculate latency stats
    const latencyStats = this.calculateLatencyStats();

    return {
      // Counters
      requests_total: this.requestCount,
      requests_errors_total: this.requestErrors,
      requests_per_second: periodSeconds > 0 ? this.requestCount / periodSeconds : 0,

      // Latency
      latency_ms: latencyStats,

      // Tokens
      tokens_input_total: this.tokensInput,
      tokens_output_total: this.tokensOutput,
      tokens_total: this.tokensTotal,

      // Cost
      cost_usd_total: this.totalCost,

      // Budget
      budget_blocks_total: this.budgetBlocks,
      rate_limit_blocks_total: this.rateLimitBlocks,

      // API
      databricks_requests_total: this.databricksRequests,
      databricks_errors_total: this.databricksErrors,
      databricks_retries_total: this.databricksRetries,

      // Status codes
      status_codes: Object.fromEntries(this.requestsByStatus),

      // Endpoints
      endpoints: Object.fromEntries(this.requestsByEndpoint),

      // System
      uptime_seconds: Math.floor(uptime / 1000),
      memory_usage: process.memoryUsage(),
      cpu_usage: process.cpuUsage(),

      // Routing
      routing: {
        by_provider: Object.fromEntries(this.providerRoutingCounts),
        successes_by_provider: Object.fromEntries(this.providerSuccesses),
        failures_by_provider: Object.fromEntries(this.providerFailures),
      },

      // Fallback
      fallback: {
        attempts_total: this.fallbackAttempts,
        successes_total: this.fallbackSuccesses,
        failures_total: this.fallbackFailures,
        success_rate: this.fallbackAttempts > 0
          ? ((this.fallbackSuccesses / this.fallbackAttempts * 100).toFixed(2) + '%')
          : 'N/A',
        reasons: Object.fromEntries(this.fallbackReasons),
        latency_ms: this.calculateLatencyStats(this.fallbackLatencies),
      },

      // Cost savings
      cost_savings: {
        ollama_savings_usd: this.estimatedCostSavings.toFixed(4),
        ollama_latency_ms: this.calculateLatencyStats(this.ollamaLatencies),
      },
    };
  }

  /**
   * Calculate latency statistics (lazy)
   */
  calculateLatencyStats(latencies = null) {
    const data = latencies || this.requestLatencies;

    if (data.length === 0) {
      return {
        min: 0,
        max: 0,
        mean: 0,
        median: 0,
        p95: 0,
        p99: 0,
      };
    }

    const sorted = [...data].sort((a, b) => a - b);
    const count = sorted.length;

    return {
      min: sorted[0],
      max: sorted[count - 1],
      mean: sorted.reduce((a, b) => a + b, 0) / count,
      median: sorted[Math.floor(count / 2)],
      p95: sorted[Math.floor(count * 0.95)],
      p99: sorted[Math.floor(count * 0.99)],
    };
  }

  /**
   * Export Prometheus format
   */
  toPrometheus() {
    const metrics = this.getMetrics();
    const lines = [];

    // Helper to format metric
    const metric = (name, type, help, value, labels = {}) => {
      const labelStr = Object.entries(labels)
        .map(([k, v]) => `${k}="${v}"`)
        .join(",");

      lines.push(`# HELP ${name} ${help}`);
      lines.push(`# TYPE ${name} ${type}`);
      lines.push(`${name}${labelStr ? `{${labelStr}}` : ""} ${value}`);
    };

    // Counters
    metric("http_requests_total", "counter", "Total HTTP requests", metrics.requests_total);
    metric("http_requests_errors_total", "counter", "Total HTTP errors", metrics.requests_errors_total);
    metric("tokens_input_total", "counter", "Total input tokens", metrics.tokens_input_total);
    metric("tokens_output_total", "counter", "Total output tokens", metrics.tokens_output_total);
    metric("tokens_total", "counter", "Total tokens", metrics.tokens_total);
    metric("cost_usd_total", "counter", "Total cost in USD", metrics.cost_usd_total);
    metric("budget_blocks_total", "counter", "Total budget blocks", metrics.budget_blocks_total);
    metric("rate_limit_blocks_total", "counter", "Total rate limit blocks", metrics.rate_limit_blocks_total);

    // Gauges
    metric("http_requests_per_second", "gauge", "Requests per second", metrics.requests_per_second);
    metric("uptime_seconds", "gauge", "Uptime in seconds", metrics.uptime_seconds);

    // Latency histogram
    metric("http_request_duration_ms", "summary", "HTTP request latency in ms", metrics.latency_ms.mean, { quantile: "0.5" });
    metric("http_request_duration_ms", "summary", "HTTP request latency in ms", metrics.latency_ms.p95, { quantile: "0.95" });
    metric("http_request_duration_ms", "summary", "HTTP request latency in ms", metrics.latency_ms.p99, { quantile: "0.99" });

    return lines.join("\n");
  }

  /**
   * Reset counters (for testing)
   */
  reset() {
    this.requestCount = 0;
    this.requestErrors = 0;
    this.requestLatencies = [];
    this.requestsByStatus.clear();
    this.requestsByEndpoint.clear();
    this.tokensInput = 0;
    this.tokensOutput = 0;
    this.tokensTotal = 0;
    this.totalCost = 0;
    this.budgetBlocks = 0;
    this.rateLimitBlocks = 0;
    this.databricksRequests = 0;
    this.databricksErrors = 0;
    this.databricksRetries = 0;
    this.providerRoutingCounts.clear();
    this.providerSuccesses.clear();
    this.providerFailures.clear();
    this.fallbackAttempts = 0;
    this.fallbackSuccesses = 0;
    this.fallbackFailures = 0;
    this.fallbackReasons.clear();
    this.ollamaLatencies = [];
    this.fallbackLatencies = [];
    this.estimatedCostSavings = 0;
    this.lastResetTime = Date.now();
  }
}

// Singleton instance
let instance = null;

function getMetricsCollector() {
  if (!instance) {
    instance = new MetricsCollector();
  }
  return instance;
}

module.exports = {
  MetricsCollector,
  getMetricsCollector,
};
