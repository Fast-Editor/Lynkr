/**
 * Provider Health Tracking
 *
 * Tracks real-time health metrics per provider for intelligent routing decisions:
 * - Latency percentiles (p50, p95, p99)
 * - Success/failure rates
 * - In-flight request counting
 * - Circuit breaker state integration
 *
 * @module observability/health-tracker
 */

const logger = require("../logger");

/**
 * Sliding window statistics for latency and rate tracking
 */
class SlidingWindowStats {
  constructor(windowMs = 300000) { // 5 minutes default
    this.windowMs = windowMs;
    this.samples = [];
  }

  /**
   * Record a sample value
   */
  record(value, timestamp = Date.now()) {
    this.samples.push({ value, timestamp });
    this.prune();
  }

  /**
   * Remove samples outside the window
   */
  prune() {
    const cutoff = Date.now() - this.windowMs;
    this.samples = this.samples.filter(s => s.timestamp > cutoff);
  }

  /**
   * Get count of samples in window
   */
  count() {
    this.prune();
    return this.samples.length;
  }

  /**
   * Calculate percentile
   */
  percentile(p) {
    this.prune();
    if (this.samples.length === 0) return 0;

    const sorted = [...this.samples]
      .map(s => s.value)
      .sort((a, b) => a - b);

    const idx = Math.ceil((p / 100) * sorted.length) - 1;
    return sorted[Math.max(0, idx)];
  }

  /**
   * Calculate mean
   */
  mean() {
    this.prune();
    if (this.samples.length === 0) return 0;

    const sum = this.samples.reduce((acc, s) => acc + s.value, 0);
    return sum / this.samples.length;
  }

  /**
   * Get all values in window
   */
  values() {
    this.prune();
    return this.samples.map(s => s.value);
  }
}

/**
 * Health metrics for a single provider
 */
class ProviderHealth {
  constructor(name, windowMs = 300000) {
    this.name = name;
    this.windowMs = windowMs;

    // Latency tracking
    this.latencyStats = new SlidingWindowStats(windowMs);

    // Success/failure tracking
    this.successCount = 0;
    this.failureCount = 0;
    this.recentResults = []; // {success: boolean, timestamp: number}

    // In-flight tracking
    this.inFlight = 0;

    // Recent errors
    this.recentErrors = [];
    this.maxRecentErrors = 10;

    // Timestamps
    this.lastSuccess = null;
    this.lastFailure = null;
    this.lastRequest = null;
  }

  /**
   * Record start of a request
   */
  recordRequestStart() {
    this.inFlight++;
    this.lastRequest = Date.now();
  }

  /**
   * Record successful completion
   */
  recordSuccess(latencyMs) {
    this.inFlight = Math.max(0, this.inFlight - 1);
    this.successCount++;
    this.lastSuccess = Date.now();

    this.latencyStats.record(latencyMs);
    this.recentResults.push({ success: true, timestamp: Date.now() });
    this._pruneResults();
  }

  /**
   * Record failure
   */
  recordFailure(error, statusCode = null) {
    this.inFlight = Math.max(0, this.inFlight - 1);
    this.failureCount++;
    this.lastFailure = Date.now();

    this.recentResults.push({ success: false, timestamp: Date.now() });
    this._pruneResults();

    // Track recent errors
    this.recentErrors.unshift({
      code: statusCode,
      message: error?.message || String(error),
      timestamp: new Date().toISOString(),
    });

    if (this.recentErrors.length > this.maxRecentErrors) {
      this.recentErrors = this.recentErrors.slice(0, this.maxRecentErrors);
    }
  }

  /**
   * Prune old results outside window
   */
  _pruneResults() {
    const cutoff = Date.now() - this.windowMs;
    this.recentResults = this.recentResults.filter(r => r.timestamp > cutoff);
  }

  /**
   * Calculate success rate in window
   */
  getSuccessRate() {
    this._pruneResults();
    if (this.recentResults.length === 0) return 1.0; // No data = healthy

    const successes = this.recentResults.filter(r => r.success).length;
    return successes / this.recentResults.length;
  }

  /**
   * Get health metrics summary
   */
  getMetrics() {
    const successRate = this.getSuccessRate();

    return {
      name: this.name,
      latency: {
        p50: Math.round(this.latencyStats.percentile(50)),
        p95: Math.round(this.latencyStats.percentile(95)),
        p99: Math.round(this.latencyStats.percentile(99)),
        mean: Math.round(this.latencyStats.mean()),
        samples: this.latencyStats.count(),
      },
      requests: {
        total: this.successCount + this.failureCount,
        success: this.successCount,
        failed: this.failureCount,
        success_rate: Math.round(successRate * 1000) / 1000, // 3 decimal places
        in_window: this.recentResults.length,
      },
      current: {
        in_flight: this.inFlight,
        last_success: this.lastSuccess ? new Date(this.lastSuccess).toISOString() : null,
        last_failure: this.lastFailure ? new Date(this.lastFailure).toISOString() : null,
        last_request: this.lastRequest ? new Date(this.lastRequest).toISOString() : null,
      },
      recent_errors: this.recentErrors,
    };
  }
}

/**
 * Provider Health Tracker - tracks health for all providers
 */
