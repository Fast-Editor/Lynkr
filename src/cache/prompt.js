const crypto = require("crypto");
const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");
const config = require("../config");
const logger = require("../logger");

function cloneValue(value) {
  if (typeof structuredClone === "function") {
    return structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value));
}

function normaliseObject(value) {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return value.map((item) => normaliseObject(item));
  }
  const sorted = {};
  for (const key of Object.keys(value).sort()) {
    const candidate = value[key];
    if (candidate === undefined) continue;
    sorted[key] = normaliseObject(candidate);
  }
  return sorted;
}

function stableStringify(value) {
  return JSON.stringify(normaliseObject(value));
}

class PromptCache {
  constructor(options = {}) {
    this.enabled = options.enabled === true;
    this.maxEntries =
      Number.isInteger(options.maxEntries) && options.maxEntries > 0
        ? options.maxEntries
        : 1000; // Increased from 64
    this.ttlMs =
      Number.isInteger(options.ttlMs) && options.ttlMs > 0 ? options.ttlMs : 300000;

    // Add pruning interval (default: 5 minutes)
    this.pruneIntervalMs =
      Number.isInteger(options.pruneIntervalMs) && options.pruneIntervalMs > 0
        ? options.pruneIntervalMs
        : 300000;
    this.pruneTimer = null;
    this.isClosed = false; // Track if database has been closed

    // Initialize persistent cache database
    if (this.enabled) {
      this.initDatabase();
      this.startPruning();
    }
  }

