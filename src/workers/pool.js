/**
 * Worker Thread Pool
 *
 * Offloads CPU-intensive operations (JSON parsing, cloning, compression)
 * from the main event loop to worker threads.
 *
 * @module workers/pool
 */

const { Worker } = require('worker_threads');
const os = require('os');
const path = require('path');
const logger = require('../logger');

class WorkerPool {
  constructor(options = {}) {
    this.size = options.size || Math.max(2, os.cpus().length - 1);
    this.workers = [];
    this.queue = [];
    this.taskId = 0;
    this.pendingTasks = new Map(); // taskId -> { resolve, reject, timeout }
    this.workerScript = path.join(__dirname, 'worker.js');
    this.taskTimeout = options.taskTimeout || 5000;
    this.offloadThreshold = options.offloadThreshold || 10000; // 10KB min to offload
    this.initialized = false;
    this.shuttingDown = false;

    // Stats
    this.stats = {
      tasksProcessed: 0,
      tasksQueued: 0,
      tasksFailed: 0,
      tasksTimedOut: 0,
      workersRestarted: 0,
      avgProcessingTime: 0,
    };
  }

  async initialize() {
    if (this.initialized) return;

    logger.info({ poolSize: this.size }, '[WorkerPool] Initializing worker pool');

    const workerPromises = [];
    for (let i = 0; i < this.size; i++) {
      workerPromises.push(this._createWorker(i));
    }

    await Promise.all(workerPromises);
    this.initialized = true;

    logger.info({
      poolSize: this.size,
      offloadThreshold: this.offloadThreshold,
      taskTimeout: this.taskTimeout
    }, '[WorkerPool] Worker pool initialized');
  }

  async _createWorker(id) {
    return new Promise((resolve, reject) => {
      const worker = new Worker(this.workerScript);
      worker.busy = false;
      worker.id = id;
      worker.taskCount = 0;

      const readyHandler = (msg) => {
        if (msg.type === 'ready') {
          worker.off('message', readyHandler);
          worker.on('message', (msg) => this._handleMessage(worker, msg));
          resolve(worker);
        }
      };

      worker.on('message', readyHandler);
      worker.on('error', (err) => this._handleError(worker, err));
      worker.on('exit', (code) => this._handleExit(worker, code));

      this.workers[id] = worker;

      // Timeout for worker initialization
      setTimeout(() => {
        worker.off('message', readyHandler);
        reject(new Error(`Worker ${id} failed to initialize within timeout`));
      }, 5000);
    });
  }

  _handleMessage(worker, msg) {
    const { taskId, result, error, processingTime } = msg;
    const pending = this.pendingTasks.get(taskId);

    if (pending) {
      clearTimeout(pending.timeout);
      this.pendingTasks.delete(taskId);

      // Update stats
      this.stats.tasksProcessed++;
      if (processingTime) {
        this.stats.avgProcessingTime =
          (this.stats.avgProcessingTime * (this.stats.tasksProcessed - 1) + processingTime) /
          this.stats.tasksProcessed;
      }

      if (error) {
        this.stats.tasksFailed++;
        pending.reject(new Error(error));
      } else {
        pending.resolve(result);
      }
    }

    worker.busy = false;
    worker.taskCount++;
    this._processQueue();
  }

  _handleError(worker, err) {
    logger.error({ workerId: worker.id, error: err.message }, '[WorkerPool] Worker error');

    // Reject all pending tasks for this worker
    for (const [taskId, pending] of this.pendingTasks) {
      if (pending.workerId === worker.id) {
        clearTimeout(pending.timeout);
        this.pendingTasks.delete(taskId);
        this.stats.tasksFailed++;
        pending.reject(err);
      }
    }
  }

  _handleExit(worker, code) {
    if (this.shuttingDown) return;

    logger.warn({ workerId: worker.id, exitCode: code }, '[WorkerPool] Worker exited, replacing');
    this.stats.workersRestarted++;

    // Replace dead worker
    const index = this.workers.indexOf(worker);
    if (index !== -1) {
      this._createWorker(index).catch(err => {
        logger.error({ workerId: index, error: err.message }, '[WorkerPool] Failed to replace worker');
      });
    }
  }

  _getAvailableWorker() {
    // Find least busy worker
    let bestWorker = null;
    let minTasks = Infinity;

    for (const worker of this.workers) {
      if (!worker.busy && worker.taskCount < minTasks) {
        bestWorker = worker;
        minTasks = worker.taskCount;
      }
    }

    return bestWorker;
  }

  _processQueue() {
    if (this.queue.length === 0) return;

    const worker = this._getAvailableWorker();
    if (!worker) return;

    const task = this.queue.shift();
    this.stats.tasksQueued = this.queue.length;
    this._executeTask(worker, task);
  }

