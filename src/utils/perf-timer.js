/**
 * Request Performance Timer
 *
 * Lightweight timing instrumentation for the request hot path.
 * Enable with LOG_LEVEL=debug or PERF_TIMER=true to see per-request
 * breakdown of where time is spent.
 *
 * Usage:
 *   const timer = createTimer('processMessage');
 *   timer.mark('sanitizePayload');
 *   // ... do work ...
 *   timer.mark('cacheCheck');
 *   // ... do work ...
 *   timer.done(); // logs full breakdown
 *
 * @module utils/perf-timer
 */

const { performance } = require('perf_hooks');
const logger = require('../logger');

const ENABLED = process.env.PERF_TIMER === 'true';

/**
 * Create a performance timer for a named operation.
 * @param {string} name - Timer name (e.g., 'processMessage', 'invokeModel')
 * @returns {{ mark: (label: string) => void, done: () => Object }}
 */
function createTimer(name) {
  if (!ENABLED) {
    // No-op when disabled — zero overhead
    return {
      mark() {},
      done() { return null; },
    };
  }

  const start = performance.now();
  const marks = [];
  let lastMark = start;

  return {
    /**
     * Record a checkpoint.
     * @param {string} label - What just completed
     */
    mark(label) {
      const now = performance.now();
      marks.push({
        label,
        elapsed: now - lastMark,
        cumulative: now - start,
      });
      lastMark = now;
    },

    /**
     * Finish timing and log the breakdown.
     * @returns {Object} Timing breakdown
     */
    done() {
      const total = performance.now() - start;
      const breakdown = {};

      for (const m of marks) {
        breakdown[m.label] = `${m.elapsed.toFixed(2)}ms`;
      }

      logger.info({
        timer: name,
        totalMs: total.toFixed(2),
        breakdown,
      }, `[perf] ${name}: ${total.toFixed(1)}ms`);

      return { name, totalMs: total, marks, breakdown };
    },
  };
}

module.exports = { createTimer };
