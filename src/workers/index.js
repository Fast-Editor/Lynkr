/**
 * Worker Thread Pool Module
 *
 * Exports all worker pool functionality for easy importing.
 *
 * @module workers
 */

const { WorkerPool, getWorkerPool, isWorkerPoolReady } = require('./pool');
const {
  asyncClone,
  asyncParse,
  asyncStringify,
  asyncTransform,
  syncClone,
  syncTransform,
  getPoolStats,
  OFFLOAD_THRESHOLD,
} = require('./helpers');

module.exports = {
  // Pool management
  WorkerPool,
  getWorkerPool,
  isWorkerPoolReady,

  // Async helpers (use worker pool when available)
  asyncClone,
  asyncParse,
  asyncStringify,
  asyncTransform,

  // Sync fallbacks
  syncClone,
  syncTransform,

  // Utilities
  getPoolStats,
  OFFLOAD_THRESHOLD,
};
