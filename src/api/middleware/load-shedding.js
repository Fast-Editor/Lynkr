const logger = require("../../logger");
const { ServiceUnavailableError } = require("./error-handling");

/**
 * Load shedding middleware
 *
 * Features:
 * - Detect system overload (CPU, memory, queue depth)
 * - Reject requests with 503 when overloaded
 * - Protect system from cascading failures
 * - Minimal performance overhead
 */

class LoadShedder {
  constructor(options = {}) {
    // Thresholds
    this.memoryThreshold = options.memoryThreshold || 0.85; // 85%
    this.heapThreshold = options.heapThreshold || 0.95; // 95% (increased from 90% to prevent false positives from temporary allocation spikes)
    this.activeRequestsThreshold = options.activeRequestsThreshold || 1000;

    // State
    this.activeRequests = 0;
    this.totalShed = 0;
    this.lastCheck = Date.now();
    this.checkInterval = options.checkInterval || 1000; // Check every second
    this.cachedOverloadState = false;
  }

  /**
   * Check if system is overloaded
   */
  isOverloaded() {
    const now = Date.now();

    // Use cached state if checked recently (performance optimization)
    if (now - this.lastCheck < this.checkInterval) {
      return this.cachedOverloadState;
    }

    this.lastCheck = now;

    // Check memory usage
    const memUsage = process.memoryUsage();
    const heapUsedPercent = memUsage.heapUsed / memUsage.heapTotal;

    if (heapUsedPercent > this.heapThreshold) {
      logger.warn(
        {
          heapUsedPercent: (heapUsedPercent * 100).toFixed(2),
          threshold: (this.heapThreshold * 100).toFixed(2),
        },
        "Load shedding: Heap usage exceeded threshold"
      );
      this.cachedOverloadState = true;
      return true;
    }

    // Check active requests
    if (this.activeRequests > this.activeRequestsThreshold) {
      logger.warn(
        {
          activeRequests: this.activeRequests,
          threshold: this.activeRequestsThreshold,
        },
        "Load shedding: Active requests exceeded threshold"
      );
      this.cachedOverloadState = true;
      return true;
    }

    this.cachedOverloadState = false;
    return false;
  }

  /**
   * Get current metrics
   */
  getMetrics() {
    const memUsage = process.memoryUsage();
    return {
      activeRequests: this.activeRequests,
      totalShed: this.totalShed,
      heapUsedPercent: ((memUsage.heapUsed / memUsage.heapTotal) * 100).toFixed(2),
      thresholds: {
        heapThreshold: (this.heapThreshold * 100).toFixed(2),
        activeRequestsThreshold: this.activeRequestsThreshold,
      },
    };
  }
}

// Singleton instance
let instance = null;

function getLoadShedder(options) {
  if (!instance) {
    // Read from environment variables if not provided
    const defaultOptions = {
      heapThreshold: Number.parseFloat(process.env.LOAD_SHEDDING_HEAP_THRESHOLD || "0.95"),
      memoryThreshold: Number.parseFloat(process.env.LOAD_SHEDDING_MEMORY_THRESHOLD || "0.85"),
      activeRequestsThreshold: Number.parseInt(
        process.env.LOAD_SHEDDING_ACTIVE_REQUESTS_THRESHOLD || "1000",
        10
      ),
    };
    instance = new LoadShedder({ ...defaultOptions, ...options });
  }
  return instance;
}

/**
 * Initialize load shedder and log configuration
 * Call this at server startup to ensure configuration is logged
 */
function initializeLoadShedder(options) {
  const shedder = getLoadShedder(options);

  // Log configuration
  logger.info({
    enabled: true,
    thresholds: {
      heapThreshold: (shedder.heapThreshold * 100).toFixed(2),
      memoryThreshold: (shedder.memoryThreshold * 100).toFixed(2),
      activeRequestsThreshold: shedder.activeRequestsThreshold,
    }
  }, "Load shedding initialized");

  return shedder;
}

/**
 * Load shedding middleware
 */
function loadSheddingMiddleware(req, res, next) {
  const shedder = getLoadShedder();

  // Check if overloaded
  if (shedder.isOverloaded()) {
    shedder.totalShed++;

    // Return 503 Service Unavailable
    const error = new ServiceUnavailableError(
      "Service temporarily overloaded. Please retry after a few seconds."
    );

    // Add Retry-After header (suggest 5 seconds)
    res.setHeader("Retry-After", "5");

    return next(error);
  }

  // Track active request
  shedder.activeRequests++;

  // Use flag to prevent double-decrement race condition
  let decremented = false;
  const decrementOnce = () => {
    if (!decremented) {
      decremented = true;
      shedder.activeRequests--;
    }
  };

  // Both events might fire, but only decrement once
  res.on("finish", decrementOnce);
  res.on("close", decrementOnce);

  next();
}

module.exports = {
  LoadShedder,
  getLoadShedder,
  initializeLoadShedder,
  loadSheddingMiddleware,
};
