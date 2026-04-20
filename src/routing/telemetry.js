/**
 * Routing Telemetry Module
 *
 * Persists per-request routing telemetry into a dedicated SQLite database
 * at .lynkr/telemetry.db. Provides query helpers for dashboards, accuracy
 * analysis, and automated routing feedback loops.
 *
 * Uses lazy initialisation so the proxy starts even when better-sqlite3 is
 * not installed (it is an optionalDependency).
 *
 * @module routing/telemetry
 */

const fs = require("fs");
const path = require("path");
const logger = require("../logger");

// ---------------------------------------------------------------------------
// Lazy database initialisation
// ---------------------------------------------------------------------------

let Database;
try {
  Database = require("better-sqlite3");
} catch {
  Database = null;
}

/** @type {import('better-sqlite3').Database|null} */
let db = null;

/** @type {boolean} */
let initialised = false;

/** Default retention: 30 days */
const DEFAULT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Initialise the telemetry database (singleton, idempotent).
 * @returns {boolean} true if the DB is usable
 */
function init() {
  if (initialised) return db !== null;
  initialised = true;

  if (!Database) {
    logger.debug("Telemetry: better-sqlite3 not available, telemetry disabled");
    return false;
  }

  try {
    const dbDir = path.resolve(process.cwd(), ".lynkr");
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }

    const dbPath = path.join(dbDir, "telemetry.db");
    db = new Database(dbPath, {
      verbose: process.env.DEBUG_SQL ? console.log : null,
      fileMustExist: false,
    });

    // Performance pragmas (same pattern as src/db/index.js)
    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = NORMAL");
    db.pragma("cache_size = -16000");
    db.pragma("temp_store = MEMORY");
    db.pragma("busy_timeout = 3000");

    db.exec(`
      CREATE TABLE IF NOT EXISTS routing_telemetry (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        request_id      TEXT NOT NULL,
        session_id      TEXT,
        timestamp       INTEGER NOT NULL,
        complexity_score REAL,
        tier            TEXT,
        agentic_type    TEXT,
        tool_count      INTEGER,
        input_tokens    INTEGER,
        message_count   INTEGER,
        request_type    TEXT,
        provider        TEXT NOT NULL,
        model           TEXT,
        routing_method  TEXT,
        was_fallback    INTEGER DEFAULT 0,
        output_tokens   INTEGER,
        latency_ms      INTEGER,
        status_code     INTEGER,
        error_type      TEXT,
        cost_usd        REAL,
        tool_calls_made INTEGER,
        retry_count     INTEGER DEFAULT 0,
        circuit_breaker_state TEXT,
        quality_score   REAL,
        tokens_per_second REAL,
        cost_efficiency REAL
      );

      CREATE INDEX IF NOT EXISTS idx_telemetry_provider
        ON routing_telemetry(provider);

      CREATE INDEX IF NOT EXISTS idx_telemetry_tier
        ON routing_telemetry(tier);

      CREATE INDEX IF NOT EXISTS idx_telemetry_timestamp
        ON routing_telemetry(timestamp);
    `);

    logger.info({ dbPath }, "Routing telemetry database initialised");
    return true;
  } catch (err) {
    logger.warn({ err: err.message }, "Failed to initialise telemetry database");
    db = null;
    return false;
  }
}

// ---------------------------------------------------------------------------
// Prepared statements (created lazily after init)
// ---------------------------------------------------------------------------

/** @type {Map<string, import('better-sqlite3').Statement>} */
const stmts = new Map();

/**
 * Get or create a prepared statement.
 * @param {string} key
 * @param {string} sql
 * @returns {import('better-sqlite3').Statement|null}
 */
