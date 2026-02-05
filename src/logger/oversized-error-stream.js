const fs = require("node:fs");
const path = require("node:path");
const { Writable } = require("node:stream");

/**
 * Custom Pino stream that captures oversized error messages to separate log files.
 * Errors from the same session are appended to a single file.
 */

// Cache of session file handles to enable appending
const sessionFiles = new Map();

// Track first error timestamp per session for filename
const sessionTimestamps = new Map();

/**
 * Creates a custom Pino stream that captures oversized errors
 * @param {Object} config - Configuration object
 * @param {number} config.threshold - Character threshold for capturing (default 200)
 * @param {string} config.logDir - Directory for oversized error logs
 * @param {number} config.maxFiles - Maximum number of log files to keep
 * @returns {Writable} - Writable stream for Pino
 */
function createOversizedErrorStream(config) {
	const { threshold = 200, logDir, maxFiles = 100 } = config;

	// Ensure log directory exists
	ensureDirectoryExists(logDir);

	// Create writable stream
	const stream = new Writable({
		objectMode: true,
		write(chunk, encoding, callback) {
			try {
				// Parse the log entry (Pino sends JSON strings)
				const logObject = typeof chunk === "string" ? JSON.parse(chunk) : chunk;

				// Check if this log should be captured
				const { shouldCapture, oversizedFields } = shouldCaptureLog(logObject, threshold);

				if (shouldCapture) {
					// Extract or generate session ID
					const sessionId = extractSessionId(logObject);

					// Get or create session file
					const { filepath, writeStream } = getSessionFile(sessionId, logDir, maxFiles);

					// Format the log entry
					const logEntry = formatLogEntry(logObject, oversizedFields);

					// Write to file (JSONL format - one JSON object per line)
					writeStream.write(`${JSON.stringify(logEntry)}\n`, (err) => {
						if (err) {
							console.error(`Failed to write oversized error to ${filepath}:`, err.message);
						}
					});
				}

				// Always call callback to continue stream processing
				callback();
			} catch (err) {
				// Don't crash on stream errors - log and continue
				console.error("Oversized error stream processing failed:", err.message);
				callback();
			}
		},
		final(callback) {
			// Close all open file handles when stream ends
			for (const [sessionId, { writeStream }] of sessionFiles.entries()) {
				writeStream.end();
			}
			sessionFiles.clear();
			sessionTimestamps.clear();
			callback();
		},
	});

	// Handle stream errors gracefully
	stream.on("error", (err) => {
		console.error("Oversized error stream error:", err.message);
	});

	return stream;
}

/**
 * Determines if a log entry should be captured based on size threshold
 * @param {Object} logObject - Pino log object
 * @param {number} threshold - Character threshold
 * @returns {Object} - { shouldCapture: boolean, oversizedFields: string[] }
 */
function shouldCaptureLog(logObject, threshold) {
	// Only capture WARN (40) and ERROR (50) level logs
	if (logObject.level < 40) {
		return { shouldCapture: false, oversizedFields: [] };
	}

	const oversizedFields = [];

	// Check all fields recursively
	function checkField(value, fieldPath) {
		if (typeof value === "string") {
			if (value.length > threshold) {
				oversizedFields.push(fieldPath);
			}
		} else if (typeof value === "object" && value !== null) {
			// Check nested objects/arrays
			for (const [key, val] of Object.entries(value)) {
				checkField(val, fieldPath ? `${fieldPath}.${key}` : key);
			}
		}
	}

	// Check all fields in log object
	for (const [key, value] of Object.entries(logObject)) {
		// Skip internal Pino fields
		if (["level", "time", "pid", "hostname"].includes(key)) continue;
		checkField(value, key);
	}

	return {
		shouldCapture: oversizedFields.length > 0,
		oversizedFields,
	};
}

/**
 * Extracts session ID from log object with fallback strategies
 * @param {Object} logObject - Pino log object
 * @returns {string} - Session ID or fallback identifier
 */
function extractSessionId(logObject) {
	// Try sessionId field first
	if (logObject.sessionId) return logObject.sessionId;

	// Try correlationId
	if (logObject.correlationId) return logObject.correlationId;

	// Try requestId
	if (logObject.requestId) return logObject.requestId;

	// Fallback to unknown with timestamp
	return `unknown-${Date.now()}`;
}

