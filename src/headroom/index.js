/**
 * Headroom Sidecar Integration
 *
 * Main entry point for Headroom functionality in Lynkr.
 * Provides singleton manager for container lifecycle and compression operations.
 */

const logger = require("../logger");
const config = require("../config");
const launcher = require("./launcher");
const client = require("./client");
const health = require("./health");

/**
 * HeadroomManager - Singleton for managing Headroom sidecar lifecycle
 */
class HeadroomManager {
  constructor() {
    this.initialized = false;
    this.startupError = null;
  }

  /**
   * Initialize the Headroom system
   * Starts the Docker container if enabled and waits for it to be healthy
   */
  async initialize() {
    if (this.initialized) {
      return { success: true, alreadyInitialized: true };
    }

    const headroomConfig = config.headroom;

    if (!headroomConfig?.enabled) {
      logger.info("Headroom compression is disabled");
      this.initialized = true;
      return { success: true, enabled: false };
    }

    logger.info(
      {
        endpoint: headroomConfig.endpoint,
        mode: headroomConfig.mode,
        dockerEnabled: headroomConfig.docker?.enabled,
      },
      "Initializing Headroom sidecar"
    );

    try {
      // Start Docker container if enabled
      if (headroomConfig.docker?.enabled) {
        const result = await launcher.ensureRunning();
        logger.info({ action: result.action }, "Headroom container ready");
      } else {
        // Docker not enabled, just wait for external sidecar
        logger.info("Docker management disabled, waiting for external Headroom sidecar");
        const available = await health.waitForAvailable(10000, 500);

        if (!available) {
          throw new Error(`Headroom sidecar not available at ${headroomConfig.endpoint}`);
        }
      }

      // Verify service is healthy
      const healthCheck = await health.checkHeadroomHealth();

      if (!healthCheck.healthy) {
        throw new Error(`Headroom not healthy: ${healthCheck.error}`);
      }

      logger.info(
        {
          ccrEnabled: healthCheck.service?.ccrEnabled,
          llmlinguaEnabled: healthCheck.service?.llmlinguaEnabled,
        },
        "Headroom sidecar initialized successfully"
      );

      this.initialized = true;
      return { success: true, health: healthCheck };
    } catch (err) {
      this.startupError = err;
      logger.error({ err }, "Failed to initialize Headroom sidecar");

      // Don't throw - allow Lynkr to start without Headroom
      // Compression will be skipped if Headroom is unavailable
      this.initialized = true;
      return { success: false, error: err.message };
    }
  }

  /**
   * Shutdown the Headroom system
   * Stops the Docker container if we started it
   */
  async shutdown(removeContainer = false) {
    if (!config.headroom?.enabled) {
      return;
    }

    logger.info("Shutting down Headroom sidecar");

    try {
      if (config.headroom.docker?.enabled) {
        await launcher.stop(removeContainer);
      }
      logger.info("Headroom sidecar shutdown complete");
    } catch (err) {
      logger.error({ err }, "Error during Headroom shutdown");
    }
  }

  /**
   * Compress messages if Headroom is available
   * Falls back to original messages if compression fails
   */
  async compress(messages, tools = [], options = {}) {
    return client.compressMessages(messages, tools, options);
  }

  /**
   * Retrieve content from CCR store
   */
  async ccrRetrieve(hash, query = null, maxResults = 20) {
    return client.ccrRetrieve(hash, query, maxResults);
  }

  /**
   * Track compression for proactive expansion
   */
  async ccrTrack(hashKey, turnNumber, toolName, sample) {
    return client.ccrTrack(hashKey, turnNumber, toolName, sample);
  }

  /**
   * Analyze query for proactive CCR expansion
   */
  async ccrAnalyze(query, turnNumber) {
    return client.ccrAnalyze(query, turnNumber);
  }

  /**
   * Check if Headroom is enabled
   */
  isEnabled() {
    return client.isEnabled();
  }

  /**
   * Check if Headroom is available and healthy
   */
  async isAvailable() {
    return health.isAvailable();
  }

  /**
   * Get health status
   */
  async getHealth() {
    return health.checkHeadroomHealth();
  }

  /**
   * Get metrics
   */
  async getMetrics() {
    return client.getCombinedMetrics();
  }

  /**
   * Get detailed status for debugging
   */
  async getDetailedStatus() {
    return health.getDetailedStatus();
  }

  /**
   * Restart the Headroom container
   */
  async restart() {
    if (!config.headroom?.docker?.enabled) {
      throw new Error("Docker management is disabled");
    }
    return launcher.restart();
  }

  /**
   * Get container logs
   */
  async getLogs(tail = 100) {
    if (!config.headroom?.docker?.enabled) {
      return null;
    }
    return launcher.getLogs(tail);
  }
}

// Singleton instance
let instance = null;

/**
 * Get the HeadroomManager singleton instance
 */
function getHeadroomManager() {
  if (!instance) {
    instance = new HeadroomManager();
  }
  return instance;
}

/**
 * Initialize Headroom (convenience function)
 */
async function initializeHeadroom() {
  const manager = getHeadroomManager();
  return manager.initialize();
}

/**
 * Shutdown Headroom (convenience function)
 */
async function shutdownHeadroom(removeContainer = false) {
  if (instance) {
    return instance.shutdown(removeContainer);
  }
}

module.exports = {
  HeadroomManager,
  getHeadroomManager,
  initializeHeadroom,
  shutdownHeadroom,
  // Re-export commonly used functions
  isEnabled: client.isEnabled,
  compressMessages: client.compressMessages,
  ccrRetrieve: client.ccrRetrieve,
  checkHealth: client.checkHealth,
  getMetrics: client.getMetrics,
  getCombinedMetrics: client.getCombinedMetrics,
};
