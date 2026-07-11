const pino = require("pino");
const fs = require("fs");
const path = require("path");
const config = require("../config");
const { createOversizedErrorStream } = require("./oversized-error-stream");

/**
 * Application logger using Pino
 *
 * Standard Network Logging Fields:
 * When logging network requests/responses, use these consistent field names:
 *
 * - destinationUrl: string - Full URL being requested (e.g., "https://api.example.com/v1/endpoint")
 * - destinationHostname: string - Hostname only (e.g., "api.example.com")
 * - destinationIp: string - Resolved IP address (logged by DNS logger at debug level)
 * - ipFamily: number - IP version (4 or 6) - logged by DNS logger
 * - protocol: string - Protocol used ("http" or "https")
 * - status: number - HTTP status code
 * - provider: string - Service/provider label (e.g., "OpenAI", "HTTP", "HTTPS")
 * - duration: number - Request duration in milliseconds
 *
 * DNS Resolution Logging:
 * DNS resolution is logged at debug level via the dns-logger module.
 * To see DNS logs, set LOG_LEVEL=debug. DNS logs correlate with application
 * logs via the destinationHostname field.
 *
 * Example DNS log:
 * {
 *   "level": "debug",
 *   "provider": "HTTPS",
 *   "hostname": "api.openai.com",
 *   "resolvedIp": "104.18.23.45",
 *   "ipFamily": 4,
 *   "duration": 23,
 *   "msg": "DNS resolution completed"
 * }
 *
 * Example API request log:
 * {
 *   "level": "debug",
 *   "provider": "OpenAI",
 *   "status": 200,
 *   "destinationUrl": "https://api.openai.com/v1/chat/completions",
 *   "destinationHostname": "api.openai.com",
 *   "responseLength": 1523,
 *   "msg": "OpenAI API response"
 * }
 */

// Create array of streams for multistream setup
const streams = [];

// Main console output stream
streams.push({
	level: config.logger.level,
	stream:
		config.env === "development"
			? pino.transport({
					target: "pino-pretty",
					options: {
						translateTime: "SYS:standard",
						ignore: "pid,hostname",
						colorize: true,
					},
				})
			: process.stdout,
});

// File rotation stream (if enabled via LOG_FILE_ENABLED=true)
if (config.logger.file?.enabled) {
	const fileConfig = config.logger.file;
	// Ensure log directory exists
	const logDir = path.dirname(fileConfig.path);
	fs.mkdirSync(logDir, { recursive: true });

	streams.push({
		level: fileConfig.level,
		stream: pino.transport({
			target: "pino-roll",
			options: {
				file: fileConfig.path,
				frequency: fileConfig.frequency,
				limit: { count: fileConfig.maxFiles },
				mkdir: true,
			},
		}),
	});
}

// Oversized error stream (if enabled)
if (config.oversizedErrorLogging?.enabled) {
	streams.push({
		level: "warn", // Only capture WARN and ERROR
		stream: createOversizedErrorStream(config.oversizedErrorLogging),
	});
}

// Root level must be the most verbose of any enabled stream, or quieter
// streams starve louder ones: LOG_LEVEL=silent (the recommended wrap
// setting) used to make LOG_FILE_ENABLED capture nothing — the exact
// sessions that most need a log file. Per-stream levels still apply, so
// the console stays at LOG_LEVEL.
const LEVEL_ORDER = ["trace", "debug", "info", "warn", "error", "fatal", "silent"];
const rootLevel = streams
	.map((s) => s.level)
	.reduce(
		(min, l) => (LEVEL_ORDER.indexOf(l) < LEVEL_ORDER.indexOf(min) ? l : min),
		config.logger.level,
	);

// Create logger with multistream
const logger = pino(
	{
		level: rootLevel,
		name: "claude-backend",
		base: {
			env: config.env,
		},
		redact: {
			paths: ["req.headers.authorization", "req.headers.cookie"],
			censor: "***redacted***",
		},
	},
	pino.multistream(streams),
);

module.exports = logger;