class ProviderHealthTracker {
  constructor(options = {}) {
    this.windowMs = options.windowMs || 300000; // 5 minutes
    this.providers = new Map();

    // Health thresholds
    this.thresholds = {
      unhealthy: {
        successRate: 0.5,      // < 50% success = unhealthy
        circuitOpen: true,     // Circuit open = unhealthy
      },
      degraded: {
        successRate: 0.9,      // < 90% success = degraded
        latencyP95: 5000,      // > 5s p95 latency = degraded
      },
    };
  }

  /**
   * Get or create provider health tracker
   */
  _getProvider(name) {
    if (!this.providers.has(name)) {
      this.providers.set(name, new ProviderHealth(name, this.windowMs));
    }
    return this.providers.get(name);
  }

  /**
   * Record start of a request
   */
  recordRequestStart(providerName) {
    const provider = this._getProvider(providerName);
    provider.recordRequestStart();
  }

  /**
   * Record successful request completion
   */
  recordSuccess(providerName, latencyMs) {
    const provider = this._getProvider(providerName);
    provider.recordSuccess(latencyMs);

    logger.debug({
      provider: providerName,
      latencyMs,
      inFlight: provider.inFlight,
    }, "Provider health: success recorded");
  }

  /**
   * Record failed request
   */
  recordFailure(providerName, error, statusCode = null) {
    const provider = this._getProvider(providerName);
    provider.recordFailure(error, statusCode);

    logger.debug({
      provider: providerName,
      error: error?.message || String(error),
      statusCode,
      inFlight: provider.inFlight,
    }, "Provider health: failure recorded");
  }

  /**
   * Calculate health status for a provider
   */
  getStatus(providerName, circuitState = null) {
    const provider = this._getProvider(providerName);
    const metrics = provider.getMetrics();
    const successRate = metrics.requests.success_rate;
    const latencyP95 = metrics.latency.p95;

    // Unhealthy conditions
    if (circuitState === "OPEN" || successRate < this.thresholds.unhealthy.successRate) {
      return "unhealthy";
    }

    // Degraded conditions
    if (successRate < this.thresholds.degraded.successRate ||
        latencyP95 > this.thresholds.degraded.latencyP95) {
      return "degraded";
    }

    return "healthy";
  }

  /**
   * Get latency stats for a provider
   */
  getLatency(providerName) {
    const provider = this._getProvider(providerName);
    return provider.getMetrics().latency;
  }

  /**
   * Get in-flight count for a provider
   */
  getInFlight(providerName) {
    const provider = this._getProvider(providerName);
    return provider.inFlight;
  }

  /**
   * Get success rate for a provider
   */
  getSuccessRate(providerName) {
    const provider = this._getProvider(providerName);
    return provider.getSuccessRate();
  }

  /**
   * Get all providers health summary
   */
  getAllHealth(circuitBreakerStates = {}) {
    const health = [];

    for (const [name, provider] of this.providers) {
      const circuitState = circuitBreakerStates[name] || "CLOSED";
      const metrics = provider.getMetrics();
      const status = this.getStatus(name, circuitState);

      health.push({
        name,
        status,
        latency_p95_ms: metrics.latency.p95,
        success_rate: metrics.requests.success_rate,
        in_flight: metrics.current.in_flight,
        circuit_state: circuitState,
        total_requests: metrics.requests.total,
        last_success: metrics.current.last_success,
        last_failure: metrics.current.last_failure,
      });
    }

    // Sort by status (unhealthy last) then by success rate
    return health.sort((a, b) => {
      const statusOrder = { healthy: 0, degraded: 1, unhealthy: 2 };
      const statusDiff = statusOrder[a.status] - statusOrder[b.status];
      if (statusDiff !== 0) return statusDiff;
      return b.success_rate - a.success_rate;
    });
  }

  /**
   * Get detailed metrics for a specific provider
   */
  getProviderMetrics(providerName) {
    const provider = this._getProvider(providerName);
    return provider.getMetrics();
  }

  /**
   * Select best provider based on health (for routing)
   */
  selectBestProvider(providerNames, circuitBreakerStates = {}, strategy = "latency") {
    const healthyProviders = providerNames.filter(name => {
      const circuitState = circuitBreakerStates[name] || "CLOSED";
      const status = this.getStatus(name, circuitState);
      return status !== "unhealthy";
    });

    if (healthyProviders.length === 0) {
      // All unhealthy, return first as fallback
      return providerNames[0];
    }

    if (strategy === "latency") {
      // Sort by p95 latency, return fastest
      return healthyProviders.sort((a, b) => {
        return this.getLatency(a).p95 - this.getLatency(b).p95;
      })[0];
    }

    if (strategy === "least-busy") {
      // Sort by in-flight count, return least busy
      return healthyProviders.sort((a, b) => {
        return this.getInFlight(a) - this.getInFlight(b);
      })[0];
    }

    if (strategy === "success-rate") {
      // Sort by success rate, return highest
      return healthyProviders.sort((a, b) => {
        return this.getSuccessRate(b) - this.getSuccessRate(a);
      })[0];
    }

    // Default: return first healthy
    return healthyProviders[0];
  }
}

// Singleton instance
let trackerInstance = null;

/**
 * Get or create the health tracker singleton
 */
function getHealthTracker() {
  if (!trackerInstance) {
    trackerInstance = new ProviderHealthTracker();
  }
  return trackerInstance;
}

module.exports = {
  SlidingWindowStats,
  ProviderHealth,
  ProviderHealthTracker,
  getHealthTracker,
};
