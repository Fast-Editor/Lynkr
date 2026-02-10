const logger = require("../logger");

/**
 * Retry configuration for API calls
 */
const DEFAULT_CONFIG = {
  maxRetries: 3,
  initialDelay: 1000, // 1 second
  maxDelay: 30000, // 30 seconds
  backoffMultiplier: 2,
  jitterFactor: 0.1, // 10% jitter
  retryableStatuses: [429, 500, 502, 503, 504],
  retryableErrors: ['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'ENETUNREACH', 'ECONNREFUSED'],
};

/**
 * Add jitter to prevent thundering herd
 */
function addJitter(delay, jitterFactor) {
  const jitter = delay * jitterFactor * (Math.random() * 2 - 1);
  return Math.max(0, delay + jitter);
}

/**
 * Calculate delay with exponential backoff
 */
function calculateDelay(attempt, config) {
  const baseDelay = config.initialDelay * Math.pow(config.backoffMultiplier, attempt);
  const cappedDelay = Math.min(baseDelay, config.maxDelay);
  return addJitter(cappedDelay, config.jitterFactor);
}

/**
 * Check if error/response is retryable
 */
function isRetryable(error, response, config) {
  // Check response status codes
  if (response && config.retryableStatuses.includes(response.status)) {
    return true;
  }

  // Check error codes
  if (error && error.code && config.retryableErrors.includes(error.code)) {
    return true;
  }

  // Check nested cause (Node undici wraps connection errors as TypeError)
  if (error && error.cause?.code && config.retryableErrors.includes(error.cause.code)) {
    return true;
  }

  // Check for network errors
  if (error && (error.name === 'FetchError' || error.name === 'AbortError')) {
    return true;
  }

  return false;
}

/**
 * Detect if this is a cold start (longer than expected response time)
 */
function detectColdStart(startTime, endTime, threshold = 5000) {
  const duration = endTime - startTime;
  return duration > threshold;
}

/**
 * Execute function with retry logic
 */
async function withRetry(fn, options = {}) {
  const config = { ...DEFAULT_CONFIG, ...options };
  let lastError;
  let lastResponse;

  for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
    const startTime = Date.now();

    try {
      const result = await fn(attempt);
      const endTime = Date.now();

      // Detect cold starts for monitoring
      if (detectColdStart(startTime, endTime)) {
        logger.warn({
          attempt,
          duration: endTime - startTime,
        }, 'Potential cold start detected');
      }

      // Check if response indicates we should retry
      if (result && isRetryable(null, result, config) && attempt < config.maxRetries) {
        lastResponse = result;

        // Special handling for 429 (rate limiting)
        if (result.status === 429) {
          // Check for Retry-After header
          const retryAfter = result.headers?.get?.('retry-after');
          let delay;

          if (retryAfter) {
            // Retry-After can be in seconds or a date
            const retryAfterNum = parseInt(retryAfter, 10);
            if (!isNaN(retryAfterNum)) {
              delay = retryAfterNum * 1000; // Convert to ms
            } else {
              const retryAfterDate = new Date(retryAfter);
              delay = retryAfterDate.getTime() - Date.now();
            }
          } else {
            // Use exponential backoff with longer delays for rate limiting
            delay = calculateDelay(attempt, {
              ...config,
              initialDelay: 2000, // Start at 2s for rate limits
              maxDelay: 60000, // Up to 1 minute
            });
          }

          logger.warn({
            attempt,
            delay,
            retryAfter: retryAfter || 'not specified',
          }, 'Rate limited (429), retrying after delay');

          await sleep(delay);
          continue;
        }

        // Regular retry with exponential backoff
        const delay = calculateDelay(attempt, config);
        logger.warn({
          attempt,
          status: result.status,
          delay,
        }, 'Request failed, retrying with backoff');

        await sleep(delay);
        continue;
      }

      // Success or non-retryable error
      return result;

    } catch (error) {
      lastError = error;
      const endTime = Date.now();

      // Check if cold start
      if (detectColdStart(startTime, endTime)) {
        logger.warn({
          attempt,
          duration: endTime - startTime,
          error: error.message,
        }, 'Potential cold start with error detected');
      }

      // Check if we should retry
      if (isRetryable(error, null, config) && attempt < config.maxRetries) {
        const delay = calculateDelay(attempt, config);
        logger.warn({
          attempt,
          error: error.message,
          code: error.code,
          delay,
        }, 'Request error, retrying with backoff');

        await sleep(delay);
        continue;
      }

      // Not retryable or out of retries
      throw error;
    }
  }

  // Max retries exceeded
  if (lastError) {
    lastError.message = `Max retries (${config.maxRetries}) exceeded: ${lastError.message}`;
    throw lastError;
  }

  if (lastResponse) {
    logger.error({
      status: lastResponse.status,
      maxRetries: config.maxRetries,
    }, 'Max retries exceeded');
    return lastResponse;
  }

  throw new Error('Retry logic failed unexpectedly');
}

/**
 * Sleep helper
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Create a retry wrapper for a specific function
 */
function createRetryWrapper(fn, defaultOptions = {}) {
  return async function (...args) {
    return withRetry(() => fn(...args), defaultOptions);
  };
}

module.exports = {
  withRetry,
  createRetryWrapper,
  calculateDelay,
  isRetryable,
  detectColdStart,
  DEFAULT_CONFIG,
};
