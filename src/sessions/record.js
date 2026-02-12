const { appendSessionTurn } = require("./store");

// Cap in-memory history to prevent unbounded growth during long tool loops
const MAX_IN_MEMORY_HISTORY = 100;

function ensureSessionShape(session) {
  if (!session) return null;
  if (!Array.isArray(session.history)) {
    session.history = [];
  }
  if (!session.createdAt) {
    session.createdAt = Date.now();
  }
  return session;
}

function appendTurnToSession(session, entry) {
  const target = ensureSessionShape(session);
  if (!target) return null;

  const turn = { ...entry, timestamp: Date.now() };
  target.history.push(turn);
  target.updatedAt = turn.timestamp;

  // Trim in-memory history if it exceeds the cap
  if (target.history.length > MAX_IN_MEMORY_HISTORY) {
    target.history = target.history.slice(-MAX_IN_MEMORY_HISTORY);
  }

  // Skip DB write for ephemeral sessions (auto-generated, no client session ID)
  if (target.id && !target._ephemeral) {
    appendSessionTurn(target.id, turn, target.metadata ?? {});
  }

  return turn;
}

module.exports = {
  appendTurnToSession,
};
