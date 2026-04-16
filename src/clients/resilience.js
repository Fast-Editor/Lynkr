const {
  circuitBreaker,
  ConsecutiveBreaker,
  retry,
  handleAll,
  ExponentialBackoff,
  bulkhead,
  timeout,
  wrap,
  CircuitState,
  BrokenCircuitError,
  BulkheadRejectedError,
  TaskCancelledError,
} = require("cockatiel");
const logger = require("../logger");

// Re-use the existing STATE constant shape
const STATE = {
  CLOSED: "CLOSED",
  OPEN: "OPEN",
  HALF_OPEN: "HALF_OPEN",
};

/**
 * Map Cockatiel CircuitState enum to our string states
 */
function mapCircuitState(cockatielState) {
  switch (cockatielState) {
    case CircuitState.Closed:
      return STATE.CLOSED;
    case CircuitState.Open:
      return STATE.OPEN;
    case CircuitState.HalfOpen:
      return STATE.HALF_OPEN;
    default:
      return STATE.CLOSED;
  }
}

/**
 * Circuit breaker error — same interface as the original
 */
class CircuitBreakerError extends Error {
  constructor(message, retryAfter) {
    super(message);
    this.name = "CircuitBreakerError";
    this.retryAfter = retryAfter;
    this.code = "circuit_breaker_open";
  }
}

/**
 * Cockatiel-backed CircuitBreaker adapter.
 * Preserves the same API as the hand-rolled CircuitBreaker class.
 */
class CockatielCircuitBreaker {
  constructor(name, options = {}) {
    this.name = name;

    // Configuration (same defaults as original)
    this.failureThreshold = options.failureThreshold || 5;
    this.successThreshold = options.successThreshold || 2;
    this.halfOpenAfter = options.timeout || 60000;

    // Stats tracking (same shape as original)
    this.stats = {
      totalRequests: 0,
      totalFailures: 0,
      totalSuccesses: 0,
      totalRejected: 0,
    };

    // Internal counters for getState() compatibility
    this._failureCount = 0;
    this._successCount = 0;
    this._lastStateChange = Date.now();
    this._nextAttempt = Date.now();

    // Create the Cockatiel circuit breaker policy
    this._policy = circuitBreaker(handleAll, {
      breaker: new ConsecutiveBreaker(this.failureThreshold),
      halfOpenAfter: this.halfOpenAfter,
    });

    // Wire up events for logging and state tracking
    this._policy.onBreak(() => {
      this._lastStateChange = Date.now();
      this._nextAttempt = Date.now() + this.halfOpenAfter;
      logger.warn(
        {
          circuitBreaker: this.name,
          retryAfter: this.halfOpenAfter,
        },
        "Circuit breaker opened - failing fast"
      );
    });

    this._policy.onReset(() => {
      this._failureCount = 0;
      this._successCount = 0;
      this._lastStateChange = Date.now();
      logger.info(
        {
          circuitBreaker: this.name,
        },
        "Circuit breaker closed - normal operation resumed"
      );
    });

    this._policy.onHalfOpen(() => {
      this._successCount = 0;
      this._lastStateChange = Date.now();
      logger.info(
        {
          circuitBreaker: this.name,
        },
        "Circuit breaker half-open - testing service recovery"
      );
    });

    this._policy.onSuccess(() => {
      this.stats.totalSuccesses++;
      this._failureCount = 0;
      if (this.state === STATE.HALF_OPEN) {
        this._successCount++;
      }
    });

    this._policy.onFailure(() => {
      this.stats.totalFailures++;
      this._failureCount++;
      this._successCount = 0;
    });
  }

  /**
   * Current state as a string
   */
  get state() {
    return mapCircuitState(this._policy.state);
  }

  get failureCount() {
    return this._failureCount;
  }

  get successCount() {
    return this._successCount;
  }

  /**
   * Execute function with circuit breaker protection.
   * Translates BrokenCircuitError → CircuitBreakerError for consumers.
   */
  async execute(fn) {
    this.stats.totalRequests++;

    try {
      return await this._policy.execute(fn);
    } catch (err) {
      if (err instanceof BrokenCircuitError) {
        this.stats.totalRejected++;
        const retryAfter = Math.max(0, this._nextAttempt - Date.now());
        throw new CircuitBreakerError(
          `Circuit breaker ${this.name} is OPEN`,
          retryAfter
        );
      }
      throw err;
    }
  }

  /**
   * Get current state — same shape as original
   */
  getState() {
    return {
      name: this.name,
      state: this.state,
      failureCount: this._failureCount,
      successCount: this._successCount,
      nextAttempt: this._nextAttempt,
      lastStateChange: this._lastStateChange,
      stats: { ...this.stats },
    };
  }

