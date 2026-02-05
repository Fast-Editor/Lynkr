# Worker Thread Pool Implementation Plan

## Overview

Offload CPU-intensive operations from the main event loop to worker threads, keeping the main thread free for I/O operations only.

---

## What to Offload

| Operation | Current Location | CPU Impact | Priority |
|-----------|-----------------|------------|----------|
| JSON.parse (large payloads) | Throughout codebase | High | P0 |
| JSON.stringify (responses) | Throughout codebase | High | P0 |
| Deep cloning | `orchestrator/index.js:761,3146` | High | P0 |
| Headroom compression | `orchestrator/index.js` | Very High | P0 |
| Logging (formatting + I/O) | `logger.js` | Medium | P1 |
| Tool result truncation | `orchestrator/index.js` | Medium | P1 |
| Message transformation | `responses-format.js` | Medium | P2 |
| Embedding generation | `memory/index.js` | High | P2 |

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      MAIN THREAD                            │
│  ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌─────────┐        │
│  │ Express │→ │ Router  │→ │Orchestr.│→ │ Stream  │        │
│  │ Server  │  │         │  │ (I/O)   │  │ Response│        │
│  └─────────┘  └─────────┘  └────┬────┘  └─────────┘        │
│                                 │                           │
│                    ┌────────────┴────────────┐              │
│                    │    WorkerPool API       │              │
│                    │  (Promise-based queue)  │              │
│                    └────────────┬────────────┘              │
└─────────────────────────────────┼───────────────────────────┘
                                  │ postMessage / MessageChannel
                    ┌─────────────┴─────────────┐
                    ▼             ▼             ▼
              ┌──────────┐ ┌──────────┐ ┌──────────┐
              │ Worker 1 │ │ Worker 2 │ │ Worker N │
              │──────────│ │──────────│ │──────────│
              │• JSON ops│ │• JSON ops│ │• JSON ops│
              │• Compress│ │• Compress│ │• Compress│
              │• Clone   │ │• Clone   │ │• Clone   │
              │• Log fmt │ │• Log fmt │ │• Log fmt │
              └──────────┘ └──────────┘ └──────────┘
                    WORKER THREADS (CPU-bound tasks)
```

---

## Implementation

### Phase 1: Create Worker Pool Infrastructure

**File**: `src/workers/pool.js`

```javascript
const { Worker } = require('worker_threads');
const os = require('os');
const path = require('path');

class WorkerPool {
  constructor(options = {}) {
    this.size = options.size || Math.max(2, os.cpus().length - 1);
    this.workers = [];
    this.queue = [];
    this.taskId = 0;
    this.pendingTasks = new Map(); // taskId -> { resolve, reject, timeout }
    this.workerScript = path.join(__dirname, 'worker.js');
    this.taskTimeout = options.taskTimeout || 5000;
    this.initialized = false;
  }

  async initialize() {
    if (this.initialized) return;

    for (let i = 0; i < this.size; i++) {
      const worker = new Worker(this.workerScript);
      worker.busy = false;
      worker.id = i;

      worker.on('message', (msg) => this._handleMessage(worker, msg));
      worker.on('error', (err) => this._handleError(worker, err));
      worker.on('exit', (code) => this._handleExit(worker, code));

      this.workers.push(worker);
    }

    this.initialized = true;
    console.log(`[WorkerPool] Initialized ${this.size} workers`);
  }

  _handleMessage(worker, msg) {
    const { taskId, result, error } = msg;
    const pending = this.pendingTasks.get(taskId);

    if (pending) {
      clearTimeout(pending.timeout);
      this.pendingTasks.delete(taskId);

      if (error) {
        pending.reject(new Error(error));
      } else {
        pending.resolve(result);
      }
    }

    worker.busy = false;
    this._processQueue();
  }

  _handleError(worker, err) {
    console.error(`[WorkerPool] Worker ${worker.id} error:`, err);
    // Reject all pending tasks for this worker
    // Worker will be replaced on exit
  }

