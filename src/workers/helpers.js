/**
 * Worker Pool Helper Functions
 *
 * Provides easy-to-use async wrappers for offloading CPU-intensive operations
 * to worker threads with automatic fallback to sync operations.
 *
 * @module workers/helpers
 */

const { getWorkerPool, isWorkerPoolReady } = require('./pool');
const config = require('../config');

// Threshold for offloading (bytes)
const OFFLOAD_THRESHOLD = config.workerPool?.offloadThresholdBytes || 10000;

/**
 * Deep clone an object, using worker thread for large objects
 * @param {*} obj - Object to clone
 * @returns {Promise<*>} - Cloned object
 */
async function asyncClone(obj) {
  // Estimate size quickly
  let estimatedSize;
  try {
    estimatedSize = JSON.stringify(obj).length;
  } catch {
    // If stringify fails, fall back to sync clone
    return syncClone(obj);
  }

  // Use worker for large objects, sync for small ones
  if (config.workerPool?.enabled !== false && isWorkerPoolReady() && estimatedSize >= OFFLOAD_THRESHOLD) {
    try {
      const pool = getWorkerPool();
      return await pool.clone(obj);
    } catch (err) {
      // Fall back to sync on error
      return syncClone(obj);
    }
  }

  return syncClone(obj);
}

/**
 * Synchronous clone (inline, for small objects)
 */
function syncClone(obj) {
  if (typeof structuredClone === 'function') {
    try {
      return structuredClone(obj);
    } catch {
      // structuredClone can fail on some objects
    }
  }
  return JSON.parse(JSON.stringify(obj));
}

/**
 * Parse JSON, using worker thread for large strings
 * @param {string} jsonString - JSON string to parse
 * @returns {Promise<*>} - Parsed object
 */
async function asyncParse(jsonString) {
  if (typeof jsonString !== 'string') {
    throw new TypeError('Expected a JSON string');
  }

  if (config.workerPool?.enabled !== false && isWorkerPoolReady() && jsonString.length >= OFFLOAD_THRESHOLD) {
    try {
      const pool = getWorkerPool();
      return await pool.parse(jsonString);
    } catch (err) {
      // Fall back to sync on error
      return JSON.parse(jsonString);
    }
  }

  return JSON.parse(jsonString);
}

/**
 * Stringify object, using worker thread for large objects
 * @param {*} obj - Object to stringify
 * @returns {Promise<string>} - JSON string
 */
async function asyncStringify(obj) {
  // Quick check for size
  const quick = JSON.stringify(obj);

  if (config.workerPool?.enabled !== false && isWorkerPoolReady() && quick.length >= OFFLOAD_THRESHOLD) {
    try {
      const pool = getWorkerPool();
      return await pool.stringify(obj);
    } catch {
      // Already have the result from quick check
      return quick;
    }
  }

  return quick;
}

/**
 * Transform messages (compression, truncation), using worker thread
 * @param {Array} messages - Messages to transform
 * @param {Object} options - Transform options
 * @returns {Promise<Object>} - Transformed messages with stats
 */
async function asyncTransform(messages, options = {}) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return { messages, transformed: false, stats: {} };
  }

  if (config.workerPool?.enabled !== false && isWorkerPoolReady()) {
    try {
      const pool = getWorkerPool();
      return await pool.transform(messages, options);
    } catch (err) {
      // Return untransformed on error
      return { messages, transformed: false, stats: {}, error: err.message };
    }
  }

  // Sync fallback - basic truncation
  return syncTransform(messages, options);
}

/**
 * Synchronous transform fallback
 */
function syncTransform(messages, options = {}) {
  const { maxAssistantLength = 5000, maxToolResultLength = 3000 } = options;

  const transformed = messages.map(msg => {
    if (!msg) return msg;

    // Truncate long assistant messages
    if (msg.role === 'assistant' && typeof msg.content === 'string' && msg.content.length > maxAssistantLength) {
      return {
        ...msg,
        content: msg.content.substring(0, maxAssistantLength) + '\n[...truncated...]',
      };
    }

    // Truncate tool results
    if (msg.role === 'tool' && typeof msg.content === 'string' && msg.content.length > maxToolResultLength) {
      return {
        ...msg,
        content: msg.content.substring(0, maxToolResultLength) + '\n[...truncated...]',
      };
    }

    return msg;
  });

  return { messages: transformed, transformed: true, stats: {} };
}

/**
 * Get worker pool statistics
 * @returns {Object|null} - Pool stats or null if not available
 */
function getPoolStats() {
  if (!isWorkerPoolReady()) {
    return null;
  }
  try {
    const pool = getWorkerPool();
    return pool.getStats();
  } catch {
    return null;
  }
}

module.exports = {
  asyncClone,
  asyncParse,
  asyncStringify,
  asyncTransform,
  syncClone,
  syncTransform,
  getPoolStats,
  OFFLOAD_THRESHOLD,
};
