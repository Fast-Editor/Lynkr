const crypto = require("crypto");
const { getOrCreateSession } = require("../../sessions/store");
const logger = require("../../logger");

const PRIMARY_HEADER = "x-session-id";
const FALLBACK_HEADERS = [
  "x-claude-session-id",
  "x-claude-session",
  "x-claude-conversation-id",
  "anthropic-session-id",
];

function normaliseSessionId(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

function extractSessionId(req) {
  const primary = normaliseSessionId(req.headers[PRIMARY_HEADER]);
  if (primary) return primary;

  for (const header of FALLBACK_HEADERS) {
    const candidate = normaliseSessionId(req.headers[header]);
    if (candidate) return candidate;
  }

  const body = req.body ?? {};
  const bodyId =
    normaliseSessionId(body.session_id) ??
    normaliseSessionId(body.sessionId) ??
    normaliseSessionId(body.conversation_id);
  if (bodyId) return bodyId;

  const generated = crypto.randomUUID();
  req.generatedSessionId = true;
  return generated;
}

function sessionMiddleware(req, res, next) {
  try {
    const sessionId = extractSessionId(req);
    req.sessionId = sessionId;

    // Add sessionId to logger context for this request
    req.log = logger.child({ sessionId });

    const session = getOrCreateSession(sessionId);
    req.session = session;
    return next();
  } catch (err) {
    return next(err);
  }
}

module.exports = {
  sessionMiddleware,
  SESSION_HEADER: PRIMARY_HEADER,
};
