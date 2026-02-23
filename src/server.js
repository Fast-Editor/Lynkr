const express = require("express");
const compression = require("compression");
const config = require("./config");

// Clear logs directory BEFORE initializing loggers
// This prevents the issue where loggers hold file handles to deleted files
const fs = require("fs");
const path = require("path");
const logFile = process.env.LOG_FILE;
if (logFile) {
  const logsDir = path.dirname(logFile);
  try {
    if (fs.existsSync(logsDir)) {
      const files = fs.readdirSync(logsDir);
      let deletedCount = 0;
      for (const file of files) {
        const filePath = path.join(logsDir, file);
        const stat = fs.statSync(filePath);
        if (stat.isFile()) {
          fs.unlinkSync(filePath);
          deletedCount++;
        }
      }
      if (deletedCount > 0) {
        console.log(`[STARTUP] Cleared ${deletedCount} log file(s) from ${logsDir}`);
      }

      // Also delete oversized-errors directory and its contents
      const oversizedErrorsDir = path.join(logsDir, "oversized-errors");
      if (fs.existsSync(oversizedErrorsDir)) {
        const errorFiles = fs.readdirSync(oversizedErrorsDir);
        let errorFilesDeleted = 0;
        for (const file of errorFiles) {
          const filePath = path.join(oversizedErrorsDir, file);
          fs.unlinkSync(filePath);
          errorFilesDeleted++;
        }
        fs.rmdirSync(oversizedErrorsDir);
        if (errorFilesDeleted > 0) {
          console.log(`[STARTUP] Cleared ${errorFilesDeleted} oversized error file(s) and removed directory`);
        }
      }
    }
  } catch (err) {
    console.error(`[STARTUP] Failed to clear logs: ${err.message}`);
  }
}

const loggingMiddleware = require("./api/middleware/logging");
const router = require("./api/router");
const { sessionMiddleware } = require("./api/middleware/session");
const { budgetMiddleware } = require("./api/middleware/budget");
const { metricsMiddleware } = require("./api/middleware/metrics");
const { requestLoggingMiddleware } = require("./api/middleware/request-logging");
const { errorHandlingMiddleware, notFoundHandler } = require("./api/middleware/error-handling");
const { loadSheddingMiddleware, initializeLoadShedder } = require("./api/middleware/load-shedding");
const { livenessCheck, readinessCheck } = require("./api/health");
const { getMetricsCollector } = require("./observability/metrics");
const { getShutdownManager } = require("./server/shutdown");
const { getCircuitBreakerRegistry } = require("./clients/circuit-breaker");
const metrics = require("./metrics");
const logger = require("./logger");
const { initialiseMcp } = require("./mcp");
const { registerStubTools } = require("./tools/stubs");
const { registerWorkspaceTools } = require("./tools/workspace");
const { registerExecutionTools } = require("./tools/execution");
const { registerWebTools } = require("./tools/web");
const { registerIndexerTools } = require("./tools/indexer");
const { registerEditTools } = require("./tools/edits");
const { registerGitTools } = require("./tools/git");
const { registerTaskTools } = require("./tools/tasks");
const { registerTestTools } = require("./tools/tests");
const { registerMcpTools } = require("./tools/mcp");
const { registerAgentTaskTool } = require("./tools/agent-task");
const { initConfigWatcher, getConfigWatcher } = require("./config/watcher");
const { initializeHeadroom, shutdownHeadroom, getHeadroomManager } = require("./headroom");
const { getWorkerPool, isWorkerPoolReady } = require("./workers/pool");
const lazyLoader = require("./tools/lazy-loader");
const { setLazyLoader } = require("./tools");
const { waitForOllama } = require("./clients/ollama-startup");
const { initializeProgressServer, shutdownProgressServer } = require("./progress/server");

// Initialize MCP
initialiseMcp();

// Set up lazy tool loading
setLazyLoader(lazyLoader);

// Check if lazy loading is enabled (default: true)
const LAZY_TOOLS_ENABLED = process.env.LAZY_TOOLS_ENABLED !== "false";

if (LAZY_TOOLS_ENABLED) {
  // Only load core tools at startup (stubs, workspace, execution)
  lazyLoader.loadCoreTools();
  logger.info({ mode: "lazy" }, "Lazy tool loading enabled - other tools will load on demand");
} else {
  // Backwards compatibility: load all tools at startup
  registerStubTools();
  registerWorkspaceTools();
  registerExecutionTools();
  registerWebTools();
  registerIndexerTools();
  registerEditTools();
  registerGitTools();
  registerTaskTools();
  registerTestTools();
  registerMcpTools();
  registerAgentTaskTool();
  logger.info({ mode: "eager" }, "All tools loaded at startup");
}