  _handleExit(worker, code) {
    console.warn(`[WorkerPool] Worker ${worker.id} exited with code ${code}`);

    // Replace dead worker
    const index = this.workers.indexOf(worker);
    if (index !== -1) {
      const newWorker = new Worker(this.workerScript);
      newWorker.busy = false;
      newWorker.id = worker.id;
      newWorker.on('message', (msg) => this._handleMessage(newWorker, msg));
      newWorker.on('error', (err) => this._handleError(newWorker, err));
      newWorker.on('exit', (code) => this._handleExit(newWorker, code));
      this.workers[index] = newWorker;
    }
  }

  _getAvailableWorker() {
    return this.workers.find(w => !w.busy);
  }

  _processQueue() {
    if (this.queue.length === 0) return;

    const worker = this._getAvailableWorker();
    if (!worker) return;

    const task = this.queue.shift();
    this._executeTask(worker, task);
  }

  _executeTask(worker, task) {
    worker.busy = true;

    const timeout = setTimeout(() => {
      const pending = this.pendingTasks.get(task.taskId);
      if (pending) {
        this.pendingTasks.delete(task.taskId);
        pending.reject(new Error(`Task ${task.type} timed out after ${this.taskTimeout}ms`));
        worker.busy = false;
        this._processQueue();
      }
    }, this.taskTimeout);

    this.pendingTasks.set(task.taskId, {
      resolve: task.resolve,
      reject: task.reject,
      timeout
    });

    worker.postMessage({
      taskId: task.taskId,
      type: task.type,
      payload: task.payload
    });
  }

  /**
   * Execute a task on a worker thread
   * @param {string} type - Task type: 'parse', 'stringify', 'clone', 'compress', 'log'
   * @param {*} payload - Data to process
   * @returns {Promise<*>} - Processed result
   */
  async exec(type, payload) {
    if (!this.initialized) {
      await this.initialize();
    }

    return new Promise((resolve, reject) => {
      const task = {
        taskId: ++this.taskId,
        type,
        payload,
        resolve,
        reject
      };

      const worker = this._getAvailableWorker();
      if (worker) {
        this._executeTask(worker, task);
      } else {
        this.queue.push(task);
      }
    });
  }

  // Convenience methods
  async parse(jsonString) {
    // Only offload large payloads (> 10KB)
    if (jsonString.length < 10000) {
      return JSON.parse(jsonString);
    }
    return this.exec('parse', jsonString);
  }

  async stringify(obj) {
    // Only offload large objects
    const quick = JSON.stringify(obj);
    if (quick.length < 10000) {
      return quick;
    }
    return this.exec('stringify', obj);
  }

  async clone(obj) {
    return this.exec('clone', obj);
  }

  async compress(messages, options) {
    return this.exec('compress', { messages, options });
  }

  async formatLog(level, msg, data) {
    return this.exec('log', { level, msg, data });
  }

  async shutdown() {
    console.log('[WorkerPool] Shutting down...');

    // Reject all pending tasks
    for (const [taskId, pending] of this.pendingTasks) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('Worker pool shutting down'));
    }
    this.pendingTasks.clear();

    // Terminate all workers
    await Promise.all(this.workers.map(w => w.terminate()));
    this.workers = [];
    this.initialized = false;

    console.log('[WorkerPool] Shutdown complete');
  }
}

// Singleton instance
let pool = null;

function getWorkerPool(options) {
  if (!pool) {
    pool = new WorkerPool(options);
  }
  return pool;
}

module.exports = { WorkerPool, getWorkerPool };
```

---

### Phase 2: Create Worker Script

**File**: `src/workers/worker.js`

```javascript
const { parentPort } = require('worker_threads');

