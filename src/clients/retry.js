/**
 * Retry logic for API calls — backed by Cockatiel
 *
 * This module re-exports the Cockatiel-backed retry adapter from resilience.js
 * while preserving all original exports for consumers.
 */
const { withCockatielRetry, DEFAULT_RETRY_CONFIG } = require("./resilience");

const DEFAULT_CONFIG = {
  maxRetries: DEFAULT_RETRY_CONFIG.maxRetries,
  initialDelay: DEFAULT_RETRY_CONFIG.initialDelay,
  maxDelay: DEFAULT_RETRY_CONFIG.maxDelay,
  backoffMultiplier: DEFAULT_RETRY_CONFIG.backoffMultiplier,
  jitterFactor: DEFAULT_RETRY_CONFIG.jitterFactor,
  retryableStatuses: DEFAULT_RETRY_CONFIG.retryableStatuses,
  retryableErrors: DEFAULT_RETRY_CONFIG.retryableErrors,
};

/**
 * Calculate delay with exponential backoff (preserved for any direct callers)
 */
function calculateDelay(attempt, config) {
  const baseDelay = config.initialDelay * Math.pow(config.backoffMultiplier, attempt);
  const cappedDelay = Math.min(baseDelay, config.maxDelay);
  const jitter = cappedDelay * config.jitterFactor * (Math.random() * 2 - 1);
  return Math.max(0, cappedDelay + jitter);
}

/**
 * Check if error/response is retryable (preserved for any direct callers)
 */
function isRetryable(error, response, config) {
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
 * Create a retry wrapper for a specific function
 */
function createRetryWrapper(fn, defaultOptions = {}) {
  return async function (...args) {
    return withCockatielRetry(() => fn(...args), defaultOptions);
  };
}

module.exports = {
  withRetry: withCockatielRetry,
  createRetryWrapper,
  calculateDelay,
  isRetryable,
  detectColdStart,
  DEFAULT_CONFIG,
};