  initDatabase() {
    try {
      const cacheDir = path.join(process.cwd(), 'data');
      if (!fs.existsSync(cacheDir)) {
        fs.mkdirSync(cacheDir, { recursive: true });
      }

      const dbPath = path.join(cacheDir, 'prompt-cache.db');
      this.db = new Database(dbPath);

      // Optimize for cache workload
      this.db.pragma("journal_mode = WAL");
      this.db.pragma("synchronous = NORMAL");
      this.db.pragma("cache_size = -32000"); // 32MB cache
      this.db.pragma("temp_store = MEMORY");

      // Create cache table
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS prompt_cache (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          expires_at INTEGER,
          hit_count INTEGER DEFAULT 0,
          last_accessed INTEGER NOT NULL,
          response_size INTEGER DEFAULT 0
        );

        CREATE INDEX IF NOT EXISTS idx_cache_expires ON prompt_cache(expires_at);
        CREATE INDEX IF NOT EXISTS idx_cache_accessed ON prompt_cache(last_accessed);
        CREATE INDEX IF NOT EXISTS idx_cache_hits ON prompt_cache(hit_count DESC);
      `);

      // Prepare statements for performance
      this.getStmt = this.db.prepare(`
        SELECT value, hit_count
        FROM prompt_cache
        WHERE key = ? AND (expires_at IS NULL OR expires_at > ?)
      `);

      this.setStmt = this.db.prepare(`
        INSERT INTO prompt_cache (key, value, created_at, expires_at, last_accessed, response_size)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET
          value = excluded.value,
          hit_count = hit_count + 1,
          last_accessed = excluded.last_accessed
      `);

      this.updateAccessStmt = this.db.prepare(`
        UPDATE prompt_cache
        SET hit_count = hit_count + 1, last_accessed = ?
        WHERE key = ?
      `);

      this.deleteExpiredStmt = this.db.prepare(`
        DELETE FROM prompt_cache
        WHERE expires_at IS NOT NULL AND expires_at <= ?
      `);

      this.evictOldestStmt = this.db.prepare(`
        DELETE FROM prompt_cache
        WHERE key IN (
          SELECT key FROM prompt_cache
          ORDER BY last_accessed ASC
          LIMIT ?
        )
      `);

      this.countStmt = this.db.prepare(`
        SELECT COUNT(*) as count FROM prompt_cache
      `);

      // Clean expired entries on startup
      this.pruneExpired();

      logger.info({ dbPath }, "Prompt cache initialized with persistent storage");
    } catch (error) {
      logger.error({ err: error }, "Failed to initialize prompt cache database");
      this.enabled = false;
    }
  }

  isEnabled() {
    return this.enabled;
  }

  buildKey(payload) {
    if (!this.enabled) return null;
    if (!payload || typeof payload !== "object") return null;
    try {
      const canonical = {
        model: payload.model ?? null,
        input: payload.input ?? null,
        messages: payload.messages ? normaliseObject(payload.messages) : null,
        tools: payload.tools ? normaliseObject(payload.tools) : null,
        tool_choice: payload.tool_choice ? normaliseObject(payload.tool_choice) : null,
        temperature: payload.temperature ?? null,
        top_p: payload.top_p ?? null,
        max_tokens: payload.max_tokens ?? null,
      };
      const serialised = stableStringify(canonical);
      return crypto.createHash("sha256").update(serialised).digest("hex");
    } catch (error) {
      logger.warn(
        {
          err: error,
        },
        "Failed to build prompt cache key",
      );
      return null;
    }
  }

  pruneExpired() {
    if (!this.enabled || !this.db || this.isClosed) return;
    if (this.ttlMs <= 0) return;
    try {
      // Check if database is still open
      if (!this.db.open) return;
      const now = Date.now();
      const result = this.deleteExpiredStmt.run(now);
      if (result.changes > 0) {
        logger.debug({ deleted: result.changes }, "Pruned expired cache entries");
      }
    } catch (error) {
      // Only log if not a "connection closed" error during shutdown
      if (!this.isClosed) {
        logger.warn({ err: error }, "Failed to prune expired cache entries");
      }
    }
  }

  lookup(payloadOrKey) {
    if (!this.enabled || !this.db) {
      return { key: null, entry: null };
    }
    const key =
      typeof payloadOrKey === "string" ? payloadOrKey : this.buildKey(payloadOrKey);
    if (!key) {
      return { key: null, entry: null };
    }

    try {
      const now = Date.now();
      const row = this.getStmt.get(key, now);

      if (!row) {
        return { key, entry: null };
      }

      // Update access time and hit count asynchronously
      setImmediate(() => {
        try {
          this.updateAccessStmt.run(now, key);
        } catch (error) {
          logger.debug({ err: error }, "Failed to update cache access time");
        }
      });

      return {
        key,
        entry: {
          value: JSON.parse(row.value),
          hitCount: row.hit_count
        }
      };
    } catch (error) {
      logger.warn({ err: error, key }, "Failed to lookup cache entry");
      return { key, entry: null };
    }
  }

  fetch(payload) {
    const { key, entry } = this.lookup(payload);
    if (!entry) return null;

    logger.debug({
      key,
      hitCount: entry.hitCount
    }, "Cache hit");

    return {
      key,
      response: entry.value, // Already cloned from JSON.parse
    };
  }

  shouldCacheResponse(response) {
    if (!response) return false;
    if (response.ok !== true) return false;
    if (!response.json) return false;
    if (typeof response.status === "number" && response.status !== 200) return false;

    const choice = response.json?.choices?.[0];
    if (!choice) return false;
    if (choice?.finish_reason === "tool_calls") return false;

    const message = choice.message ?? {};
    if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
      return false;
    }
    return true;
  }

  storeResponse(payloadOrKey, response) {
    if (!this.enabled || !this.db) return null;
    if (!this.shouldCacheResponse(response)) return null;
    const key =
      typeof payloadOrKey === "string" ? payloadOrKey : this.buildKey(payloadOrKey);
    if (!key) return null;

    try {
      const now = Date.now();
      const expiresAt = this.ttlMs > 0 ? now + this.ttlMs : null;
      const valueStr = JSON.stringify(response);
      const responseSize = valueStr.length;

      this.setStmt.run(key, valueStr, now, expiresAt, now, responseSize);

      // Check if we need to evict old entries
      const count = this.countStmt.get().count;
      if (count > this.maxEntries) {
        const toEvict = count - this.maxEntries + 10; // Evict 10 extra to avoid frequent evictions
        this.evictOldestStmt.run(toEvict);
        logger.debug({ evicted: toEvict }, "Evicted old cache entries");
      }

      logger.debug(
        {
          cacheKey: key,
          size: count,
          responseSize,
        },
        "Stored response in prompt cache",
      );

      return key;
    } catch (error) {
      logger.warn({ err: error, key }, "Failed to store cache entry");
      return null;
    }
  }

  stats() {
    if (!this.enabled || !this.db) {
      return {
        enabled: this.enabled,
        size: 0,
        ttlMs: this.ttlMs,
        maxEntries: this.maxEntries,
      };
    }

    try {
      const count = this.countStmt.get().count;
      const stats = this.db.prepare(`
        SELECT
          SUM(response_size) as total_size,
          AVG(hit_count) as avg_hits,
          MAX(hit_count) as max_hits
        FROM prompt_cache
      `).get();

      return {
        enabled: this.enabled,
        size: count,
        ttlMs: this.ttlMs,
        maxEntries: this.maxEntries,
        totalSize: stats.total_size || 0,
        avgHits: Math.round(stats.avg_hits || 0),
        maxHits: stats.max_hits || 0,
      };
    } catch (error) {
      logger.warn({ err: error }, "Failed to get cache stats");
      return {
        enabled: this.enabled,
        size: 0,
        ttlMs: this.ttlMs,
        maxEntries: this.maxEntries,
      };
    }
  }

  startPruning() {
    if (this.pruneTimer) return; // Already started

    this.pruneTimer = setInterval(() => {
      try {
        this.pruneExpired();
        logger.debug("Prompt cache pruning completed");
      } catch (error) {
        logger.warn({ error }, "Failed to prune cache in background");
      }
    }, this.pruneIntervalMs);

    // Don't prevent process exit
    this.pruneTimer.unref();

    logger.info({ intervalMs: this.pruneIntervalMs }, "Prompt cache pruning started");
  }

  stopPruning() {
    if (this.pruneTimer) {
      clearInterval(this.pruneTimer);
      this.pruneTimer = null;
      logger.debug("Prompt cache pruning stopped");
    }
  }

  // Cleanup method
  close() {
    if (this.isClosed) return; // Already closed
    this.stopPruning(); // Stop pruning timer first

    if (this.db && this.db.open) {
      try {
        // Final prune before closing (direct call, not through pruneExpired)
        if (this.ttlMs > 0 && this.deleteExpiredStmt) {
          const result = this.deleteExpiredStmt.run(Date.now());
          if (result.changes > 0) {
            logger.debug({ deleted: result.changes }, "Final cache prune on close");
          }
        }
        this.db.close();
        logger.debug("Prompt cache database closed");
      } catch (error) {
        // Ignore errors during shutdown - database may already be closed
        logger.debug({ err: error }, "Cache database close (may already be closed)");
      }
    }

    this.isClosed = true; // Mark as closed after cleanup
  }
}

const promptCache = new PromptCache(config.promptCache ?? {});

// Cleanup on process exit
process.on('exit', () => {
  promptCache.close();
});

module.exports = promptCache;