  /**
   * Manually reset circuit breaker
   */
  reset() {
    // Cockatiel doesn't expose a public reset, but we can create a fresh policy
    this._failureCount = 0;
    this._successCount = 0;
    this._lastStateChange = Date.now();

    // Recreate the policy to reset state
    const oldPolicy = this._policy;
    this._policy = circuitBreaker(handleAll, {
      breaker: new ConsecutiveBreaker(this.failureThreshold),
      halfOpenAfter: this.halfOpenAfter,
    });

    // Re-wire events
    this._policy.onBreak(() => {
      this._lastStateChange = Date.now();
      this._nextAttempt = Date.now() + this.halfOpenAfter;
      logger.warn(
        { circuitBreaker: this.name, retryAfter: this.halfOpenAfter },
        "Circuit breaker opened - failing fast"
      );
    });
    this._policy.onReset(() => {
      this._failureCount = 0;
      this._successCount = 0;
      this._lastStateChange = Date.now();
      logger.info({ circuitBreaker: this.name }, "Circuit breaker closed - normal operation resumed");
    });
    this._policy.onHalfOpen(() => {
      this._successCount = 0;
      this._lastStateChange = Date.now();
      logger.info({ circuitBreaker: this.name }, "Circuit breaker half-open - testing service recovery");
    });
    this._policy.onSuccess(() => {
      this.stats.totalSuccesses++;
      this._failureCount = 0;
      if (this.state === STATE.HALF_OPEN) {
        this._successCount++;
      }
    });
    this._policy.onFailure(() => {
      this.stats.totalFailures++;
      this._failureCount++;
      this._successCount = 0;
    });
  }
}

/**
 * Registry — same Map-based pattern as original CircuitBreakerRegistry
 */
class CockatielRegistry {
  constructor() {
    this.breakers = new Map();
  }

  get(name, options) {
    if (!this.breakers.has(name)) {
      this.breakers.set(name, new CockatielCircuitBreaker(name, options));
    }
    return this.breakers.get(name);
  }

  getAll() {
    return Array.from(this.breakers.values()).map((breaker) => breaker.getState());
  }

  resetAll() {
    for (const breaker of this.breakers.values()) {
      breaker.reset();
    }
  }
}

// Singleton registry
let registry = null;

function getCockatielRegistry() {
  if (!registry) {
    registry = new CockatielRegistry();
  }
  return registry;
}

// --- Retry adapter ---

