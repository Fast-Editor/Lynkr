const logger = require("../logger");
const { setShuttingDown } = require("../api/health");
const { getBudgetManager } = require("../budget");

/**
 * Graceful Shutdown Handler
 *
 * Performance considerations:
 * - Non-blocking shutdown sequence
 * - Timeout protection
 * - Clean resource cleanup
 */

const DEFAULT_SHUTDOWN_TIMEOUT = 30000; // 30 seconds

class ShutdownManager {
  constructor(options = {}) {
    this.timeout = options.timeout || DEFAULT_SHUTDOWN_TIMEOUT;
    this.isShuttingDown = false;
    this.server = null;
    this.connections = new Set();
    this.shutdownCallbacks = [];
  }

  /**
   * Register a callback to be called during shutdown
   */
  onShutdown(callback) {
    if (typeof callback === 'function') {
      this.shutdownCallbacks.push(callback);
    }
  }

  /**
   * Register HTTP server
   */
  registerServer(server) {
    this.server = server;

    // Track all connections
    server.on("connection", (conn) => {
      this.connections.add(conn);

      conn.on("close", () => {
        this.connections.delete(conn);
      });
    });
  }

  /**
   * Setup signal handlers
   */
  setupSignalHandlers() {
    // Handle SIGTERM (Kubernetes, Docker, etc.)
    process.on("SIGTERM", () => {
      logger.info("Received SIGTERM, starting graceful shutdown");
      this.shutdown("SIGTERM");
    });

    // Handle SIGINT (Ctrl+C)
    process.on("SIGINT", () => {
      logger.info("Received SIGINT, starting graceful shutdown");
      this.shutdown("SIGINT");
    });

    // Handle uncaught exceptions
    process.on("uncaughtException", (err) => {
      logger.error({ err }, "Uncaught exception, forcing shutdown");
      this.forceShutdown("uncaughtException");
    });

    // Handle unhandled rejections
    process.on("unhandledRejection", (reason, promise) => {
      logger.error({ reason, promise }, "Unhandled rejection, forcing shutdown");
      this.forceShutdown("unhandledRejection");
    });
  }

  /**
   * Graceful shutdown sequence
   */
  async shutdown(signal) {
    if (this.isShuttingDown) {
      logger.warn("Shutdown already in progress");
      return;
    }

    this.isShuttingDown = true;
    setShuttingDown(true);

    const startTime = Date.now();
    logger.info({ signal }, "Starting graceful shutdown");

    // Set timeout for forced shutdown
    const forceTimer = setTimeout(() => {
      logger.error("Shutdown timeout exceeded, forcing exit");
      this.forceShutdown("timeout");
    }, this.timeout);

    try {
      // Step 1: Stop accepting new connections
      logger.info("Step 1: Stopping new connections");
      if (this.server) {
        await new Promise((resolve) => {
          this.server.close(() => {
            logger.info("Server stopped accepting new connections");
            resolve();
          });
        });
      }

      // Step 2: Close idle connections
      logger.info(`Step 2: Closing ${this.connections.size} active connections`);
      for (const conn of this.connections) {
        if (!conn.destroyed) {
          conn.destroy();
        }
      }

      // Step 3: Stop background tasks
      logger.info("Step 3: Stopping background tasks");
      try {
        const { getSessionCleanupManager } = require("../sessions/cleanup");
        const sessionCleanup = getSessionCleanupManager();
        if (sessionCleanup) {
          sessionCleanup.stop();
        }
      } catch (err) {
        logger.warn({ err }, "Error stopping session cleanup");
      }

      // Step 4: Close cache databases
      logger.info("Step 4: Closing cache databases");
      try {
        const promptCache = require("../cache/prompt");
        if (promptCache && typeof promptCache.close === 'function') {
          promptCache.close();
        }
      } catch (err) {
        logger.warn({ err }, "Error closing prompt cache");
      }

      // Step 5: Close database connections
      logger.info("Step 5: Closing database connections");
      try {
        const budgetManager = getBudgetManager();
        if (budgetManager) {
          budgetManager.close();
        }
      } catch (err) {
        logger.warn({ err }, "Error closing budget manager");
      }

 
      // Step 6: Destroy HTTP agents
      logger.info("Step 6: Destroying HTTP agents");
      try {
        const databricks = require("../clients/databricks");
        if (databricks && typeof databricks.destroyHttpAgents === 'function') {
          databricks.destroyHttpAgents();
        }
      } catch (err) {
        logger.warn({ err }, "Error destroying HTTP agents");
      }

      // Step 7: Final cleanup
      logger.info("Step 7: Final cleanup");
      clearTimeout(forceTimer);

      const duration = Date.now() - startTime;
      logger.info({ duration }, "Graceful shutdown completed successfully");

      process.exit(0);
    } catch (err) {
      logger.error({ err }, "Error during graceful shutdown");
      clearTimeout(forceTimer);
      this.forceShutdown("error");
    }
  }

  /**
   * Force shutdown (immediate)
   */
  forceShutdown(reason) {
    logger.error({ reason }, "Forcing immediate shutdown");

    // Try to close budget manager
    try {
      const budgetManager = getBudgetManager();
      if (budgetManager) {
        budgetManager.close();
      }
    } catch (err) {
      // Ignore errors during force shutdown
    }

    process.exit(1);
  }
}

// Singleton instance
let instance = null;

function getShutdownManager(options) {
  if (!instance) {
    instance = new ShutdownManager(options);
  }
  return instance;
}

module.exports = {
  ShutdownManager,
  getShutdownManager,
};