// Task handlers
const handlers = {
  parse(payload) {
    return JSON.parse(payload);
  },

  stringify(payload) {
    return JSON.stringify(payload);
  },

  clone(payload) {
    // structuredClone is faster than JSON round-trip for complex objects
    if (typeof structuredClone === 'function') {
      return structuredClone(payload);
    }
    return JSON.parse(JSON.stringify(payload));
  },

  compress(payload) {
    const { messages, options } = payload;
    // Import compression logic here to avoid main thread overhead
    // This is where Headroom's SmartCrusher logic would run
    return compressMessages(messages, options);
  },

  log(payload) {
    const { level, msg, data } = payload;
    // Format log entry (the expensive part)
    const timestamp = new Date().toISOString();
    const formatted = {
      level,
      time: timestamp,
      msg,
      ...data
    };
    return JSON.stringify(formatted);
  }
};

// Compression implementation (moved from main thread)
function compressMessages(messages, options = {}) {
  if (!messages || messages.length === 0) {
    return { messages, compressed: false };
  }

  // Implement SmartCrusher logic here
  // This runs in worker thread, not blocking main thread

  const compressed = messages.map(msg => {
    if (msg.role === 'assistant' && msg.content) {
      // Truncate long assistant messages
      if (msg.content.length > 5000) {
        return {
          ...msg,
          content: msg.content.substring(0, 5000) + '\n[...truncated...]'
        };
      }
    }

    // Truncate tool results
    if (msg.role === 'tool' && msg.content) {
      if (msg.content.length > 3000) {
        return {
          ...msg,
          content: msg.content.substring(0, 3000) + '\n[...truncated...]'
        };
      }
    }

    return msg;
  });

  return {
    messages: compressed,
    compressed: true,
    stats: {
      original_count: messages.length,
      compressed_count: compressed.length
    }
  };
}

// Message handler
parentPort.on('message', async (msg) => {
  const { taskId, type, payload } = msg;

  try {
    const handler = handlers[type];
    if (!handler) {
      throw new Error(`Unknown task type: ${type}`);
    }

    const result = await handler(payload);
    parentPort.postMessage({ taskId, result });

  } catch (err) {
    parentPort.postMessage({ taskId, error: err.message });
  }
});

// Signal ready
parentPort.postMessage({ type: 'ready' });
```

---

### Phase 3: Integrate into Orchestrator

**File**: `src/orchestrator/index.js`

```javascript
// Add at top
const { getWorkerPool } = require('../workers/pool');

// Replace JSON operations in hot paths:

// BEFORE (line ~761):
const cleanPayload = JSON.parse(JSON.stringify(payload));

// AFTER:
const workerPool = getWorkerPool();
const cleanPayload = await workerPool.clone(payload);

// BEFORE (line ~3146):
const clonedMessages = JSON.parse(JSON.stringify(messages));

// AFTER:
const clonedMessages = await workerPool.clone(messages);

// For Headroom compression:
// BEFORE:
const compressionResult = await headroomCompress(cleanPayload.messages, { ... });

// AFTER:
const compressionResult = await workerPool.compress(cleanPayload.messages, { ... });
```

---

### Phase 4: Async Logger

**File**: `src/workers/async-logger.js`

```javascript
const { getWorkerPool } = require('./pool');
const fs = require('fs');
const path = require('path');

class AsyncLogger {
  constructor(options = {}) {
    this.pool = getWorkerPool();
    this.buffer = [];
    this.bufferSize = options.bufferSize || 100;
    this.flushInterval = options.flushInterval || 1000;
    this.logFile = options.logFile || path.join(process.cwd(), 'logs', 'app.log');
    this.writeStream = null;

    // Start flush timer
    this.flushTimer = setInterval(() => this.flush(), this.flushInterval);
  }

  async log(level, msg, data = {}) {
    // Format in worker thread
    const formatted = await this.pool.formatLog(level, msg, data);

    // Buffer for batch writing
    this.buffer.push(formatted);

    if (this.buffer.length >= this.bufferSize) {
      this.flush();
    }
  }

  info(msg, data) { return this.log('info', msg, data); }
  warn(msg, data) { return this.log('warn', msg, data); }
  error(msg, data) { return this.log('error', msg, data); }
  debug(msg, data) { return this.log('debug', msg, data); }

