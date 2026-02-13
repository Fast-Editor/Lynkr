const pinoHttp = require("pino-http");
const logger = require("../../logger");

function maskHeaders(headers = {}) {
  const clone = { ...headers };
  if (typeof clone["x-api-key"] === "string") {
    clone["x-api-key"] = "***redacted***";
  }
  if (typeof clone["x-anthropic-api-key"] === "string") {
    clone["x-anthropic-api-key"] = "***redacted***";
  }
  return clone;
}

const baseLoggingMiddleware = pinoHttp({
  logger,
  autoLogging: false, // Disable automatic logging so we can log manually with bodies
  customProps: (req, res) => ({
    sessionId: req.sessionId ?? null,
  }),
});

// Wrapper middleware to capture and log full request/response bodies
function loggingMiddleware(req, res, next) {
  const startTime = Date.now();

  // Log request with full body immediately
  logger.info({
    sessionId: req.sessionId ?? null,
    req: {
      method: req.method,
      url: req.url,
      headers: maskHeaders(req.headers),
    },
    requestBody: req.body, // Full request body without truncation
  }, 'request started');

  // Intercept res.write for streaming responses
  const originalWrite = res.write;
  const chunks = [];
  res.write = function (chunk) {
    if (chunk) {
      chunks.push(Buffer.from(chunk));
    }
    return originalWrite.apply(this, arguments);
  };

  // Intercept res.send to capture the body
  const originalSend = res.send;
  res.send = function (body) {
    res._capturedBody = body;

    // Parse if it's a JSON string for better logging
    if (typeof body === 'string') {
      try {
        res._capturedBody = JSON.parse(body);
      } catch (e) {
        res._capturedBody = body;
      }
    }

    return originalSend.call(this, body);
  };

  // Log response when finished
  res.on('finish', () => {
    const responseTime = Date.now() - startTime;

    // Capture streaming body if not already captured via send()
    if (chunks.length > 0 && !res._capturedBody) {
      const fullBody = Buffer.concat(chunks).toString('utf8');
      res._capturedBody = {
        type: 'stream',
        contentType: res.getHeader('content-type'),
        size: fullBody.length,
        preview: fullBody.substring(0, 1000)
      };
    }

    const logLevel = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';

    logger[logLevel]({
      sessionId: req.sessionId ?? null,
      req: {
        method: req.method,
        url: req.url,
        headers: maskHeaders(req.headers),
      },
      res: {
        statusCode: res.statusCode,
        headers: res.getHeaders ? res.getHeaders() : res.headers,
      },
      requestBody: req.body, // Full request body without truncation
      responseBody: res._capturedBody, // Full response body without truncation
      responseTime,
    }, 'request completed');
  });

  // Still call base middleware to set up req.log
  baseLoggingMiddleware(req, res, next);
}

module.exports = loggingMiddleware;
