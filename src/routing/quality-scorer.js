/**
 * Quality Scorer Module
 *
 * Lightweight heuristic scorer that evaluates response quality on a 0-100
 * scale. Used by the telemetry system to detect over/under-provisioned
 * routing decisions so they can be corrected over time.
 *
 * @module routing/quality-scorer
 */

/**
 * @typedef {Object} RequestContext
 * @property {string} [tier] - Routing tier (SIMPLE, MODERATE, COMPLEX, REASONING)
 * @property {boolean} [hasTools] - Whether the original request included tools
 */

/**
 * @typedef {Object} ResponseOutcome
 * @property {number} [status_code] - HTTP status code
 * @property {number} [output_tokens] - Tokens produced in the response
 * @property {number} [tool_calls_made] - Number of tool calls executed
 * @property {boolean} [was_fallback] - Whether a fallback provider was used
 * @property {number} [retry_count] - Number of retries before success
 * @property {string} [error_type] - Error classification if the request failed
 * @property {number} [latency_ms] - End-to-end latency in milliseconds
 */

/**
 * Score the quality of a routed response.
 *
 * Starts at 50 and applies additive/subtractive heuristics.
 * Final value is clamped to [0, 100].
 *
 * @param {RequestContext} request - Contextual information about the request
 * @param {Object} _response - Raw response object (reserved for future use)
 * @param {ResponseOutcome} outcome - Measured outcome metrics
 * @returns {number} Quality score in range 0-100
 */
function scoreResponseQuality(request, _response, outcome) {
  let score = 50;

  const {
    status_code,
    output_tokens,
    tool_calls_made,
    was_fallback,
    retry_count,
    error_type,
    latency_ms,
  } = outcome || {};

  const tier = request?.tier;
  const hasTools = request?.hasTools ?? false;

  // --- Positive signals ---

  if (status_code === 200) {
    score += 10;
  }

  if (typeof output_tokens === "number" && output_tokens > 100) {
    score += 5;
  }

  if (typeof tool_calls_made === "number" && tool_calls_made > 0 && hasTools) {
    score += 10;
  }

  if (!was_fallback) {
    score += 5;
  }

  if (retry_count === 0) {
    score += 5;
  }

  // --- Negative signals ---

  if (error_type) {
    score -= 30;
  }

  if (was_fallback) {
    score -= 10;
  }

  if (typeof retry_count === "number" && retry_count > 1) {
    score -= 10;
  }

  if (typeof latency_ms === "number" && latency_ms > 30000) {
    score -= 10;
  }

  if (typeof output_tokens === "number" && output_tokens < 20 && hasTools) {
    score -= 15;
  }

  // --- Tier mismatch signals ---

  if (tier === "REASONING" && typeof output_tokens === "number" && output_tokens < 50) {
    score -= 10;
  }

  if (tier === "COMPLEX" && typeof latency_ms === "number" && latency_ms < 500) {
    score -= 5;
  }

  // Clamp to [0, 100]
  return Math.max(0, Math.min(100, score));
}

module.exports = { scoreResponseQuality };