function stmt(key, sql) {
  if (!db) return null;
  if (!stmts.has(key)) {
    stmts.set(key, db.prepare(sql));
  }
  return stmts.get(key);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Record a telemetry data point. Executes asynchronously via setImmediate
 * so it never blocks the request path.
 *
 * @param {Object} data - Telemetry fields (see table schema)
 */
function record(data) {
  if (!init()) return;

  setImmediate(() => {
    try {
      const insert = stmt(
        "insert",
        `INSERT INTO routing_telemetry (
          request_id, session_id, timestamp, complexity_score, tier,
          agentic_type, tool_count, input_tokens, message_count, request_type,
          provider, model, routing_method, was_fallback, output_tokens,
          latency_ms, status_code, error_type, cost_usd, tool_calls_made,
          retry_count, circuit_breaker_state, quality_score, tokens_per_second,
          cost_efficiency
        ) VALUES (
          @request_id, @session_id, @timestamp, @complexity_score, @tier,
          @agentic_type, @tool_count, @input_tokens, @message_count, @request_type,
          @provider, @model, @routing_method, @was_fallback, @output_tokens,
          @latency_ms, @status_code, @error_type, @cost_usd, @tool_calls_made,
          @retry_count, @circuit_breaker_state, @quality_score, @tokens_per_second,
          @cost_efficiency
        )`
      );
      if (!insert) return;

      insert.run({
        request_id: data.request_id ?? null,
        session_id: data.session_id ?? null,
        timestamp: data.timestamp ?? Date.now(),
        complexity_score: data.complexity_score ?? null,
        tier: data.tier ?? null,
        agentic_type: data.agentic_type ?? null,
        tool_count: data.tool_count ?? null,
        input_tokens: data.input_tokens ?? null,
        message_count: data.message_count ?? null,
        request_type: data.request_type ?? null,
        provider: data.provider,
        model: data.model ?? null,
        routing_method: data.routing_method ?? null,
        was_fallback: data.was_fallback ? 1 : 0,
        output_tokens: data.output_tokens ?? null,
        latency_ms: data.latency_ms ?? null,
        status_code: data.status_code ?? null,
        error_type: data.error_type ?? null,
        cost_usd: data.cost_usd ?? null,
        tool_calls_made: data.tool_calls_made ?? null,
        retry_count: data.retry_count ?? 0,
        circuit_breaker_state: data.circuit_breaker_state ?? null,
        quality_score: data.quality_score ?? null,
        tokens_per_second: data.tokens_per_second ?? null,
        cost_efficiency: data.cost_efficiency ?? null,
      });
    } catch (err) {
      logger.debug({ err: err.message }, "Telemetry record failed");
    }
  });
}

/**
 * Query telemetry records with optional filters.
 *
 * @param {Object} [filters]
 * @param {string} [filters.provider] - Filter by provider name
 * @param {string} [filters.tier] - Filter by tier
 * @param {number} [filters.since] - Only records after this timestamp (ms)
 * @param {number} [filters.limit] - Max rows to return (default 100)
 * @returns {Object[]} Matching telemetry rows
 */
function query(filters = {}) {
  if (!init()) return [];

  const clauses = [];
  const params = {};

  if (filters.provider) {
    clauses.push("provider = @provider");
    params.provider = filters.provider;
  }
  if (filters.tier) {
    clauses.push("tier = @tier");
    params.tier = filters.tier;
  }
  if (filters.since) {
    clauses.push("timestamp >= @since");
    params.since = filters.since;
  }

  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const limit = filters.limit ?? 100;

  try {
    const sql = `SELECT * FROM routing_telemetry ${where} ORDER BY timestamp DESC LIMIT ${Number(limit)}`;
    return db.prepare(sql).all(params);
  } catch (err) {
    logger.debug({ err: err.message }, "Telemetry query failed");
    return [];
  }
}

/**
 * Get aggregate statistics over a time range.
 *
 * @param {Object} [timeRange]
 * @param {number} [timeRange.since] - Start timestamp (ms). Defaults to 24 hours ago.
 * @param {number} [timeRange.until] - End timestamp (ms). Defaults to now.
 * @returns {Object|null} Aggregated statistics
 */
function getStats(timeRange = {}) {
  if (!init()) return null;

  const since = timeRange.since ?? Date.now() - 24 * 60 * 60 * 1000;
  const until = timeRange.until ?? Date.now();

  try {
    // Total requests
    const total = db
      .prepare("SELECT COUNT(*) as cnt FROM routing_telemetry WHERE timestamp BETWEEN ? AND ?")
      .get(since, until);

    if (!total || total.cnt === 0) return null;

    // Average latency per provider
    const latencyRows = db
      .prepare(
        `SELECT provider, AVG(latency_ms) as avg_latency, COUNT(*) as cnt
         FROM routing_telemetry
         WHERE timestamp BETWEEN ? AND ? AND latency_ms IS NOT NULL
         GROUP BY provider`
      )
      .all(since, until);

    const avgLatencyByProvider = {};
    for (const row of latencyRows) {
      avgLatencyByProvider[row.provider] = Math.round(row.avg_latency);
    }

    // Average quality per tier
    const qualityRows = db
      .prepare(
        `SELECT tier, AVG(quality_score) as avg_quality, COUNT(*) as cnt
         FROM routing_telemetry
         WHERE timestamp BETWEEN ? AND ? AND quality_score IS NOT NULL AND tier IS NOT NULL
         GROUP BY tier`
      )
      .all(since, until);

    const avgQualityByTier = {};
    for (const row of qualityRows) {
      avgQualityByTier[row.tier] = Math.round(row.avg_quality * 10) / 10;
    }

    // Error rate
    const errors = db
      .prepare(
        "SELECT COUNT(*) as cnt FROM routing_telemetry WHERE timestamp BETWEEN ? AND ? AND error_type IS NOT NULL"
      )
      .get(since, until);

    const errorRate = Math.round((errors.cnt / total.cnt) * 1000) / 10; // one decimal %

    // Over/under provisioned percentages
    const accuracy = getRoutingAccuracy({ since, until });

    return {
      totalRequests: total.cnt,
      avgLatencyByProvider,
      avgQualityByTier,
      errorRate,
      overProvisionedPct: accuracy ? accuracy.overProvisionedPct : 0,
      underProvisionedPct: accuracy ? accuracy.underProvisionedPct : 0,
    };
  } catch (err) {
    logger.debug({ err: err.message }, "Telemetry getStats failed");
    return null;
  }
}

/**
 * Get aggregated statistics for a specific provider.
 *
 * @param {string} provider - Provider name
 * @param {Object} [timeRange]
 * @param {number} [timeRange.since]
 * @param {number} [timeRange.until]
 * @returns {Object|null}
 */
function getProviderStats(provider, timeRange = {}) {
  if (!init()) return null;

  const since = timeRange.since ?? Date.now() - 24 * 60 * 60 * 1000;
  const until = timeRange.until ?? Date.now();

  try {
    const row = db
      .prepare(
        `SELECT
           COUNT(*) as total,
           AVG(latency_ms) as avg_latency,
           AVG(quality_score) as avg_quality,
           AVG(output_tokens) as avg_output_tokens,
           SUM(CASE WHEN error_type IS NOT NULL THEN 1 ELSE 0 END) as errors,
           SUM(CASE WHEN was_fallback = 1 THEN 1 ELSE 0 END) as fallbacks,
           AVG(tokens_per_second) as avg_tps,
           SUM(cost_usd) as total_cost
         FROM routing_telemetry
         WHERE provider = ? AND timestamp BETWEEN ? AND ?`
      )
      .get(provider, since, until);

    if (!row || row.total === 0) return null;

    return {
      total: row.total,
      avgLatency: row.avg_latency ? Math.round(row.avg_latency) : null,
      avgQuality: row.avg_quality ? Math.round(row.avg_quality * 10) / 10 : null,
      avgOutputTokens: row.avg_output_tokens ? Math.round(row.avg_output_tokens) : null,
      errorRate: Math.round((row.errors / row.total) * 1000) / 10,
      fallbackRate: Math.round((row.fallbacks / row.total) * 1000) / 10,
      avgTokensPerSecond: row.avg_tps ? Math.round(row.avg_tps * 10) / 10 : null,
      totalCost: row.total_cost ? Math.round(row.total_cost * 10000) / 10000 : null,
    };
  } catch (err) {
    logger.debug({ err: err.message }, "Telemetry getProviderStats failed");
    return null;
  }
}

/**
 * Calculate routing accuracy: percentage of requests that were over- or
 * under-provisioned.
 *
 * Over-provisioned: quality_score > 80 AND output_tokens < 50 on REASONING or COMPLEX tier.
 * Under-provisioned: quality_score < 45 on SIMPLE tier.
 *
 * @param {Object} [timeRange]
 * @param {number} [timeRange.since]
 * @param {number} [timeRange.until]
 * @returns {Object|null}
 */
function getRoutingAccuracy(timeRange = {}) {
  if (!init()) return null;

  const since = timeRange.since ?? Date.now() - 24 * 60 * 60 * 1000;
  const until = timeRange.until ?? Date.now();

  try {
    const total = db
      .prepare("SELECT COUNT(*) as cnt FROM routing_telemetry WHERE timestamp BETWEEN ? AND ?")
      .get(since, until);

    if (!total || total.cnt === 0) return null;

    const overProvisioned = db
      .prepare(
        `SELECT COUNT(*) as cnt FROM routing_telemetry
         WHERE timestamp BETWEEN ? AND ?
           AND quality_score > 80
           AND output_tokens < 50
           AND tier IN ('REASONING', 'COMPLEX')`
      )
      .get(since, until);

    const underProvisioned = db
      .prepare(
        `SELECT COUNT(*) as cnt FROM routing_telemetry
         WHERE timestamp BETWEEN ? AND ?
           AND quality_score < 45
           AND tier = 'SIMPLE'`
      )
      .get(since, until);

    return {
      totalRequests: total.cnt,
      overProvisioned: overProvisioned.cnt,
      underProvisioned: underProvisioned.cnt,
      overProvisionedPct: Math.round((overProvisioned.cnt / total.cnt) * 1000) / 10,
      underProvisionedPct: Math.round((underProvisioned.cnt / total.cnt) * 1000) / 10,
    };
  } catch (err) {
    logger.debug({ err: err.message }, "Telemetry getRoutingAccuracy failed");
    return null;
  }
}

/**
 * Delete telemetry records older than a given threshold.
 *
 * @param {number} [olderThanMs] - Age threshold in ms. Defaults to 30 days.
 * @returns {number} Number of rows deleted
 */
function cleanup(olderThanMs) {
  if (!init()) return 0;

  const threshold = Date.now() - (olderThanMs ?? DEFAULT_RETENTION_MS);

  try {
    const del = stmt("cleanup", "DELETE FROM routing_telemetry WHERE timestamp < ?");
    if (!del) return 0;
    const result = del.run(threshold);
    logger.debug({ deleted: result.changes }, "Telemetry cleanup complete");
    return result.changes;
  } catch (err) {
    logger.debug({ err: err.message }, "Telemetry cleanup failed");
    return 0;
  }
}

// ---------------------------------------------------------------------------
// In-memory stats cache (avoids SQLite queries on every /v1/routing/stats hit)
// ---------------------------------------------------------------------------

const STATS_CACHE_TTL = 5000; // 5 seconds
let statsCache = null;
let statsCacheTs = 0;

function getStatsCached(timeRange = {}) {
  const now = Date.now();
  // Use cache for default time range (last 24h) — custom ranges bypass cache
  if (!timeRange.since && !timeRange.until && statsCache && now - statsCacheTs < STATS_CACHE_TTL) {
    return statsCache;
  }
  const result = getStats(timeRange);
  if (!timeRange.since && !timeRange.until) {
    statsCache = result;
    statsCacheTs = now;
  }
  return result;
}

let providerStatsCache = new Map();
let providerStatsCacheTs = 0;

function getProviderStatsCached(provider, timeRange = {}) {
  const now = Date.now();
  if (!timeRange.since && !timeRange.until && providerStatsCache.has(provider) && now - providerStatsCacheTs < STATS_CACHE_TTL) {
    return providerStatsCache.get(provider);
  }
  const result = getProviderStats(provider, timeRange);
  if (!timeRange.since && !timeRange.until) {
    providerStatsCache.set(provider, result);
    providerStatsCacheTs = now;
  }
  return result;
}

module.exports = {
  record,
  query,
  getStats: getStatsCached,
  getProviderStats: getProviderStatsCached,
  getRoutingAccuracy,
  cleanup,
};