  flush() {
    if (this.buffer.length === 0) return;

    const batch = this.buffer.splice(0, this.buffer.length);
    const content = batch.join('\n') + '\n';

    // Non-blocking write
    if (!this.writeStream) {
      this.writeStream = fs.createWriteStream(this.logFile, { flags: 'a' });
    }

    this.writeStream.write(content);
  }

  async shutdown() {
    clearInterval(this.flushTimer);
    this.flush();

    if (this.writeStream) {
      return new Promise(resolve => {
        this.writeStream.end(resolve);
      });
    }
  }
}

module.exports = { AsyncLogger };
```

---

### Phase 5: Graceful Shutdown

**File**: `src/server.js`

```javascript
const { getWorkerPool } = require('./workers/pool');

// Add shutdown handler
process.on('SIGTERM', async () => {
  console.log('Received SIGTERM, shutting down gracefully...');

  // Stop accepting new requests
  server.close();

  // Shutdown worker pool
  const pool = getWorkerPool();
  await pool.shutdown();

  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('Received SIGINT, shutting down gracefully...');

  const pool = getWorkerPool();
  await pool.shutdown();

  process.exit(0);
});
```

---

## Configuration

**File**: `.env`

```bash
# Worker Thread Pool Configuration
WORKER_POOL_SIZE=4                    # Number of workers (default: CPU cores - 1)
WORKER_TASK_TIMEOUT_MS=5000           # Task timeout (default: 5000ms)
WORKER_OFFLOAD_THRESHOLD_BYTES=10000  # Min payload size to offload (default: 10KB)
WORKER_LOG_BUFFER_SIZE=100            # Log entries to buffer before flush
WORKER_LOG_FLUSH_INTERVAL_MS=1000     # Log flush interval
```

---

## Files to Create/Modify

| File | Action | Description |
|------|--------|-------------|
| `src/workers/pool.js` | **CREATE** | Worker pool manager |
| `src/workers/worker.js` | **CREATE** | Worker thread script |
| `src/workers/async-logger.js` | **CREATE** | Non-blocking logger |
| `src/orchestrator/index.js` | **MODIFY** | Replace JSON ops with worker calls |
| `src/server.js` | **MODIFY** | Add graceful shutdown |
| `src/config/index.js` | **MODIFY** | Add worker pool config |
| `.env` | **MODIFY** | Add worker pool settings |

---

## Performance Expectations

| Operation | Before (Main Thread) | After (Worker) | Improvement |
|-----------|---------------------|----------------|-------------|
| JSON.parse (100KB) | ~5ms blocking | ~5ms non-blocking | Main thread free |
| Deep clone (50KB) | ~8ms blocking | ~8ms non-blocking | Main thread free |
| Headroom compress | ~20ms blocking | ~20ms non-blocking | Main thread free |
| Log formatting | ~1ms blocking | ~1ms non-blocking | Main thread free |

**Net effect**: Main thread handles 3-5x more concurrent connections because it's never blocked by CPU work.

---

## Testing

```bash
# Benchmark before
autocannon -c 100 -d 30 http://localhost:8081/v1/chat/completions

# Implement changes

# Benchmark after
autocannon -c 100 -d 30 http://localhost:8081/v1/chat/completions

# Expected: Higher requests/sec, lower latency variance
```

---

## Rollout Plan

1. **Day 1**: Create worker pool infrastructure (Phase 1-2)
2. **Day 2**: Integrate into orchestrator for JSON ops (Phase 3)
3. **Day 3**: Add async logger (Phase 4)
4. **Day 4**: Add graceful shutdown + testing (Phase 5)
5. **Day 5**: Load testing and tuning

---

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Data serialization overhead | Only offload payloads > 10KB |
| Worker crashes | Auto-restart dead workers |
| Memory usage increase | Limit pool size, monitor RSS |
| Debugging complexity | Add task tracing with IDs |
