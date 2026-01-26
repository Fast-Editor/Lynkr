const pino = require("pino");
const config = require("../config");

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
  transport:
    config.env === "development"
      ? {
          target: "pino-pretty",
          options: {
            translateTime: "SYS:standard",
            ignore: "pid,hostname",
            colorize: true,
          },
        }
      : undefined,
});

module.exports = logger;