  _executeTask(worker, task) {
    worker.busy = true;

    const timeout = setTimeout(() => {
      const pending = this.pendingTasks.get(task.taskId);
      if (pending) {
        this.pendingTasks.delete(task.taskId);
        this.stats.tasksTimedOut++;
        pending.reject(new Error(`Task ${task.type} timed out after ${this.taskTimeout}ms`));
        worker.busy = false;
        this._processQueue();
      }
    }, this.taskTimeout);

    this.pendingTasks.set(task.taskId, {
      resolve: task.resolve,
      reject: task.reject,
      timeout,
      workerId: worker.id,
    });

    worker.postMessage({
      taskId: task.taskId,
      type: task.type,
      payload: task.payload,
    });
  }

  /**
   * Execute a task on a worker thread
   * @param {string} type - Task type: 'parse', 'stringify', 'clone', 'compress', 'transform'
   * @param {*} payload - Data to process
   * @returns {Promise<*>} - Processed result
   */
  async exec(type, payload) {
    if (!this.initialized) {
      await this.initialize();
    }

    if (this.shuttingDown) {
      throw new Error('Worker pool is shutting down');
    }

    return new Promise((resolve, reject) => {
      const task = {
        taskId: ++this.taskId,
        type,
        payload,
        resolve,
        reject,
      };

      const worker = this._getAvailableWorker();
      if (worker) {
        this._executeTask(worker, task);
      } else {
        this.queue.push(task);
        this.stats.tasksQueued = this.queue.length;
      }
    });
  }

  // ============== Convenience Methods ==============

  /**
   * Parse JSON string (offloads large payloads only)
   * @param {string} jsonString - JSON string to parse
   * @returns {Promise<*>} - Parsed object
   */
  async parse(jsonString) {
    // Only offload large payloads
    if (typeof jsonString !== 'string' || jsonString.length < this.offloadThreshold) {
      return JSON.parse(jsonString);
    }
    return this.exec('parse', jsonString);
  }

  /**
   * Stringify object to JSON (offloads large objects only)
   * @param {*} obj - Object to stringify
   * @returns {Promise<string>} - JSON string
   */
  async stringify(obj) {
    // Quick check for size - if small, do inline
    const quick = JSON.stringify(obj);
    if (quick.length < this.offloadThreshold) {
      return quick;
    }
    return this.exec('stringify', obj);
  }

  /**
   * Deep clone an object
   * @param {*} obj - Object to clone
   * @returns {Promise<*>} - Cloned object
   */
  async clone(obj) {
    // For small objects, use inline structuredClone
    const size = JSON.stringify(obj).length;
    if (size < this.offloadThreshold) {
      return typeof structuredClone === 'function'
        ? structuredClone(obj)
        : JSON.parse(JSON.stringify(obj));
    }
    return this.exec('clone', obj);
  }

  /**
   * Transform messages (compression, truncation, etc.)
   * @param {Array} messages - Messages to transform
   * @param {Object} options - Transform options
   * @returns {Promise<Object>} - Transformed messages with stats
   */
  async transform(messages, options = {}) {
    return this.exec('transform', { messages, options });
  }

  /**
   * Get pool statistics
   * @returns {Object} - Pool stats
   */
  getStats() {
    return {
      ...this.stats,
      poolSize: this.size,
      activeWorkers: this.workers.filter(w => w?.busy).length,
      queueLength: this.queue.length,
      pendingTasks: this.pendingTasks.size,
    };
  }

  /**
   * Graceful shutdown
   */
  async shutdown() {
    if (this.shuttingDown) return;
    this.shuttingDown = true;

    logger.info('[WorkerPool] Shutting down...');

    // Reject all pending tasks
    for (const [taskId, pending] of this.pendingTasks) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('Worker pool shutting down'));
    }
    this.pendingTasks.clear();
    this.queue = [];

    // Terminate all workers
    const terminatePromises = this.workers
      .filter(w => w)
      .map(w => w.terminate());

    await Promise.all(terminatePromises);
    this.workers = [];
    this.initialized = false;

    logger.info({ stats: this.stats }, '[WorkerPool] Shutdown complete');
  }
}

// Singleton instance
let pool = null;

/**
 * Get the singleton worker pool instance
 * @param {Object} options - Pool options (only used on first call)
 * @returns {WorkerPool} - Worker pool instance
 */
function getWorkerPool(options) {
  if (!pool) {
    pool = new WorkerPool(options);
  }
  return pool;
}

/**
 * Check if worker pool is available and initialized
 * @returns {boolean}
 */
function isWorkerPoolReady() {
  return pool?.initialized === true;
}

module.exports = {
  WorkerPool,
  getWorkerPool,
  isWorkerPoolReady,
};
