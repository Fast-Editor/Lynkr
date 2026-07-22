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

module.exports = { load, save, remove, cleanup, _clear };
