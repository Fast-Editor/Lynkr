const crypto = require("crypto");

/**
 * Request ID middleware.
 *
 * Assigns req.requestId (honouring an inbound X-Request-ID header) and
 * echoes it on the response. Request/response logging itself is handled
 * by pino-http in middleware/logging.js — don't log here or every
 * request gets logged twice.
 */

function generateRequestId() {
  return crypto.randomBytes(16).toString("hex");
}

function requestLoggingMiddleware(req, res, next) {
  const requestId = req.headers["x-request-id"] || generateRequestId();
  req.requestId = requestId;
  res.setHeader("X-Request-ID", requestId);
  next();
}

module.exports = { requestLoggingMiddleware };
