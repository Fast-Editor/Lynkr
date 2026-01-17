const pino = require("pino");

// Lazy-load config to avoid validation during --help/--version
let _config = null;
function getConfig() {
  if (!_config) {
    _config = require("../config");
  }
  return _config;
}

// Only use pino-pretty if explicitly requested via LOG_PRETTY env var.
// This avoids failures in production when pino-pretty isn't installed
// (it's a devDependency).
function createTransport() {
  const usePretty = process.env.LOG_PRETTY === "true" || process.env.LOG_PRETTY === "1";
  if (!usePretty) {
    return undefined;
  }

  try {
    // Check if pino-pretty is available before configuring transport
    require.resolve("pino-pretty");
    return {
      target: "pino-pretty",
      options: {
        translateTime: "SYS:standard",
        ignore: "pid,hostname",
        colorize: true,
      },
    };
  } catch {
    // pino-pretty not installed; fall back to JSON output
    console.error("[logger] LOG_PRETTY enabled but pino-pretty not installed, using JSON output");
    return undefined;
  }
}

const config = getConfig();
const logger = pino({
  level: config.logger.level,
  name: "claude-backend",
  base: {
    env: config.env,
  },
  redact: {
    paths: ["req.headers.authorization", "req.headers.cookie"],
    censor: "***redacted***",
  },
  transport: createTransport(),
});

module.exports = logger;
