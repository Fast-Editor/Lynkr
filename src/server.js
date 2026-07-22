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
const { tenantMiddleware } = require("./api/middleware/tenant");
const { budgetEnforcer } = require("./api/middleware/budget-enforcer");
const { livenessCheck, readinessCheck } = require("./api/health");
const { getMetricsCollector } = require("./observability/metrics");
const { getShutdownManager } = require("./server/shutdown");
const { getCircuitBreakerRegistry } = require("./clients/circuit-breaker");
const metrics = require("./metrics");
const logger = require("./logger");
const { initialiseMcp } = require("./mcp");
const { initConfigWatcher, getConfigWatcher } = require("./config/watcher");
const { initializeHeadroom, shutdownHeadroom, getHeadroomManager } = require("./headroom");
const { getWorkerPool, isWorkerPoolReady } = require("./workers/pool");
const { waitForOllama } = require("./clients/ollama-startup");

initialiseMcp();

function createApp() {
  const app = express();
  const path = require('path');
  const fs   = require('fs');

  // Dashboard — registered first so it is never shadowed by the main router
  const DASHBOARD_HTML = path.resolve(__dirname, '../public/dashboard.html');
  app.get('/dashboard', (_req, res) => {
    try {
      const html = fs.readFileSync(DASHBOARD_HTML, 'utf8');
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(html);
    } catch (e) {
      res.status(500).json({ error: 'dashboard_read_failed', path: DASHBOARD_HTML, detail: e.message });
    }
  });
  app.get('/dashboard/api/overview', require('./dashboard/api').overview);
  app.get('/dashboard/api/usage',    require('./dashboard/api').usage);
  app.get('/dashboard/api/routing',  require('./dashboard/api').routing);
  app.get('/dashboard/api/logs',     require('./dashboard/api').logs);

  initializeLoadShedder();

  app.use(loadSheddingMiddleware);

  // Request logging (add request IDs, structured logs)
  app.use(requestLoggingMiddleware);

  app.use(metricsMiddleware);

  // Note: If using a tunnel (ngrok, Cloudflare Tunnel) and seeing BrotliDecompressionError,
  // start ngrok with: ngrok http 8081 --request-header-remove "Accept-Encoding"

  app.use(express.json({ limit: config.server.jsonLimit }));
  app.use(sessionMiddleware);
  app.use(loggingMiddleware);

  // Agent-framework endpoints: LangGraph/CrewAI/AutoGen talk to the
  // OpenAI-compat surface, Claude Code to /v1/messages. Guards that protect
  // against runaway agents must cover BOTH — mounting on /v1/messages only
  // silently exempts every OpenAI-compat client (this bit us with client
  // profiles already).
  const AGENT_ENDPOINTS = ['/v1/messages', '/v1/chat/completions', '/v1/responses'];

  // Loop guard — stateless runaway-agent circuit breaker
  // (LYNKR_MAX_SESSION_TURNS / LYNKR_MAX_TOOL_TURNS; off unless set).
  const { loopGuard } = require('./api/middleware/loop-guard');
  for (const p of AGENT_ENDPOINTS) app.use(p, loopGuard);

  // Budget and rate limiting (can be disabled via config)
  if (config.budget?.enabled !== false) {
    for (const p of AGENT_ENDPOINTS) app.use(p, budgetMiddleware);
  }

  // Phase 6.1 — per-tenant routing policies (LYNKR-Tenant-Id header).
  // Runs before message handling so res.locals.tenantPolicy is populated.
  app.use('/v1/messages', tenantMiddleware);

  // Phase 6.2 — hierarchical budget enforcement (LYNKR_BUDGET_ENFORCER=false to disable).
  for (const p of AGENT_ENDPOINTS) app.use(p, budgetEnforcer);

  app.get("/health/live", livenessCheck);
  app.get("/health/ready", readinessCheck);

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

  app.use(router);

  app.use('/dashboard', require('./dashboard/router'));

  const filesRouter = require("./api/files-router");
  app.use("/v1", filesRouter);

  // 404 handler (must be after all routes)
  app.use(notFoundHandler);

  // Error handler (must be last)
  app.use(errorHandlingMiddleware);

  return app;
}

