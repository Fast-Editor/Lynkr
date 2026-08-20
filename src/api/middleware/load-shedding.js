const os = require("os");
const v8 = require("v8");
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
    // Absolute free-heap floor. Percent-of-heapTotal is unreliable in both
    // directions: heapTotal is V8's CURRENTLY allocated heap (grows on
    // demand toward the real limit), and at the limit "99%" leaves ~40MB on
    // a 4GB heap — nowhere near enough to parse one multi-MB request body.
    // 2026-08-19 OOM: a 5MB compact request passed the percent check and
    // died allocating during JSON.parse. Shed while there is still room to
    // finish in-flight work.
    this.headroomMB = options.headroomMB || 512;
    this.heapLimitMB = v8.getHeapStatistics().heap_size_limit / (1024 * 1024);

    // Watchdog: how long the heap may stay below the headroom floor with
    // zero active requests before the process self-restarts. Retained
    // memory GC can't reclaim never recovers on its own — without this the
    // server sheds 100% of traffic until someone restarts it by hand.
    this.wedgedRestartMs = options.wedgedRestartMs || 60000;
    this.selfRestart = options.selfRestart !== false;
    this.wedgedSince = null;

    // State
    this.activeRequests = 0;
    this.totalShed = 0;
    // 0, not Date.now(): the first isOverloaded() call must actually
    // evaluate instead of returning the constructor's cached "false"
    // for the first checkInterval window.
    this.lastCheck = 0;
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

    // Absolute headroom against the true V8 limit — the primary guard.
    const heapStats = v8.getHeapStatistics();
    const freeMB = (heapStats.heap_size_limit - heapStats.used_heap_size) / (1024 * 1024);
    if (freeMB < this.headroomMB) {
      logger.warn(
        {
          freeMB: freeMB.toFixed(0),
          headroomMB: this.headroomMB,
          heapLimitMB: this.heapLimitMB.toFixed(0),
          usedMB: (heapStats.used_heap_size / (1024 * 1024)).toFixed(0),
        },
        "Load shedding: heap headroom below floor"
      );
      this._trackWedged(now);
      this.cachedOverloadState = true;
      return true;
    }
    this.wedgedSince = null;

    // NOTE: the old heapUsed/heapTotal percent check is gone. heapTotal is
    // V8's *currently allocated* heap, which it keeps close to usage, so the
    // ratio reads ~99% during perfectly normal operation — it shed all
    // traffic at 755MB used with gigabytes of real headroom remaining
    // (2026-08-20 false-positive incident). The absolute-headroom check
    // against heap_size_limit above is the correct form of this guard.

    // Check RSS / system memory
    const rssPercent = memUsage.rss / os.totalmem();
    if (rssPercent > this.memoryThreshold) {
      logger.warn(
        {
          rssPercent: (rssPercent * 100).toFixed(2),
          threshold: (this.memoryThreshold * 100).toFixed(2),
        },
        "Load shedding: RSS memory usage exceeded threshold"
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
   * Track how long the heap has been wedged below the headroom floor.
   * If it persists past wedgedRestartMs with no in-flight requests, the
   * memory is retained (not transient) and GC cannot recover it — exit so
   * the supervisor restarts a clean process instead of shedding forever.
   */
  _trackWedged(now) {
    if (!this.selfRestart) return;
    if (this.wedgedSince === null) {
      this.wedgedSince = now;
      return;
    }
    if (now - this.wedgedSince >= this.wedgedRestartMs && this.activeRequests === 0) {
      logger.fatal(
        {
          wedgedForMs: now - this.wedgedSince,
          totalShed: this.totalShed,
          heapLimitMB: this.heapLimitMB.toFixed(0),
        },
        "Load shedding: heap wedged below headroom floor with no active requests — exiting for supervisor restart"
      );
      // Give the fatal log a moment to flush, then exit non-zero.
      setTimeout(() => process.exit(1), 250).unref();
    }
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
      heapUsedMB: (memUsage.heapUsed / (1024 * 1024)).toFixed(2),
      heapTotalMB: (memUsage.heapTotal / (1024 * 1024)).toFixed(2),
      rssMB: (memUsage.rss / (1024 * 1024)).toFixed(2),
      rssPercent: ((memUsage.rss / os.totalmem()) * 100).toFixed(2),
      heapLimitMB: this.heapLimitMB.toFixed(2),
      freeHeadroomMB: ((v8.getHeapStatistics().heap_size_limit - v8.getHeapStatistics().used_heap_size) / (1024 * 1024)).toFixed(2),
      thresholds: {
        heapThreshold: (this.heapThreshold * 100).toFixed(2),
        memoryThreshold: (this.memoryThreshold * 100).toFixed(2),
        activeRequestsThreshold: this.activeRequestsThreshold,
        headroomMB: this.headroomMB,
        wedgedRestartMs: this.wedgedRestartMs,
        selfRestart: this.selfRestart,
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
      // Not env-configurable by design: these are crash-prevention floors,
      // and there is no deployment where turning them off is correct.
      headroomMB: 512,
      wedgedRestartMs: 60000,
      selfRestart: true,
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