function createApp() {
  const app = express();

  // Initialize load shedder (log configuration)
  initializeLoadShedder();

  // Load shedding (protect against overload)
  app.use(loadSheddingMiddleware);

  // Request logging (add request IDs, structured logs)
  app.use(requestLoggingMiddleware);

  // Metrics collection
  app.use(metricsMiddleware);

  // Enable compression for all responses (gzip/deflate)
  app.use(compression({
    level: 6, // Balanced compression level
    threshold: 1024, // Only compress responses > 1KB
    filter: (req, res) => {
      // Don't compress event streams
      if (res.getHeader('Content-Type') === 'text/event-stream') {
        return false;
      }
      return compression.filter(req, res);
    }
  }));

  app.use(express.json({ limit: config.server.jsonLimit }));
  app.use(sessionMiddleware);
  app.use(loggingMiddleware);

  // Budget and rate limiting (can be disabled via config)
  if (config.budget?.enabled !== false) {
    app.use('/v1/messages', budgetMiddleware);
  }

  // Health check endpoints
  app.get("/health/live", livenessCheck);
  app.get("/health/ready", readinessCheck);

  // Metrics endpoints
  app.get("/metrics", (req, res) => {
    res.json(metrics.snapshot());
  });

  app.get("/metrics/observability", (req, res) => {
    const metricsCollector = getMetricsCollector();
    res.json(metricsCollector.getMetrics());
  });

  app.get("/metrics/prometheus", (req, res) => {
    const metricsCollector = getMetricsCollector();
    res.set("Content-Type", "text/plain");
    res.send(metricsCollector.toPrometheus());
  });

  app.get("/metrics/circuit-breakers", (req, res) => {
    const registry = getCircuitBreakerRegistry();
    res.json(registry.getAll());
  });

  app.get("/metrics/load-shedding", (req, res) => {
    const { getLoadShedder } = require("./api/middleware/load-shedding");
    const shedder = getLoadShedder();
    res.json(shedder.getMetrics());
  });

  app.get("/metrics/worker-pool", (req, res) => {
    if (!isWorkerPoolReady()) {
      return res.json({ enabled: false, message: "Worker pool not initialized" });
    }
    const pool = getWorkerPool();
    res.json({ enabled: true, ...pool.getStats() });
  });

  app.get("/metrics/semantic-cache", (req, res) => {
    const { getSemanticCache, isSemanticCacheEnabled } = require("./cache/semantic");
    if (!isSemanticCacheEnabled()) {
      return res.json({ enabled: false, message: "Semantic cache not enabled" });
    }
    const cache = getSemanticCache();
    res.json({ enabled: true, ...cache.getStats() });
  });

  app.get("/metrics/lazy-tools", (req, res) => {
    res.json({
      enabled: LAZY_TOOLS_ENABLED,
      ...lazyLoader.getLoaderStats(),
    });
  });

  app.use(router);

  // 404 handler (must be after all routes)
  app.use(notFoundHandler);

  // Error handler (must be last)
  app.use(errorHandlingMiddleware);

  return app;
}

async function start() {
  // Initialize Worker Thread Pool (if enabled)
  // This pre-warms worker threads for CPU-intensive tasks
  if (config.workerPool?.enabled !== false) {
    try {
      const poolOptions = {
        size: config.workerPool?.size || undefined, // undefined = auto
        taskTimeout: config.workerPool?.taskTimeoutMs || 5000,
        offloadThreshold: config.workerPool?.offloadThresholdBytes || 10000,
      };
      const pool = getWorkerPool(poolOptions);
      await pool.initialize();
      logger.info({ poolSize: pool.size }, "Worker thread pool initialized");
    } catch (err) {
      logger.error({ err }, "Worker pool initialization failed, continuing without worker threads");
    }
  }

  // Initialize Headroom sidecar (if enabled)
  // This must happen before the server starts accepting requests
  if (config.headroom?.enabled) {
    try {
      const result = await initializeHeadroom();
      if (result.success) {
        logger.info("Headroom sidecar initialized");
      } else {
        logger.warn({ error: result.error }, "Headroom initialization failed, continuing without compression");
      }
    } catch (err) {
      logger.error({ err }, "Headroom initialization error, continuing without compression");
    }
  }

  const app = createApp();

  // Wait for Ollama if it's the configured provider or preferred for routing
  const provider = config.modelProvider?.type?.toLowerCase();
  if (provider === "ollama" || config.modelProvider?.preferOllama) {
    await waitForOllama();
  }

  const server = app.listen(config.port, () => {
    console.log(`Claude→Databricks proxy listening on http://localhost:${config.port}`);
  });

  // Initialize progress server for external tool listening
  const progressServer = initializeProgressServer();
  if (progressServer) {
    const { getProgressEmitter } = require('./progress/emitter');
    getProgressEmitter().on('progress', (event) => progressServer.broadcast(event));
  }

  // Start session cleanup manager
  const { getSessionCleanupManager } = require("./sessions/cleanup");
  const sessionCleanup = getSessionCleanupManager();
  sessionCleanup.start();

  // Setup graceful shutdown
  const shutdownManager = getShutdownManager();
  shutdownManager.registerServer(server);
  shutdownManager.setupSignalHandlers();

  // Register Headroom shutdown callback
  if (config.headroom?.enabled) {
    shutdownManager.onShutdown(async () => {
      logger.info("Stopping Headroom sidecar on shutdown");
      await shutdownHeadroom(false); // Don't remove container on shutdown
    });
  }

  // Register Worker Pool shutdown callback
  if (config.workerPool?.enabled !== false && isWorkerPoolReady()) {
    shutdownManager.onShutdown(async () => {
      logger.info("Stopping worker thread pool on shutdown");
      const pool = getWorkerPool();
      await pool.shutdown();
    });
  }

  // Register Progress Server shutdown callback
  shutdownManager.onShutdown(() => {
    logger.info("Stopping progress WebSocket server on shutdown");
    shutdownProgressServer();
  });

  // Initialize hot reload config watcher
  if (config.hotReload?.enabled !== false) {
    const watcher = initConfigWatcher({
      paths: [".env"],
      debounceMs: config.hotReload?.debounceMs || 1000,
      enabled: true,
    });

    watcher.on("change", (filepath) => {
      try {
        config.reloadConfig();
        logger.info({ filepath }, "Configuration hot-reloaded successfully");
      } catch (err) {
        logger.error({ error: err.message, filepath }, "Failed to hot-reload configuration");
      }
    });

    // Stop watcher on shutdown
    shutdownManager.onShutdown(() => {
      const w = getConfigWatcher();
      if (w) w.stop();
    });
  }

  return server;
}

module.exports = {
  createApp,
  start,
};
