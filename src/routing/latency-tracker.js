/**
 * Rolling Latency Tracker
 *
 * Tracks per-provider latency using circular buffers to provide
 * P50/P95/P99 percentile statistics for routing decisions.
 *
 * @module routing/latency-tracker
 */

const logger = require("../logger");

/** Size of the circular buffer per provider */
const BUFFER_SIZE = 200;

/** Minimum sample count before penalizeScore returns a meaningful value */
const MIN_SAMPLES = 10;

/**
 * @typedef {Object} LatencyStats
 * @property {number} p50 - 50th percentile latency (ms)
 * @property {number} p95 - 95th percentile latency (ms)
 * @property {number} p99 - 99th percentile latency (ms)
 * @property {number} avg - Average latency (ms)
 * @property {number} count - Total measurements recorded
 * @property {number} lastUpdated - Timestamp of the last recorded measurement
 */

class LatencyTracker {
  constructor() {
    /** @type {Map<string, { buffer: number[], index: number, count: number, lastUpdated: number }>} */
    this._providers = new Map();
  }

  /**
   * Record a latency measurement for a provider.
   * @param {string} provider - Provider name (e.g. "databricks", "ollama")
   * @param {number} latencyMs - Measured latency in milliseconds
   */
  record(provider, latencyMs) {
    if (!provider || typeof latencyMs !== "number" || latencyMs < 0) {
      return;
    }

    let entry = this._providers.get(provider);
    if (!entry) {
      entry = {
        buffer: new Array(BUFFER_SIZE).fill(0),
        index: 0,
        count: 0,
        lastUpdated: 0,
      };
      this._providers.set(provider, entry);
    }

    entry.buffer[entry.index] = latencyMs;
    entry.index = (entry.index + 1) % BUFFER_SIZE;
    entry.count += 1;
    entry.lastUpdated = Date.now();
  }

  /**
   * Get latency statistics for a specific provider.
   * @param {string} provider - Provider name
   * @returns {LatencyStats|null} Statistics or null if no data
   */
  getStats(provider) {
    const entry = this._providers.get(provider);
    if (!entry || entry.count === 0) {
      return null;
    }

    const sampleCount = Math.min(entry.count, BUFFER_SIZE);
    const samples = entry.buffer.slice(0, sampleCount);
    const sorted = samples.slice().sort((a, b) => a - b);

    const sum = sorted.reduce((acc, v) => acc + v, 0);

    return {
      p50: sorted[Math.floor(sampleCount * 0.5)],
      p95: sorted[Math.floor(sampleCount * 0.95)],
      p99: sorted[Math.floor(sampleCount * 0.99)],
      avg: Math.round(sum / sampleCount),
      count: entry.count,
      lastUpdated: entry.lastUpdated,
    };
  }

  /**
   * Calculate a routing score penalty/bonus based on provider latency.
   *
   * Returns a value from -5 to +10 that can be added to a routing score:
   *   +10 if P95 > 10000ms (very slow, penalise by boosting complexity toward cloud)
   *   +5  if P95 > 5000ms
   *   -5  if P50 < 1000ms (fast, reward)
   *    0  otherwise or if insufficient data
   *
   * @param {string} provider - Provider name
   * @returns {number} Score adjustment (-5 to +10)
   */
  penalizeScore(provider) {
    const stats = this.getStats(provider);
    if (!stats || stats.count < MIN_SAMPLES) {
      return 0;
    }

    if (stats.p95 > 10000) return 10;
    if (stats.p95 > 5000) return 5;
    if (stats.p50 < 1000) return -5;

    return 0;
  }

  /**
   * Get statistics for all tracked providers.
   * @returns {Map<string, LatencyStats>}
   */
  getAllStats() {
    const result = new Map();
    for (const provider of this._providers.keys()) {
      const stats = this.getStats(provider);
      if (stats) {
        result.set(provider, stats);
      }
    }
    return result;
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

/** @type {LatencyTracker|null} */
let instance = null;

/**
 * Get the singleton LatencyTracker instance.
 * @returns {LatencyTracker}
 */
function getLatencyTracker() {
  if (!instance) {
    instance = new LatencyTracker();
    logger.debug("LatencyTracker initialised");
  }
  return instance;
}

module.exports = { LatencyTracker, getLatencyTracker };
