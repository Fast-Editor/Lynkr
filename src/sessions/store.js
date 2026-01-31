const db = require("../db");
const logger = require("../logger");

const selectSessionStmt = db.prepare(
  "SELECT id, created_at, updated_at, metadata FROM sessions WHERE id = ?",
);
const selectHistoryStmt = db.prepare(
  `SELECT role, type, status, content, metadata, timestamp
   FROM session_history
   WHERE session_id = ?
   ORDER BY timestamp ASC, id ASC`,
);
const insertSessionStmt = db.prepare(
  "INSERT INTO sessions (id, created_at, updated_at, metadata) VALUES (@id, @created_at, @updated_at, @metadata)",
);
const updateSessionStmt = db.prepare(
  "UPDATE sessions SET updated_at = @updated_at, metadata = @metadata WHERE id = @id",
);
const updateSessionTimestampStmt = db.prepare(
  "UPDATE sessions SET updated_at = @updated_at WHERE id = @id",
);
const deleteSessionStmt = db.prepare("DELETE FROM sessions WHERE id = ?");
const deleteHistoryStmt = db.prepare("DELETE FROM session_history WHERE session_id = ?");
const insertHistoryStmt = db.prepare(
  `INSERT INTO session_history (session_id, role, type, status, content, metadata, timestamp)
   VALUES (@session_id, @role, @type, @status, @content, @metadata, @timestamp)`,
);
const cleanupOldSessionsStmt = db.prepare(`
  DELETE FROM sessions
  WHERE updated_at < ?
`);
const cleanupOldHistoryStmt = db.prepare(`
  DELETE FROM session_history
  WHERE timestamp < ?
`);

function parseJSON(value, fallback) {
  if (value === null || value === undefined) return fallback;
  try {
    return JSON.parse(value);
  } catch (err) {
    logger.warn({ err }, "Failed to parse JSON from session store");
    return fallback;
  }
}

function serialize(value) {
  if (value === undefined) return null;
  try {
    return JSON.stringify(value);
  } catch (err) {
    logger.warn({ err }, "Failed to serialize JSON for session store");
    return null;
  }
}

function toSession(row, historyRows = []) {
  return {
    id: row.id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    metadata: parseJSON(row.metadata, {}) ?? {},
    history: historyRows.map((item) => ({
      role: item.role ?? undefined,
      type: item.type ?? undefined,
      status: item.status ?? undefined,
      content: parseJSON(item.content, null),
      metadata: parseJSON(item.metadata, null) ?? undefined,
      timestamp: item.timestamp,
    })),
  };
}

function getSession(sessionId) {
  if (!sessionId) return null;
  const sessionRow = selectSessionStmt.get(sessionId);
  if (!sessionRow) return null;
  const historyRows = selectHistoryStmt.all(sessionId);
  return toSession(sessionRow, historyRows);
}

function createSession(sessionId, metadata = {}) {
  const now = Date.now();
  insertSessionStmt.run({
    id: sessionId,
    created_at: now,
    updated_at: now,
    metadata: serialize(metadata) ?? "{}",
  });
  return {
    id: sessionId,
    createdAt: now,
    updatedAt: now,
    metadata: metadata ?? {},
    history: [],
  };
}

function getOrCreateSession(sessionId) {
  const existing = getSession(sessionId);
  if (existing) {
    // [SESSION_DEBUG] Reusing existing session
    const ageMs = Date.now() - existing.createdAt;
    const ageHours = (ageMs / (1000 * 60 * 60)).toFixed(2);

    logger.debug({
      sessionId,
      ageMs,
      ageHours,
      historyEntries: existing.history?.length ?? 0
    }, '[SESSION_DEBUG] Reusing existing session');

    return existing;
  }

  try {
    // [SESSION_DEBUG] Created new session
    const newSession = createSession(sessionId);
    logger.debug({
      sessionId,
      createdAt: newSession.createdAt
    }, '[SESSION_DEBUG] Created NEW session');

    return newSession;
  } catch (err) {
    if (err.code === "SQLITE_CONSTRAINT_PRIMARYKEY") {
      return getSession(sessionId);
    }
    throw err;
  }
}

function upsertSession(sessionId, data = {}) {
  if (!sessionId) return null;
  const metadata = data.metadata ?? {};
  const updatedAt = data.updatedAt ?? Date.now();
  const createdAt = data.createdAt ?? updatedAt;

  const existing = selectSessionStmt.get(sessionId);
  if (!existing) {
    insertSessionStmt.run({
      id: sessionId,
      created_at: createdAt,
      updated_at: updatedAt,
      metadata: serialize(metadata) ?? "{}",
    });
  } else {
    updateSessionStmt.run({
      id: sessionId,
      updated_at: updatedAt,
      metadata: serialize(metadata) ?? "{}",
    });
  }
  return getSession(sessionId);
}

function appendSessionTurn(sessionId, turn, metadata) {
  if (!sessionId) return null;
  const timestamp = turn.timestamp ?? Date.now();

  const params = {
    session_id: sessionId,
    role: turn.role ?? null,
    type: turn.type ?? null,
    status: typeof turn.status === "number" ? turn.status : null,
    content: serialize(turn.content),
    metadata: serialize(turn.metadata),
    timestamp,
  };

  logger.debug({ params }, "Inserting session history row");
  insertHistoryStmt.run(params);

  logger.debug({ sessionId, timestamp, metadata }, "Updating session metadata");

  if (metadata !== undefined) {
    updateSessionStmt.run({
      id: sessionId,
      updated_at: timestamp,
      metadata: serialize(metadata) ?? "{}",
    });
  } else {
    updateSessionTimestampStmt.run({
      id: sessionId,
      updated_at: timestamp,
    });
  }

  return { ...turn, timestamp };
}

function deleteSession(sessionId) {
  if (!sessionId) return;
  const deleteHistory = db.transaction((id) => {
    deleteHistoryStmt.run(id);
    deleteSessionStmt.run(id);
  });
  deleteHistory(sessionId);
}

function cleanupOldSessions(maxAgeMs = 7 * 24 * 60 * 60 * 1000) {
  const cutoffTime = Date.now() - maxAgeMs;
  const result = cleanupOldSessionsStmt.run(cutoffTime);
  logger.info({ deleted: result.changes, maxAgeMs }, "Cleaned up old sessions");
  return result.changes;
}

function cleanupOldHistory(maxAgeMs = 30 * 24 * 60 * 60 * 1000) {
  const cutoffTime = Date.now() - maxAgeMs;
  const result = cleanupOldHistoryStmt.run(cutoffTime);
  logger.info({ deleted: result.changes, maxAgeMs }, "Cleaned up old history");
  return result.changes;
}

module.exports = {
  getSession,
  getOrCreateSession,
  upsertSession,
  appendSessionTurn,
  deleteSession,
  cleanupOldSessions,
  cleanupOldHistory,
};