async function start() {
  // Pre-warms worker threads for CPU-intensive tasks
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

  // Wait for Ollama if it's the configured provider or referenced in tier config
  const provider = config.modelProvider?.type?.toLowerCase();
  if (provider === "ollama" || config.tiersReferenceOllama()) {
    await waitForOllama();

    // Pre-probe Ollama's Anthropic API at startup (avoids 1-3s cold-start on first request)
    try {
      const { hasAnthropicEndpoint } = require("./clients/ollama-utils");
      await hasAnthropicEndpoint(config.ollama.endpoint);
    } catch (err) {
      logger.debug({ err: err.message }, "Ollama Anthropic endpoint probe failed at startup");
    }
  }

  const server = app.listen(config.port, () => {
    console.log(`Claude→Databricks proxy listening on http://localhost:${config.port}`);
  });

  // Classifier bootstrap check — non-blocking, log-only.
  // Detects ollama + confirms the classifier model is pulled. Never auto-
  // installs (that's `lynkr init`'s job); warns and lets scoring fall back
  // to anchor-only if either is missing.
  (async () => {
    try {
      const { ensureClassifierReady } = require('./routing/classifier-setup');
      const result = await ensureClassifierReady({
        mode: 'boot',
        log: (m) => logger.info(m),
        warn: (m) => logger.warn(m),
      });
      if (result.ready) {
        logger.info({ classifier: 'ready', warmed: result.warmed }, '[classifier-setup] Difficulty classifier ready');
      }
    } catch (err) {
      logger.debug({ err: err.message }, '[classifier-setup] bootstrap check failed (classifier will fall back)');
    }
  })();

  // Start session cleanup manager. It also drives routing-side maintenance
  // (telemetry retention + session-pin TTL) via its runCleanup tick — see
  // src/sessions/cleanup.js.
  const { getSessionCleanupManager } = require("./sessions/cleanup");
  const sessionCleanup = getSessionCleanupManager();
  sessionCleanup.start();

  // WS5.7 — auto-calibration scheduler.
  //
  // Recomputes `data/calibrated-thresholds.json` from live telemetry every
  // 24 h and hot-reloads the model-tier selector so the update takes
  // effect without a restart. First run is jittered 30–90 min into the
  // process lifetime so a cluster of proxies won't all recalibrate at the
  // same moment. When telemetry is sparse (<100 rows in-window), the
  // calibration step no-ops itself via `runCalibration`'s
  // `insufficient_samples` skip path. Unconditionally armed — the pre-B
  // `LYNKR_AUTO_CALIBRATE` env flag was removed because the "off" state
  // was never useful in prod (calibration is idempotent and self-gating).
  {
    const { runCalibration } = require('./routing/calibration');
    const { reloadCalibratedThresholds } = require('./routing/model-tiers');
    const degradation = require('./routing/degradation');
    const DAY_MS = 24 * 60 * 60 * 1000;
    const FIRST_RUN_MIN_MS = 30 * 60 * 1000;
    const FIRST_RUN_JITTER_MS = 60 * 60 * 1000;
    const firstDelay = FIRST_RUN_MIN_MS + Math.floor(Math.random() * FIRST_RUN_JITTER_MS);

    const runOnce = () => {
      try {
        const result = runCalibration({ days: 7 });
        if (result.skipped) {
          logger.info({ reason: result.reason, count: result.count }, '[Calibration] Skipped');
          return;
        }
        const before = reloadCalibratedThresholds();
        logger.info({
          calibratedAt: result.calibratedAt,
          sampleCount: result.sampleCount,
          ranges: result.ranges,
          previousRanges: before,
        }, '[Calibration] Ranges refreshed');
      } catch (err) {
        degradation.record('calibration', err);
      }
    };

    const firstTimer = setTimeout(() => {
      runOnce();
      const interval = setInterval(runOnce, DAY_MS);
      interval.unref();
    }, firstDelay);
    firstTimer.unref();
    logger.info({ firstDelayMs: firstDelay, intervalMs: DAY_MS }, '[Calibration] Scheduler armed');
  }

  const shutdownManager = getShutdownManager();
  shutdownManager.registerServer(server);
  shutdownManager.setupSignalHandlers();

  if (config.headroom?.enabled) {
    shutdownManager.onShutdown(async () => {
      logger.info("Stopping Headroom sidecar on shutdown");
      await shutdownHeadroom(false); // Don't remove container on shutdown
    });
  }

  if (config.workerPool?.enabled !== false && isWorkerPoolReady()) {
    shutdownManager.onShutdown(async () => {
      logger.info("Stopping worker thread pool on shutdown");
      const pool = getWorkerPool();
      await pool.shutdown();
    });
  }

  shutdownManager.onShutdown(async () => {
    try {
      const { getCodexProcess } = require("./clients/codex-process");
      const codex = getCodexProcess();
      if (codex.child) {
        await codex.shutdown();
      }
    } catch { /* ignore if codex never started */ }
  });

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
