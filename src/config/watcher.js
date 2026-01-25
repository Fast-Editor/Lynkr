/**
 * Configuration Hot Reload Watcher
 *
 * Watches .env and config files for changes and triggers reload without restart.
 * Uses chokidar for cross-platform file watching with debouncing.
 *
 * @module config/watcher
 */

const path = require("path");
const fs = require("fs");
const EventEmitter = require("events");
const logger = require("../logger");

// Try to use chokidar if available, otherwise use fs.watch fallback
let chokidar;
try {
  chokidar = require("chokidar");
} catch {
  chokidar = null;
}

class ConfigWatcher extends EventEmitter {
  constructor(options = {}) {
    super();
    this.watchPaths = options.paths || [".env"];
    this.debounceMs = options.debounceMs || 1000;
    this.watcher = null;
    this.debounceTimer = null;
    this.enabled = options.enabled !== false;
    this.lastReloadTime = 0;
  }

  /**
   * Start watching configuration files
   */
  start() {
    if (!this.enabled) {
      logger.info({}, "Hot reload disabled");
      return;
    }

    // Resolve paths relative to project root
    const projectRoot = process.cwd();
    const resolvedPaths = this.watchPaths
      .map(p => path.resolve(projectRoot, p))
      .filter(p => {
        const exists = fs.existsSync(p);
        if (!exists) {
          logger.debug({ path: p }, "Config watch path does not exist, skipping");
        }
        return exists;
      });

    if (resolvedPaths.length === 0) {
      logger.warn({}, "No config files found to watch");
      return;
    }

    if (chokidar) {
      this._startWithChokidar(resolvedPaths);
    } else {
      this._startWithFsWatch(resolvedPaths);
    }

    logger.info({
      paths: resolvedPaths,
      debounceMs: this.debounceMs,
      useChokidar: !!chokidar,
    }, "Config watcher started");
  }

  /**
   * Start watching with chokidar (preferred)
   */
  _startWithChokidar(paths) {
    this.watcher = chokidar.watch(paths, {
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: 500,
        pollInterval: 100,
      },
    });

    this.watcher.on("change", (filepath) => {
      this._handleChange(filepath);
    });

    this.watcher.on("error", (error) => {
      logger.error({ error: error.message }, "Config watcher error");
    });
  }

  /**
   * Fallback to fs.watch if chokidar not available
   */
  _startWithFsWatch(paths) {
    this.watchers = [];

    for (const filepath of paths) {
      try {
        const watcher = fs.watch(filepath, (eventType) => {
          if (eventType === "change") {
            this._handleChange(filepath);
          }
        });
        this.watchers.push(watcher);
      } catch (err) {
        logger.warn({ path: filepath, error: err.message }, "Failed to watch config file");
      }
    }
  }

  /**
   * Handle file change with debouncing
   */
  _handleChange(filepath) {
    // Debounce rapid changes (e.g., editors saving multiple times)
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    this.debounceTimer = setTimeout(() => {
      // Prevent reload if too recent
      const now = Date.now();
      if (now - this.lastReloadTime < 500) {
        logger.debug({ filepath }, "Ignoring config change (too recent)");
        return;
      }
      this.lastReloadTime = now;

      logger.info({ filepath }, "Config file changed, triggering reload");
      this.emit("change", filepath);
    }, this.debounceMs);
  }

  /**
   * Stop watching files
   */
  stop() {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }

    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }

    if (this.watchers) {
      for (const w of this.watchers) {
        w.close();
      }
      this.watchers = null;
    }

    logger.info({}, "Config watcher stopped");
  }
}

// Singleton instance
let watcherInstance = null;

/**
 * Get or create the config watcher singleton
 */
function getConfigWatcher(options = {}) {
  if (!watcherInstance) {
    watcherInstance = new ConfigWatcher(options);
  }
  return watcherInstance;
}

/**
 * Initialize and start the config watcher
 */
function initConfigWatcher(options = {}) {
  const watcher = getConfigWatcher(options);
  watcher.start();
  return watcher;
}

module.exports = {
  ConfigWatcher,
  getConfigWatcher,
  initConfigWatcher,
};
