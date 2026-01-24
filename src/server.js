const express = require("express");
const compression = require("compression");
const config = require("./config");
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

initialiseMcp();
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

  app.use(router);

  // 404 handler (must be after all routes)
  app.use(notFoundHandler);

  // Error handler (must be last)
  app.use(errorHandlingMiddleware);

  return app;
}

async function start() {
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
  const server = app.listen(config.port, () => {
    console.log(`Claude→Databricks proxy listening on http://localhost:${config.port}`);
  });

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
