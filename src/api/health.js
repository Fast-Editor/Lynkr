let Database;
try {
  Database = require("better-sqlite3");
} catch {
  Database = null;
}
const { invokeModel } = require("../clients/databricks");
const logger = require("../logger");
const config = require("../config");
const { getHeadroomManager } = require("../headroom");

/**
 * Health check endpoints
 *
 * /health/live - Liveness probe (is process alive?)
 * /health/ready - Readiness probe (can handle traffic?)
 */

// Health status tracking
let isShuttingDown = false;
let healthChecks = {
  database: { healthy: true, lastCheck: Date.now(), error: null },
  databricks: { healthy: true, lastCheck: Date.now(), error: null },
  memory: { healthy: true, lastCheck: Date.now(), error: null },
};

/**
 * Liveness probe - is the process alive?
 * Should return 200 unless the process is deadlocked or unrecoverable
 */
function livenessCheck(req, res) {
  // Simple check - if we can respond, we're alive
  res.status(200).json({
    status: "alive",
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  });
}

/**
 * Readiness probe - can the service handle traffic?
 * Checks all dependencies
 */
async function readinessCheck(req, res) {
  if (isShuttingDown) {
    return res.status(503).json({
      status: "not_ready",
      reason: "shutting_down",
      timestamp: new Date().toISOString(),
    });
  }

  const checks = {};
  let allHealthy = true;

  // Check database
  try {
    checks.database = await checkDatabase();
    if (!checks.database.healthy) allHealthy = false;
  } catch (err) {
    checks.database = { healthy: false, error: err.message };
    allHealthy = false;
  }

  // Check memory
  try {
    checks.memory = checkMemory();
    if (!checks.memory.healthy) allHealthy = false;
  } catch (err) {
    checks.memory = { healthy: false, error: err.message };
    allHealthy = false;
  }

  // Check Headroom (if enabled)
  if (config.headroom?.enabled) {
    try {
      const headroomManager = getHeadroomManager();
      const headroomHealth = await headroomManager.getHealth();
      checks.headroom = {
        healthy: headroomHealth.healthy,
        enabled: headroomHealth.enabled,
        service: headroomHealth.service?.available ? "available" : "unavailable",
        docker: headroomHealth.docker?.running ? "running" : "stopped",
        error: headroomHealth.error,
      };
      // Don't fail overall health if Headroom is unavailable
      // It's a non-critical service - compression will be skipped
      if (!headroomHealth.healthy) {
        checks.headroom.note = "Compression will be skipped";
      }
    } catch (err) {
      checks.headroom = {
        healthy: false,
        error: err.message,
        note: "Compression will be skipped",
      };
    }
  }

  // Optional: Check provider (can be slow)
  if (req.query.deep === "true") {
    const provider = config.modelProvider?.type || "databricks";
    if (provider === "ollama") {
      try {
        checks.ollama = await checkOllama();
        if (!checks.ollama.healthy) allHealthy = false;
      } catch (err) {
        checks.ollama = { healthy: false, error: err.message };
        allHealthy = false;
      }
    } else if (provider === "databricks" || provider === "azure-anthropic") {
      try {
        checks.provider = await checkDatabricks();
        if (!checks.provider.healthy) allHealthy = false;
      } catch (err) {
        checks.provider = { healthy: false, error: err.message };
        allHealthy = false;
      }
    }
  }

  // Update cache
  healthChecks = { ...healthChecks, ...checks };

  const status = allHealthy ? 200 : 503;
  res.status(status).json({
    status: allHealthy ? "ready" : "not_ready",
    timestamp: new Date().toISOString(),
    checks,
  });
}

/**
 * Check database connectivity
 */
async function checkDatabase() {
  try {
    const dbPath = config.sessionStore?.dbPath;
    if (!dbPath) {
      return { healthy: true, note: "No database configured" };
    }

    if (!Database) {
      return { healthy: true, note: "better-sqlite3 not available, skipping database check" };
    }

    // Quick query to verify database is accessible
    const db = new Database(dbPath);
    const result = db.prepare("SELECT 1 as test").get();
    db.close();

    return {
      healthy: result.test === 1,
      lastCheck: Date.now(),
    };
  } catch (err) {
    logger.error({ err }, "Database health check failed");
    return {
      healthy: false,
      error: err.message,
      lastCheck: Date.now(),
    };
  }
}

/**
 * Check Databricks API connectivity (slow, optional)
 */
async function checkDatabricks() {
  try {
    // Simple health check request (or skip if no API configured)
    if (!config.databricks?.url) {
      return { healthy: true, note: "No Databricks URL configured" };
    }

    // Could make a lightweight API call here
    // For now, just check config is present
    return {
      healthy: true,
      lastCheck: Date.now(),
      note: "Configuration present (deep check not implemented)",
    };
  } catch (err) {
    logger.error({ err }, "Databricks health check failed");
    return {
      healthy: false,
      error: err.message,
      lastCheck: Date.now(),
    };
  }
}

/**
 * Check Ollama API connectivity
 */
async function checkOllama() {
  try {
    if (!config.ollama?.endpoint) {
      return { healthy: true, note: "No Ollama endpoint configured" };
    }

    const endpoint = `${config.ollama.endpoint}/api/tags`;
    const response = await fetch(endpoint, {
      method: "GET",
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      return {
        healthy: false,
        error: `Ollama returned status ${response.status}`,
        lastCheck: Date.now(),
      };
    }

    const data = await response.json();
    const hasModel = config.ollama.model
      ? data.models?.some((m) => m.name === config.ollama.model)
      : data.models?.length > 0;

    return {
      healthy: hasModel,
      modelLoaded: hasModel,
      modelCount: data.models?.length || 0,
      configuredModel: config.ollama.model,
      lastCheck: Date.now(),
      error: hasModel ? null : `Model ${config.ollama.model} not found`,
    };
  } catch (err) {
    logger.error({ err }, "Ollama health check failed");
    return {
      healthy: false,
      error: err.message,
      lastCheck: Date.now(),
    };
  }
}

/**
 * Check memory usage
 */
function checkMemory() {
  const usage = process.memoryUsage();
  const heapUsedMB = usage.heapUsed / 1024 / 1024;
  const heapTotalMB = usage.heapTotal / 1024 / 1024;
  const heapUsedPercent = (heapUsedMB / heapTotalMB) * 100;

  // Consider unhealthy if using >90% of heap
  const healthy = heapUsedPercent < 90;

  return {
    healthy,
    heapUsedMB: Math.round(heapUsedMB),
    heapTotalMB: Math.round(heapTotalMB),
    heapUsedPercent: Math.round(heapUsedPercent),
    lastCheck: Date.now(),
  };
}

/**
 * Set shutting down flag
 */
function setShuttingDown(value) {
  isShuttingDown = value;
}

/**
 * Get shutting down flag
 */
function getShuttingDown() {
  return isShuttingDown;
}

module.exports = {
  livenessCheck,
  readinessCheck,
  setShuttingDown,
  getShuttingDown,
};