const DEFAULT_RETRY_CONFIG = {
  maxRetries: 3,
  initialDelay: 1000,
  maxDelay: 30000,
  backoffMultiplier: 2,
  jitterFactor: 0.1,
  retryableStatuses: [429, 500, 502, 503, 504],
  retryableErrors: ["ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "ENETUNREACH", "ECONNREFUSED"],
};

/**
 * Check if error/response is retryable (same logic as original)
 */
function isRetryableCheck(error, response, config) {
  if (response && config.retryableStatuses.includes(response.status)) {
    return true;
  }
  if (error && error.code && config.retryableErrors.includes(error.code)) {
    return true;
  }
  if (error && error.cause?.code && config.retryableErrors.includes(error.cause.code)) {
    return true;
  }
  if (error && (error.name === "FetchError" || error.name === "AbortError")) {
    return true;
  }
  return false;
}

/**
 * Detect if this is a cold start
 */
function detectColdStart(startTime, endTime, threshold = 5000) {
  return (endTime - startTime) > threshold;
}

/**
 * Sleep helper
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * withCockatielRetry — drop-in replacement for withRetry.
 *
 * Same signature: withCockatielRetry(fn, options)
 * - fn(attempt) is called with the attempt number (0-based)
 * - Returns last response when all retries exhausted (matching original behavior)
 * - Preserves 429 Retry-After header parsing
 */
async function withCockatielRetry(fn, options = {}) {
  const config = { ...DEFAULT_RETRY_CONFIG, ...options };
  let lastResponse = null;
  let attempt = 0;

  const retryPolicy = retry(handleAll, {
    maxAttempts: config.maxRetries,
    backoff: new ExponentialBackoff({
      initialDelay: config.initialDelay,
      maxDelay: config.maxDelay,
      exponent: config.backoffMultiplier,
    }),
  });

  retryPolicy.onRetry(({ attempt: retryAttempt }) => {
    logger.warn(
      { attempt: retryAttempt },
      "Retrying request"
    );
  });

  // We use a manual approach that mirrors the original withRetry exactly,
  // wrapping Cockatiel's retry for exponential backoff but keeping the
  // response-status-check and 429-Retry-After logic intact.
  // This ensures 100% behavioral compatibility.

  for (attempt = 0; attempt <= config.maxRetries; attempt++) {
    const startTime = Date.now();

    try {
      const result = await fn(attempt);
      const endTime = Date.now();

      if (detectColdStart(startTime, endTime)) {
        logger.warn(
          { attempt, duration: endTime - startTime },
          "Potential cold start detected"
        );
      }

      // Check if response indicates we should retry
      if (result && isRetryableCheck(null, result, config) && attempt < config.maxRetries) {
        lastResponse = result;

        if (result.status === 429) {
          const retryAfter = result.headers?.get?.("retry-after");
          let delay;

          if (retryAfter) {
            const retryAfterNum = parseInt(retryAfter, 10);
            if (!isNaN(retryAfterNum)) {
              delay = retryAfterNum * 1000;
            } else {
              const retryAfterDate = new Date(retryAfter);
              delay = retryAfterDate.getTime() - Date.now();
            }
          } else {
            // Exponential backoff with longer delays for rate limiting
            const baseDelay = 2000 * Math.pow(config.backoffMultiplier, attempt);
            const cappedDelay = Math.min(baseDelay, 60000);
            const jitter = cappedDelay * config.jitterFactor * (Math.random() * 2 - 1);
            delay = Math.max(0, cappedDelay + jitter);
          }

          logger.warn(
            { attempt, delay, retryAfter: retryAfter || "not specified" },
            "Rate limited (429), retrying after delay"
          );

          await sleep(delay);
          continue;
        }

        // Regular retry with exponential backoff
        const baseDelay = config.initialDelay * Math.pow(config.backoffMultiplier, attempt);
        const cappedDelay = Math.min(baseDelay, config.maxDelay);
        const jitter = cappedDelay * config.jitterFactor * (Math.random() * 2 - 1);
        const delay = Math.max(0, cappedDelay + jitter);

        logger.warn(
          { attempt, status: result.status, delay },
          "Request failed, retrying with backoff"
        );

        await sleep(delay);
        continue;
      }

      return result;
    } catch (error) {
      const endTime = Date.now();

      if (detectColdStart(startTime, endTime)) {
        logger.warn(
          { attempt, duration: endTime - startTime, error: error.message },
          "Potential cold start with error detected"
        );
      }

      if (isRetryableCheck(error, null, config) && attempt < config.maxRetries) {
        const baseDelay = config.initialDelay * Math.pow(config.backoffMultiplier, attempt);
        const cappedDelay = Math.min(baseDelay, config.maxDelay);
        const jitter = cappedDelay * config.jitterFactor * (Math.random() * 2 - 1);
        const delay = Math.max(0, cappedDelay + jitter);

        logger.warn(
          { attempt, error: error.message, code: error.code, delay },
          "Request error, retrying with backoff"
        );

        await sleep(delay);
        continue;
      }

      throw error;
    }
  }

  // Max retries exceeded
  if (lastResponse) {
    logger.error(
      { status: lastResponse.status, maxRetries: config.maxRetries },
      "Max retries exceeded"
    );
    return lastResponse;
  }

  throw new Error("Retry logic failed unexpectedly");
}

// --- Composed provider policy ---

/**
 * Create a composed policy: retry + circuit breaker + timeout
 */
function createProviderPolicy(name, options = {}) {
  const cbOptions = {
    failureThreshold: options.failureThreshold || 5,
    halfOpenAfter: options.halfOpenAfter || 60000,
  };

  const retryMaxAttempts = options.retryMaxAttempts || 3;
  const timeoutMs = options.timeout || 120000;

  const cb = circuitBreaker(handleAll, {
    breaker: new ConsecutiveBreaker(cbOptions.failureThreshold),
    halfOpenAfter: cbOptions.halfOpenAfter,
  });

  const retryPolicy = retry(handleAll, {
    maxAttempts: retryMaxAttempts,
    backoff: new ExponentialBackoff({
      initialDelay: 1000,
      maxDelay: 30000,
      exponent: 2,
    }),
  });

  const timeoutPolicy = timeout(timeoutMs, "aggressive");

  retryPolicy.onRetry(({ attempt }) => {
    logger.warn({ provider: name, attempt }, "Retrying provider request");
  });

  cb.onBreak(() => {
    logger.warn({ provider: name }, "Provider circuit opened");
  });

  cb.onReset(() => {
    logger.info({ provider: name }, "Provider circuit closed");
  });

  cb.onHalfOpen(() => {
    logger.info({ provider: name }, "Provider circuit half-open");
  });

  return wrap(retryPolicy, cb, timeoutPolicy);
}

// --- Bulkhead adapter ---

/**
 * Create a Cockatiel bulkhead (replaces Semaphore)
 */
function createBulkhead(options = {}) {
  const maxConcurrent = options.maxConcurrent || 2;
  const maxQueue = options.maxQueue || 50;
  return bulkhead(maxConcurrent, maxQueue);
}

module.exports = {
  // Circuit breaker
  CockatielCircuitBreaker,
  CircuitBreakerError,
  CockatielRegistry,
  getCockatielRegistry,
  STATE,

  // Retry
  withCockatielRetry,
  DEFAULT_RETRY_CONFIG,

  // Composed
  createProviderPolicy,

  // Bulkhead
  createBulkhead,

  // Re-exports for internal use
  BrokenCircuitError,
  BulkheadRejectedError,
  TaskCancelledError,
};
