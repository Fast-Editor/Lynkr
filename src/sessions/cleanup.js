const logger = require("../logger");
const { cleanupOldSessions, cleanupOldHistory } = require("./store");

class SessionCleanupManager {
  constructor(options = {}) {
    this.enabled = options.enabled !== false;
    this.intervalMs = options.intervalMs || 300000; // 5 minutes (was 1 hour)
    this.sessionMaxAgeMs = options.sessionMaxAgeMs || 24 * 60 * 60 * 1000; // 1 day (was 7 days)
    this.historyMaxAgeMs = options.historyMaxAgeMs || 7 * 24 * 60 * 60 * 1000; // 7 days (was 30 days)
    this.timer = null;
  }

  start() {
    if (!this.enabled || this.timer) return;

    this.runCleanup(); // Run immediately

    this.timer = setInterval(() => this.runCleanup(), this.intervalMs);
    this.timer.unref();

    logger.info({
      intervalMs: this.intervalMs,
      sessionMaxAgeMs: this.sessionMaxAgeMs
    }, "Session cleanup started");
  }

  runCleanup() {
    try {
      const sessionsDeleted = cleanupOldSessions(this.sessionMaxAgeMs);
      const historyDeleted = cleanupOldHistory(this.historyMaxAgeMs);
      logger.info({ sessionsDeleted, historyDeleted }, "Session cleanup completed");
    } catch (error) {
      logger.error({ error }, "Session cleanup failed");
    }
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      logger.info("Session cleanup stopped");
    }
  }
}

let instance = null;

function getSessionCleanupManager(options) {
  if (!instance) instance = new SessionCleanupManager(options);
  return instance;
}

module.exports = { SessionCleanupManager, getSessionCleanupManager };