/**
 * Gets or creates a file handle for a session
 * @param {string} sessionId - Session identifier
 * @param {string} logDir - Log directory path
 * @param {number} maxFiles - Maximum number of files to keep
 * @returns {Object} - { filepath: string, writeStream: WriteStream }
 */
function getSessionFile(sessionId, logDir, maxFiles) {
	// Check if we already have a file for this session
	if (sessionFiles.has(sessionId)) {
		return sessionFiles.get(sessionId);
	}

	// Clean up old files if needed (before creating new one)
	cleanupOldFiles(logDir, maxFiles);

	// Generate timestamp for first error in this session
	const timestamp = new Date()
		.toISOString()
		.replace(/[-:]/g, "_")
		.replace(/\.\d{3}Z$/, "")
		.replace("T", "_");

	sessionTimestamps.set(sessionId, timestamp);

	// Create filename: {sessionId}_{timestamp}.log
	const filename = `${sessionId}_${timestamp}.log`;
	const filepath = path.join(logDir, filename);

	// Create write stream in append mode
	const writeStream = fs.createWriteStream(filepath, {
		flags: "a", // append mode
		encoding: "utf8",
	});

	// Handle write stream errors
	writeStream.on("error", (err) => {
		console.error(`Error writing to ${filepath}:`, err.message);
		sessionFiles.delete(sessionId);
	});

	// Cache the file handle
	const fileInfo = { filepath, writeStream };
	sessionFiles.set(sessionId, fileInfo);

	return fileInfo;
}

/**
 * Formats a log entry for file storage with metadata
 * @param {Object} logObject - Original Pino log object
 * @param {string[]} oversizedFields - List of fields that exceeded threshold
 * @returns {Object} - Formatted log entry
 */
function formatLogEntry(logObject, oversizedFields) {
	// Convert Pino timestamp (milliseconds since epoch) to ISO string
	const timestamp = new Date(logObject.time).toISOString();

	// Map Pino log level numbers to names
	const levelNames = {
		10: "TRACE",
		20: "DEBUG",
		30: "INFO",
		40: "WARN",
		50: "ERROR",
		60: "FATAL",
	};

	return {
		timestamp,
		level: levelNames[logObject.level] || "UNKNOWN",
		levelNumber: logObject.level,
		name: logObject.name,
		sessionId: extractSessionId(logObject),
		oversizedFields,
		...logObject, // Include all original fields
		// Remove redundant internal fields
		time: undefined,
		pid: undefined,
		hostname: undefined,
	};
}

/**
 * Removes oldest log files if count exceeds maximum
 * @param {string} logDir - Log directory path
 * @param {number} maxFiles - Maximum number of files to keep
 */
function cleanupOldFiles(logDir, maxFiles) {
	try {
		// List all .log files in directory
		const files = fs.readdirSync(logDir).filter((f) => f.endsWith(".log"));

		// If under limit, no cleanup needed
		if (files.length < maxFiles) return;

		// Get file stats and sort by modification time (oldest first)
		const fileStats = files
			.map((filename) => {
				const filepath = path.join(logDir, filename);
				const stats = fs.statSync(filepath);
				return { filename, filepath, mtime: stats.mtime };
			})
			.sort((a, b) => a.mtime - b.mtime);

		// Delete oldest files until we're under the limit
		const filesToDelete = fileStats.length - maxFiles + 1; // +1 to make room for new file
		for (let i = 0; i < filesToDelete; i++) {
			const { filepath } = fileStats[i];
			try {
				fs.unlinkSync(filepath);
			} catch (err) {
				console.error(`Failed to delete old oversized error log ${filepath}:`, err.message);
			}
		}
	} catch (err) {
		console.error("Failed to cleanup old oversized error logs:", err.message);
	}
}

/**
 * Ensures a directory exists, creating it if necessary
 * @param {string} dirPath - Directory path
 */
function ensureDirectoryExists(dirPath) {
	try {
		if (!fs.existsSync(dirPath)) {
			fs.mkdirSync(dirPath, { recursive: true });
		}
	} catch (err) {
		console.error(`Failed to create oversized error log directory ${dirPath}:`, err.message);
		throw err;
	}
}

module.exports = {
	createOversizedErrorStream,
	shouldCaptureLog,
	extractSessionId,
	getSessionFile,
	formatLogEntry,
	cleanupOldFiles,
};
