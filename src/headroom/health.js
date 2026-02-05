/**
 * Headroom Health Check Module
 *
 * Provides health check functionality for the Headroom sidecar,
 * including container status and service availability checks.
 */

const logger = require("../logger");
const config = require("../config");
const launcher = require("./launcher");
const client = require("./client");

// Cached health status
let lastHealthCheck = null;
let lastCheckTime = 0;
const CACHE_TTL_MS = 5000; // Cache health status for 5 seconds

/**
 * Perform a comprehensive health check on the Headroom system
 */
async function checkHeadroomHealth() {
  const headroomConfig = config.headroom;
  const now = Date.now();

  // Return cached result if still valid
  if (lastHealthCheck && now - lastCheckTime < CACHE_TTL_MS) {
    return lastHealthCheck;
  }

  const result = {
    enabled: headroomConfig?.enabled === true,
    healthy: false,
    timestamp: new Date().toISOString(),
    docker: null,
    service: null,
    error: null,
  };

  if (!result.enabled) {
    result.healthy = true; // Disabled is considered "healthy" for the overall system
    result.note = "Headroom is disabled";
    lastHealthCheck = result;
    lastCheckTime = now;
    return result;
  }

  try {
    // Check Docker container status (if Docker management is enabled)
    if (headroomConfig.docker?.enabled) {
      const containerStatus = await launcher.getStatus();
      result.docker = {
        exists: containerStatus.exists,
        running: containerStatus.running,
        status: containerStatus.status,
        health: containerStatus.health,
        id: containerStatus.id,
        image: containerStatus.image,
      };
    }

    // Check HTTP service health
    const serviceHealth = await client.checkHealth();
    result.service = serviceHealth;

    // Determine overall health
    if (serviceHealth.available) {
      result.healthy = true;
    } else if (headroomConfig.docker?.enabled && result.docker?.running) {
      // Container is running but service not responding - might be starting up
      result.healthy = false;
      result.error = "Container running but service not responding";
    } else {
      result.healthy = false;
      result.error = serviceHealth.reason || "Service unavailable";
    }
  } catch (err) {
    result.healthy = false;
    result.error = err.message;
    logger.error({ err }, "Headroom health check failed");
  }

  lastHealthCheck = result;
  lastCheckTime = now;

  return result;
}

/**
 * Simple availability check (faster than full health check)
 */
async function isAvailable() {
  if (!config.headroom?.enabled) {
    return false;
  }

  const health = await client.checkHealth();
  return health.available === true;
}

/**
 * Wait for Headroom to become available
 */
async function waitForAvailable(maxWaitMs = 30000, intervalMs = 1000) {
  const startTime = Date.now();

  while (Date.now() - startTime < maxWaitMs) {
    if (await isAvailable()) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  return false;
}

/**
 * Get detailed status for debugging/monitoring
 */
async function getDetailedStatus() {
  const health = await checkHeadroomHealth();
  const metrics = await client.getCombinedMetrics();

  let containerLogs = null;
  if (config.headroom?.docker?.enabled) {
    containerLogs = await launcher.getLogs(50);
  }

  return {
    health,
    metrics,
    config: {
      enabled: config.headroom?.enabled,
      endpoint: config.headroom?.endpoint,
      mode: config.headroom?.mode,
      minTokens: config.headroom?.minTokens,
      docker: config.headroom?.docker?.enabled
        ? {
            enabled: true,
            image: config.headroom.docker.image,
            containerName: config.headroom.docker.containerName,
            port: config.headroom.docker.port,
          }
        : { enabled: false },
    },
    recentLogs: containerLogs ? containerLogs.split("\n").slice(-20) : null,
  };
}

/**
 * Clear cached health check result
 */
function clearCache() {
  lastHealthCheck = null;
  lastCheckTime = 0;
}

module.exports = {
  checkHeadroomHealth,
  isAvailable,
  waitForAvailable,
  getDetailedStatus,
  clearCache,
};
