/**
 * Session-Pin Persistence
 *
 * Persists sticky-session routing pins to SQLite so they survive process
 * restarts. Shares the telemetry DB handle (see telemetry.getDb) to avoid
 * opening a second WAL connection to the same file.
 *
 * A "pin" records the provider/model/tier a session was routed to plus enough
 * state (message_count, prompt_tokens_est, ts) for the wrapper in
 * `session-affinity.js` to decide when to re-route:
 *
 *   - compaction detected (messages shrank ⇒ cache reset ⇒ free to re-route)
 *   - guard escalation (context/vision needs pin can't satisfy)
 *   - economic downgrade (fresh decision is cheaper AND prompt is small
 *     enough that the cold-cache re-read is affordable)
 *
 * All I/O is best-effort: any failure is recorded via degradation.record and
 * falls back to the in-memory Map in session-affinity.js.
 *
 * @module routing/affinity-store
 */

const telemetry = require("./telemetry");
const degradation = require("./degradation");
const logger = require("../logger");

let schemaEnsured = false;

function _db() {
  const db = telemetry.getDb();
  if (!db) return null;
  if (!schemaEnsured) {
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS session_pins (
          session_id        TEXT PRIMARY KEY,
          provider          TEXT NOT NULL,
          model             TEXT,
          tier              TEXT,
          score             REAL,
          message_count     INTEGER,
          prompt_tokens_est INTEGER,
          ts                INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_session_pins_ts ON session_pins(ts);
      `);
      // Additive migration for DBs created before `score` was added.
      const cols = new Set(db.prepare("PRAGMA table_info(session_pins)").all().map((c) => c.name));
      if (!cols.has("score")) {
        db.exec("ALTER TABLE session_pins ADD COLUMN score REAL");
      }
      // Additive migration for the side-channel detector's Signal 2 —
      // once a session has ever carried tool_use/tool_result blocks, this
      // flag stays 1 for the pin's lifetime. Payloads that arrive later
      // without tool blocks in a flagged session are side-channel replays.
      if (!cols.has("has_tool_history")) {
        db.exec("ALTER TABLE session_pins ADD COLUMN has_tool_history INTEGER DEFAULT 0");
      }
      // Additive migration for cache-aware routing (Phase 1): JSON blob
      // holding {warmPrefixTokens, provider, model, lastRequestAt, ttlMs},
      // updated after every upstream response that reports cache usage.
      // NOTE (2026-09-18): superseded by the dedicated session_cache_state
      // table below. The column stays (and old blobs stay readable nowhere —
      // loadCacheState reads the new table), but NOTHING writes it anymore:
      // sharing the pins table let cache-only rows (no tier) be served as
      // routing pins, permanently locking sessions with no escalation path.
      if (!cols.has("cache_state")) {
        db.exec("ALTER TABLE session_pins ADD COLUMN cache_state TEXT");
      }
      db.exec(`
        CREATE TABLE IF NOT EXISTS session_cache_state (
          session_id         TEXT PRIMARY KEY,
          warm_prefix_tokens INTEGER NOT NULL,
          provider           TEXT NOT NULL,
          model              TEXT,
          last_request_at    INTEGER NOT NULL,
          ttl_ms             INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_cache_state_ts ON session_cache_state(last_request_at);
        CREATE TABLE IF NOT EXISTS session_task_state (
          session_id     TEXT PRIMARY KEY,
          anchor_hash    TEXT,
          effective_band INTEGER,
          open           INTEGER,
          low_streak     INTEGER,
          updated_at     INTEGER
        );
      `);
      schemaEnsured = true;
    } catch (err) {
      degradation.record("feedback", err);
      return null;
    }
  }
  return db;
}

const stmts = new Map();
function _stmt(db, key, sql) {
  const cacheKey = `${key}`;
  if (!stmts.has(cacheKey)) stmts.set(cacheKey, db.prepare(sql));
  return stmts.get(cacheKey);
}

/**
 * Load a pin by session id. Returns null if missing, expired against `ttlMs`,
 * or the DB is unavailable.
 *
 * @param {string} sessionId
 * @param {number} [ttlMs]
 * @returns {{provider:string, model:string|null, tier:string|null, messageCount:number|null, promptTokensEst:number|null, ts:number}|null}
 */
function load(sessionId, ttlMs) {
  if (!sessionId) return null;
  const db = _db();
  if (!db) return null;
  try {
    const row = _stmt(
      db,
      "load",
      "SELECT provider, model, tier, score, message_count, prompt_tokens_est, has_tool_history, ts FROM session_pins WHERE session_id = ?"
    ).get(sessionId);
    if (!row) return null;
    if (ttlMs && Date.now() - row.ts > ttlMs) {
      // Expired: delete lazily so a subsequent save doesn't pick up a stale ts.
      try {
        _stmt(db, "delete", "DELETE FROM session_pins WHERE session_id = ?").run(sessionId);
      } catch { /* best-effort */ }
      return null;
    }
    return {
      provider: row.provider,
      model: row.model,
      tier: row.tier,
      score: row.score,
      messageCount: row.message_count,
      promptTokensEst: row.prompt_tokens_est,
      hasToolHistory: !!row.has_tool_history,
      ts: row.ts,
    };
  } catch (err) {
    degradation.record("feedback", err);
    return null;
  }
}

/**
 * Upsert a pin. Silently no-ops if the DB is unavailable — the in-memory Map
 * in session-affinity remains authoritative in that case.
 *
 * @param {string} sessionId
 * @param {{provider:string, model?:string|null, tier?:string|null, messageCount?:number|null, promptTokensEst?:number|null, ts?:number}} pin
 */
function save(sessionId, pin) {
  if (!sessionId || !pin?.provider) return;
  const db = _db();
  if (!db) return;
  try {
    _stmt(
      db,
      "upsert",
      // has_tool_history is sticky-true: once the session has ever carried
      // tool blocks it stays flagged for the pin's lifetime. Use MAX so an
      // update from a tool-less request (e.g. compaction refresh) can never
      // clear the flag once set.
      `INSERT INTO session_pins (session_id, provider, model, tier, score, message_count, prompt_tokens_est, has_tool_history, ts)
       VALUES (@session_id, @provider, @model, @tier, @score, @message_count, @prompt_tokens_est, @has_tool_history, @ts)
       ON CONFLICT(session_id) DO UPDATE SET
         provider = excluded.provider,
         model = excluded.model,
         tier = excluded.tier,
         score = excluded.score,
         message_count = excluded.message_count,
         prompt_tokens_est = excluded.prompt_tokens_est,
         has_tool_history = MAX(has_tool_history, excluded.has_tool_history),
         ts = excluded.ts`
    ).run({
      session_id: sessionId,
      provider: pin.provider,
      model: pin.model ?? null,
      tier: pin.tier ?? null,
      score: typeof pin.score === 'number' ? pin.score : null,
      message_count: pin.messageCount ?? null,
      prompt_tokens_est: pin.promptTokensEst ?? null,
      has_tool_history: pin.hasToolHistory ? 1 : 0,
      ts: pin.ts ?? Date.now(),
    });
  } catch (err) {
    degradation.record("feedback", err);
  }
}

/**
 * Persist per-session prompt-cache state (Phase 1, cache-aware routing).
 * Lives in its OWN table (session_cache_state), deliberately separate from
 * session_pins: the old piggyback design wrote tier-less rows that got
 * served as routing pins, locking sessions with no escalation path.
 * Best-effort like everything else in this module.
 *
 * @param {string} sessionId
 * @param {{warmPrefixTokens:number, provider:string, model:string|null, lastRequestAt:number, ttlMs:number}} state
 */
function saveCacheState(sessionId, state) {
  if (!sessionId || !state?.provider) return;
  const db = _db();
  if (!db) return;
  try {
    _stmt(
      db,
      "cache_state_upsert",
      `INSERT INTO session_cache_state (session_id, warm_prefix_tokens, provider, model, last_request_at, ttl_ms)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         warm_prefix_tokens = excluded.warm_prefix_tokens,
         provider = excluded.provider,
         model = excluded.model,
         last_request_at = excluded.last_request_at,
         ttl_ms = excluded.ttl_ms`
    ).run(
      sessionId,
      state.warmPrefixTokens ?? 0,
      state.provider,
      state.model ?? null,
      state.lastRequestAt ?? Date.now(),
      state.ttlMs ?? 5 * 60 * 1000
    );
  } catch (err) {
    degradation.record("feedback", err);
  }
}

/**
 * Load per-session cache state. Returns null when absent, unparsable, or the
 * DB is unavailable — callers treat null as "no cache signal for this
 * session" (provider doesn't report cache usage, or no response seen yet).
 *
 * @param {string} sessionId
 * @returns {{warmPrefixTokens:number, provider:string, model:string|null, lastRequestAt:number, ttlMs:number}|null}
 */
function loadCacheState(sessionId) {
  if (!sessionId) return null;
  const db = _db();
  if (!db) return null;
  try {
    const row = _stmt(
      db,
      "cache_state_load",
      "SELECT warm_prefix_tokens, provider, model, last_request_at, ttl_ms FROM session_cache_state WHERE session_id = ?"
    ).get(sessionId);
    if (!row) return null;
    return {
      warmPrefixTokens: Number(row.warm_prefix_tokens) || 0,
      provider: row.provider,
      model: row.model ?? null,
      lastRequestAt: Number(row.last_request_at) || 0,
      ttlMs: Number(row.ttl_ms) || 5 * 60 * 1000,
    };
  } catch (err) {
    degradation.record("feedback", err);
    return null;
  }
}

// TaskBand — per-session task difficulty state. Lives in its OWN table for
// the same reason as session_cache_state: piggybacking non-pin rows onto
// session_pins let tier-less rows be served as routing pins (see note above
// saveCacheState). Falls back to this in-memory Map when the DB is
// unavailable so continuation floors keep working without persistence.
const taskStateMem = new Map();

/**
 * Load TaskBand state for a session. Returns null when absent or on any
 * DB failure.
 *
 * @param {string} sessionId
 * @returns {{anchorHash:string|null, effectiveBand:number, open:boolean, lowStreak:number}|null}
 */
function getTaskState(sessionId) {
  if (!sessionId) return null;
  const db = _db();
  if (!db) {
    const mem = taskStateMem.get(sessionId);
    return mem ? { ...mem } : null;
  }
  try {
    const row = _stmt(
      db,
      "task_state_load",
      "SELECT anchor_hash, effective_band, open, low_streak FROM session_task_state WHERE session_id = ?"
    ).get(sessionId);
    if (!row) return null;
    return {
      anchorHash: row.anchor_hash ?? null,
      effectiveBand: Number(row.effective_band) || 0,
      open: !!row.open,
      lowStreak: Number(row.low_streak) || 0,
    };
  } catch (err) {
    degradation.record("feedback", err);
    return null;
  }
}

/**
 * Upsert TaskBand state. effective_band is MAX-merged only while the stored
 * anchor matches — a new anchor means a new task, whose band must not
 * inherit the old peak, so the whole row is overwritten instead.
 *
 * @param {string} sessionId
 * @param {{anchorHash:string|null, effectiveBand:number, open:boolean, lowStreak?:number}} state
 */
function setTaskState(sessionId, state) {
  if (!sessionId || !state) return;
  const next = {
    anchorHash: state.anchorHash ?? null,
    effectiveBand: Number.isFinite(state.effectiveBand) ? state.effectiveBand : 0,
    open: state.open ? 1 : 0,
    lowStreak: Number.isFinite(state.lowStreak) ? state.lowStreak : 0,
  };
  const db = _db();
  if (!db) {
    const prev = taskStateMem.get(sessionId);
    if (prev && prev.anchorHash === next.anchorHash) {
      next.effectiveBand = Math.max(prev.effectiveBand, next.effectiveBand);
    }
    taskStateMem.set(sessionId, {
      anchorHash: next.anchorHash,
      effectiveBand: next.effectiveBand,
      open: !!next.open,
      lowStreak: next.lowStreak,
    });
    return;
  }
  try {
    _stmt(
      db,
      "task_state_upsert",
      // IS (not =) so a null↔null anchor comparison still MAX-merges. All
      // SET expressions see the pre-update row, so assignment order below
      // doesn't affect the CASE.
      `INSERT INTO session_task_state (session_id, anchor_hash, effective_band, open, low_streak, updated_at)
       VALUES (@session_id, @anchor_hash, @effective_band, @open, @low_streak, @updated_at)
       ON CONFLICT(session_id) DO UPDATE SET
         effective_band = CASE WHEN anchor_hash IS excluded.anchor_hash
           THEN MAX(effective_band, excluded.effective_band)
           ELSE excluded.effective_band END,
         anchor_hash = excluded.anchor_hash,
         open = excluded.open,
         low_streak = excluded.low_streak,
         updated_at = excluded.updated_at`
    ).run({
      session_id: sessionId,
      anchor_hash: next.anchorHash,
      effective_band: next.effectiveBand,
      open: next.open,
      low_streak: next.lowStreak,
      updated_at: Date.now(),
    });
  } catch (err) {
    degradation.record("feedback", err);
  }
}

/**
 * Remove TaskBand state for a session.
 * @param {string} sessionId
 */
function clearTaskState(sessionId) {
  if (!sessionId) return;
  taskStateMem.delete(sessionId);
  const db = _db();
  if (!db) return;
  try {
    _stmt(db, "task_state_delete", "DELETE FROM session_task_state WHERE session_id = ?").run(sessionId);
  } catch (err) {
    degradation.record("feedback", err);
  }
}

/**
 * Remove a pin.
 * @param {string} sessionId
 */
function remove(sessionId) {
  if (!sessionId) return;
  const db = _db();
  if (!db) return;
  try {
    _stmt(db, "delete", "DELETE FROM session_pins WHERE session_id = ?").run(sessionId);
  } catch (err) {
    degradation.record("feedback", err);
  }
}

/**
 * Delete pins older than ttlMs. Called from the same scheduler that runs
 * telemetry.cleanup.
 *
 * @param {number} ttlMs
 * @returns {number} rows deleted
 */
function cleanup(ttlMs) {
  const db = _db();
  if (!db) return 0;
  try {
    const threshold = Date.now() - ttlMs;
    const result = _stmt(db, "cleanup", "DELETE FROM session_pins WHERE ts < ?").run(threshold);
    logger.debug({ deleted: result.changes }, "[AffinityStore] pin cleanup");
    return result.changes;
  } catch (err) {
    degradation.record("feedback", err);
    return 0;
  }
}

/** Test helper — wipe all pins. */
function _clear() {
  const db = _db();
  if (!db) return;
  try {
    db.prepare("DELETE FROM session_pins").run();
  } catch { /* best-effort */ }
}

module.exports = {
  load,
  save,
  remove,
  cleanup,
  saveCacheState,
  loadCacheState,
  getTaskState,
  setTaskState,
  clearTaskState,
  _clear,
};
