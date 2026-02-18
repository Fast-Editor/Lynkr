let Database;
try {
  Database = require('better-sqlite3');
} catch {
  Database = null;
}
const path = require('path');
const fs = require('fs');
const logger = require('../logger');

class BudgetManager {
  constructor(options = {}) {
    this.enabled = options.enabled !== false;
    if (!this.enabled || !Database) {
      this.enabled = false;
      return;
    }

    try {
      const dbPath = path.join(process.cwd(), 'data', 'budgets.db');
      const dbDir = path.dirname(dbPath);

      if (!fs.existsSync(dbDir)) {
        fs.mkdirSync(dbDir, { recursive: true });
      }

      this.db = new Database(dbPath);
      this.initDatabase();
      logger.info({ dbPath }, 'Budget manager initialized');
    } catch (err) {
      logger.warn({ err: err.message }, "BudgetManager: better-sqlite3 not available");
      this.enabled = false;
      return;
    }

   
  }

  initDatabase() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS user_budgets (
        user_id TEXT PRIMARY KEY,
        monthly_token_limit INTEGER NOT NULL DEFAULT 1000000,
        monthly_request_limit INTEGER NOT NULL DEFAULT 10000,
        monthly_cost_limit REAL NOT NULL DEFAULT 100.0,
        alert_threshold REAL NOT NULL DEFAULT 0.8,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS usage_tracking (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        session_id TEXT,
        timestamp INTEGER NOT NULL,
        tokens_input INTEGER NOT NULL DEFAULT 0,
        tokens_output INTEGER NOT NULL DEFAULT 0,
        tokens_total INTEGER NOT NULL DEFAULT 0,
        cost_usd REAL NOT NULL DEFAULT 0.0,
        model TEXT,
        endpoint TEXT,
        latency_ms INTEGER
      );

      CREATE INDEX IF NOT EXISTS idx_usage_user_time ON usage_tracking(user_id, timestamp);
      CREATE INDEX IF NOT EXISTS idx_usage_session ON usage_tracking(session_id);

      CREATE TABLE IF NOT EXISTS rate_limits (
        user_id TEXT PRIMARY KEY,
        requests_per_minute INTEGER NOT NULL DEFAULT 60,
        requests_per_hour INTEGER NOT NULL DEFAULT 1000,
        last_request_time INTEGER,
        request_count_minute INTEGER DEFAULT 0,
        request_count_hour INTEGER DEFAULT 0,
        minute_window_start INTEGER,
        hour_window_start INTEGER
      );
    `);

    // Prepared statements
    this.stmts = {
      getBudget: this.db.prepare('SELECT * FROM user_budgets WHERE user_id = ?'),
      createBudget: this.db.prepare(`
        INSERT INTO user_budgets (user_id, monthly_token_limit, monthly_request_limit, monthly_cost_limit, alert_threshold, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `),
      updateBudget: this.db.prepare(`
        UPDATE user_budgets
        SET monthly_token_limit = ?, monthly_request_limit = ?, monthly_cost_limit = ?, alert_threshold = ?, updated_at = ?
        WHERE user_id = ?
      `),
      recordUsage: this.db.prepare(`
        INSERT INTO usage_tracking (user_id, session_id, timestamp, tokens_input, tokens_output, tokens_total, cost_usd, model, endpoint, latency_ms)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `),
      getMonthlyUsage: this.db.prepare(`
        SELECT
          COUNT(*) as request_count,
          SUM(tokens_total) as total_tokens,
          SUM(cost_usd) as total_cost
        FROM usage_tracking
        WHERE user_id = ? AND timestamp >= ?
      `),
      getRateLimit: this.db.prepare('SELECT * FROM rate_limits WHERE user_id = ?'),
      upsertRateLimit: this.db.prepare(`
        INSERT INTO rate_limits (user_id, requests_per_minute, requests_per_hour, last_request_time, request_count_minute, request_count_hour, minute_window_start, hour_window_start)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id) DO UPDATE SET
          last_request_time = excluded.last_request_time,
          request_count_minute = excluded.request_count_minute,
          request_count_hour = excluded.request_count_hour,
          minute_window_start = excluded.minute_window_start,
          hour_window_start = excluded.hour_window_start
      `),
    };
  }

  // Check if user is within rate limits
  checkRateLimit(userId) {
    if (!this.enabled) return { allowed: true };

    const now = Date.now();
    const rateLimit = this.stmts.getRateLimit.get(userId);

    if (!rateLimit) {
      // No rate limit set, create default
      this.stmts.upsertRateLimit.run(
        userId, 60, 1000, now, 1, 1, now, now
      );
      return { allowed: true };
    }

    const minuteWindow = 60 * 1000; // 1 minute
    const hourWindow = 60 * 60 * 1000; // 1 hour

    let { request_count_minute, request_count_hour, minute_window_start, hour_window_start } = rateLimit;

    // Reset minute window if needed
    if (now - minute_window_start >= minuteWindow) {
      request_count_minute = 0;
      minute_window_start = now;
    }

    // Reset hour window if needed
    if (now - hour_window_start >= hourWindow) {
      request_count_hour = 0;
      hour_window_start = now;
    }

    // Check limits
    if (request_count_minute >= rateLimit.requests_per_minute) {
      const resetIn = minuteWindow - (now - minute_window_start);
      return {
        allowed: false,
        reason: 'rate_limit_minute',
        limit: rateLimit.requests_per_minute,
        current: request_count_minute,
        resetInMs: resetIn,
      };
    }

    if (request_count_hour >= rateLimit.requests_per_hour) {
      const resetIn = hourWindow - (now - hour_window_start);
      return {
        allowed: false,
        reason: 'rate_limit_hour',
        limit: rateLimit.requests_per_hour,
        current: request_count_hour,
        resetInMs: resetIn,
      };
    }

    // Increment counters
    request_count_minute++;
    request_count_hour++;

    this.stmts.upsertRateLimit.run(
      userId,
      rateLimit.requests_per_minute,
      rateLimit.requests_per_hour,
      now,
      request_count_minute,
      request_count_hour,
      minute_window_start,
      hour_window_start
    );

    return { allowed: true };
  }

  // Check if user is within budget
  checkBudget(userId) {
    if (!this.enabled) return { allowed: true };

    const budget = this.stmts.getBudget.get(userId);

    if (!budget) {
      // No budget set, allow with default
      return { allowed: true, warning: 'No budget configured' };
    }

    // Get current month usage
    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);
    const monthStartMs = monthStart.getTime();

    const usage = this.stmts.getMonthlyUsage.get(userId, monthStartMs);

    // Check token limit
    if (usage.total_tokens >= budget.monthly_token_limit) {
      return {
        allowed: false,
        reason: 'token_limit_exceeded',
        limit: budget.monthly_token_limit,
        current: usage.total_tokens,
      };
    }

    // Check request limit
    if (usage.request_count >= budget.monthly_request_limit) {
      return {
        allowed: false,
        reason: 'request_limit_exceeded',
        limit: budget.monthly_request_limit,
        current: usage.request_count,
      };
    }

    // Check cost limit
    if (usage.total_cost >= budget.monthly_cost_limit) {
      return {
        allowed: false,
        reason: 'cost_limit_exceeded',
        limit: budget.monthly_cost_limit,
        current: usage.total_cost,
      };
    }

    // Check if approaching limits (alert threshold)
    const warnings = [];
    if (usage.total_tokens / budget.monthly_token_limit >= budget.alert_threshold) {
      warnings.push({
        type: 'token_alert',
        percentage: (usage.total_tokens / budget.monthly_token_limit * 100).toFixed(1),
      });
    }
    if (usage.request_count / budget.monthly_request_limit >= budget.alert_threshold) {
      warnings.push({
        type: 'request_alert',
        percentage: (usage.request_count / budget.monthly_request_limit * 100).toFixed(1),
      });
    }
    if (usage.total_cost / budget.monthly_cost_limit >= budget.alert_threshold) {
      warnings.push({
        type: 'cost_alert',
        percentage: (usage.total_cost / budget.monthly_cost_limit * 100).toFixed(1),
      });
    }

    return {
      allowed: true,
      warnings: warnings.length > 0 ? warnings : undefined,
      usage: {
        tokens: usage.total_tokens,
        requests: usage.request_count,
        cost: usage.total_cost,
      },
      limits: {
        tokens: budget.monthly_token_limit,
        requests: budget.monthly_request_limit,
        cost: budget.monthly_cost_limit,
      },
    };
  }

  // Record usage for a request
  recordUsage(userId, sessionId, usage) {
    if (!this.enabled) return;

    try {
      this.stmts.recordUsage.run(
        userId,
        sessionId,
        Date.now(),
        usage.tokensInput || 0,
        usage.tokensOutput || 0,
        (usage.tokensInput || 0) + (usage.tokensOutput || 0),
        usage.costUsd || 0,
        usage.model || null,
        usage.endpoint || null,
        usage.latencyMs || null
      );

      logger.debug({
        userId,
        tokens: (usage.tokensInput || 0) + (usage.tokensOutput || 0),
        cost: usage.costUsd,
      }, 'Usage recorded');
    } catch (error) {
      logger.error({ error, userId }, 'Failed to record usage');
    }
  }

  // Set budget for a user
  setBudget(userId, budget) {
    if (!this.enabled) return;

    const now = Date.now();
    const existing = this.stmts.getBudget.get(userId);

    if (existing) {
      this.stmts.updateBudget.run(
        budget.monthlyTokenLimit || existing.monthly_token_limit,
        budget.monthlyRequestLimit || existing.monthly_request_limit,
        budget.monthlyCostLimit || existing.monthly_cost_limit,
        budget.alertThreshold || existing.alert_threshold,
        now,
        userId
      );
    } else {
      this.stmts.createBudget.run(
        userId,
        budget.monthlyTokenLimit || 1000000,
        budget.monthlyRequestLimit || 10000,
        budget.monthlyCostLimit || 100.0,
        budget.alertThreshold || 0.8,
        now,
        now
      );
    }

    logger.info({ userId, budget }, 'Budget updated');
  }

  // Get usage summary for a user
  getUsageSummary(userId, days = 30) {
    if (!this.enabled) return null;

    const startTime = Date.now() - (days * 24 * 60 * 60 * 1000);
    const usage = this.db.prepare(`
      SELECT
        COUNT(*) as request_count,
        SUM(tokens_total) as total_tokens,
        SUM(cost_usd) as total_cost,
        AVG(latency_ms) as avg_latency,
        MIN(timestamp) as first_request,
        MAX(timestamp) as last_request
      FROM usage_tracking
      WHERE user_id = ? AND timestamp >= ?
    `).get(userId, startTime);

    const budget = this.stmts.getBudget.get(userId);

    return {
      usage,
      budget,
      period: { days, startTime, endTime: Date.now() },
    };
  }

  close() {
    if (this.db) {
      this.db.close();
    }
  }
}

// Singleton instance
let budgetManager = null;

function getBudgetManager() {
  if (!budgetManager) {
    const config = require('../config');
    budgetManager = new BudgetManager({
      enabled: config.budget?.enabled !== false,
    });
  }
  return budgetManager;
}

// Cleanup on exit
process.on('exit', () => {
  if (budgetManager) {
    budgetManager.close();
  }
});

module.exports = {
  getBudgetManager,
  BudgetManager,
};
