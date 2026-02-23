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

// File output stream (LOG_FILE env var, e.g. ./logs/lynkr.log)
const logFile = process.env.LOG_FILE;
if (logFile) {
	const logDir = path.dirname(logFile);
	if (!fs.existsSync(logDir)) {
		fs.mkdirSync(logDir, { recursive: true });
	}
	streams.push({
		level: config.logger.level,
		stream: pino.destination({ dest: logFile, sync: false }),
	});
}

// Oversized error stream (if enabled)
if (config.oversizedErrorLogging?.enabled) {
	streams.push({
		level: "warn", // Only capture WARN and ERROR
		stream: createOversizedErrorStream(config.oversizedErrorLogging),
	});
}

// Create logger with multistream
const logger = pino(
	{
		level: config.logger.level,
		name: "claude-backend",
		base: {
			env: config.env,
		},
		// Use local timezone for timestamps instead of UTC
		timestamp: () => {
			const now = new Date();

			// Get all components in local timezone
			const year = now.getFullYear();
			const month = String(now.getMonth() + 1).padStart(2, '0');
			const day = String(now.getDate()).padStart(2, '0');
			const hours = String(now.getHours()).padStart(2, '0');
			const minutes = String(now.getMinutes()).padStart(2, '0');
			const seconds = String(now.getSeconds()).padStart(2, '0');
			const ms = String(now.getMilliseconds()).padStart(3, '0');

			// Get timezone offset
			const tzOffset = -now.getTimezoneOffset();
			const offsetHours = String(Math.floor(Math.abs(tzOffset) / 60)).padStart(2, '0');
			const offsetMins = String(Math.abs(tzOffset) % 60).padStart(2, '0');
			const offsetSign = tzOffset >= 0 ? '+' : '-';

			const timestamp = `${year}-${month}-${day}T${hours}:${minutes}:${seconds}.${ms}${offsetSign}${offsetHours}:${offsetMins}`;

			return `,"time":"${timestamp}"`;
		},
		redact: {
			paths: ["req.headers.authorization", "req.headers.cookie"],
			censor: "***redacted***",
		},
	},
	pino.multistream(streams),
);

module.exports = logger;
