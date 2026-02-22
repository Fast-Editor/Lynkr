const pino = require("pino");
const path = require("path");
const fs = require("fs");
const { ContentDeduplicator } = require("./deduplicator");

/**
 * LLM Audit Logger
 *
 * Dedicated logger for capturing LLM request/response audit trails.
 * Logs to a separate file for easy parsing, searching, and compliance.
 *
 * Log Entry Types:
 * - llm_request: User messages sent to LLM providers
 * - llm_response: LLM responses received from providers
 *
 * Key Features:
 * - Separate log file (llm-audit.log) for easy parsing
 * - Correlation IDs to link requests with responses
 * - Network destination tracking (IP, hostname, URL)
 * - Content truncation to control log size
 * - Async writes for minimal latency impact
 * - Daily log rotation with configurable retention
 */

/**
 * Create audit logger instance
 * @param {Object} config - Audit configuration
 * @returns {Object} Pino logger instance
 */
function createAuditLogger(config) {
  // Ensure log directory exists
  const logDir = path.dirname(config.logFile);
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
  }

  // Create dedicated pino instance for audit logs
  const auditLogger = pino(
    {
      level: "info", // Always log at info level for compliance
      name: "llm-audit",
      base: null, // Don't include pid/hostname to keep logs clean
      // Use local timezone for timestamps instead of UTC
      timestamp: () => {
        const now = new Date();
        const isoString = now.toISOString();
        const offset = -now.getTimezoneOffset();
        const offsetHours = String(Math.floor(Math.abs(offset) / 60)).padStart(2, '0');
        const offsetMins = String(Math.abs(offset) % 60).padStart(2, '0');
        const offsetSign = offset >= 0 ? '+' : '-';
        // Replace Z with local offset (e.g., +05:30 or -08:00)
        const localIso = isoString.replace('Z', `${offsetSign}${offsetHours}:${offsetMins}`);
        return `,"time":"${localIso}"`;
      },
      formatters: {
        level: (label) => {
          return { level: label };
        },
      },
    },
    pino.destination({
      dest: config.logFile,
      sync: false, // Async writes for performance
      mkdir: true,
    })
  );

  return auditLogger;
}

/**
 * Truncate content if it exceeds max length
 * @param {string|Array|Object} content - Content to truncate
 * @param {number} maxLength - Maximum length (0 = no truncation)
 * @returns {Object} { content, truncated, originalLength }
 */
function truncateContent(content, maxLength) {
  if (maxLength === 0) {
    return { content, truncated: false, originalLength: null };
  }

  // Handle different content types
  let stringContent;
  if (typeof content === "string") {
    stringContent = content;
  } else if (Array.isArray(content)) {
    stringContent = JSON.stringify(content);
  } else if (typeof content === "object" && content !== null) {
    stringContent = JSON.stringify(content);
  } else {
    return { content, truncated: false, originalLength: null };
  }

  const originalLength = stringContent.length;

  if (originalLength <= maxLength) {
    return { content, truncated: false, originalLength };
  }

  // Truncate and add indicator
  const truncated = stringContent.substring(0, maxLength);
  const indicator = `... [truncated, ${originalLength - maxLength} chars omitted]`;

  // Try to parse back to original type if it was JSON
  if (typeof content !== "string") {
    try {
      return {
        content: truncated + indicator,
        truncated: true,
        originalLength,
      };
    } catch {
      return {
        content: truncated + indicator,
        truncated: true,
        originalLength,
      };
    }
  }

  return {
    content: truncated + indicator,
    truncated: true,
    originalLength,
  };
}

/**
 * Hash and truncate content for audit logging
 * Hashes the ORIGINAL content before truncation to preserve full content hash
 * @param {string|Array|Object} content - Content to hash and truncate
 * @param {number} maxLength - Maximum length for truncation (0 = no truncation)
 * @param {ContentDeduplicator} deduplicator - Deduplicator instance for hashing
 * @returns {Object} { hash, content, truncated, originalLength }
 */
function hashAndTruncate(content, maxLength, deduplicator) {
  if (!content) {
    return { hash: null, content: null, truncated: false, originalLength: null };
  }

  // Hash the ORIGINAL content before any truncation
  const hash = deduplicator ? deduplicator.hashContent(content) : null;

  // Then truncate for display
  const truncationResult = truncateContent(content, maxLength);

  return {
    hash,
    content: truncationResult.content,
    truncated: truncationResult.truncated,
    originalLength: truncationResult.originalLength,
  };
}

/**
 * Smart truncation for system reminder content
 * Keeps first N characters and everything from the LAST </system-reminder> tag onwards
 * @param {string|Array|Object} content - Content to truncate
 * @param {number} prefixLength - Length of prefix to keep (default: 50)
 * @returns {Object} { content, truncated, originalLength, charsRemoved }
 */
function truncateSystemReminder(content, prefixLength = 50) {
  // Handle different content types
  let stringContent;
  if (typeof content === "string") {
    stringContent = content;
  } else if (Array.isArray(content)) {
    stringContent = JSON.stringify(content);
  } else if (typeof content === "object" && content !== null) {
    stringContent = JSON.stringify(content);
  } else {
    return { content, truncated: false, originalLength: null, charsRemoved: 0 };
  }

  const originalLength = stringContent.length;

  // Find the LAST occurrence of </system-reminder> tag
  const tagIndex = stringContent.lastIndexOf("</system-reminder>");

  // If tag not found, return unchanged
  if (tagIndex === -1) {
    return { content, truncated: false, originalLength, charsRemoved: 0 };
  }

  // If tag is within the prefix, don't truncate
  if (tagIndex < prefixLength) {
    return { content, truncated: false, originalLength, charsRemoved: 0 };
  }

  // Extract prefix and suffix
  const prefix = stringContent.substring(0, prefixLength);
  const suffix = stringContent.substring(tagIndex);

  // Calculate what would be removed
  const charsRemoved = tagIndex - prefixLength;

  // If removal would be insignificant (< 100 chars), don't truncate
  if (charsRemoved < 100) {
    return { content, truncated: false, originalLength, charsRemoved: 0 };
  }

  // Build truncated content
  const truncatedContent = prefix + "..." + suffix;

  return {
    content: truncatedContent,
    truncated: true,
    originalLength,
    charsRemoved,
  };
}

/**
 * Hash and apply smart truncation for system reminder content
 * Hashes the ORIGINAL content before truncation
 * @param {string|Array|Object} content - Content to hash and truncate
 * @param {number} prefixLength - Length of prefix to keep (default: 50)
 * @param {ContentDeduplicator} deduplicator - Deduplicator instance for hashing
 * @returns {Object} { hash, content, truncated, originalLength, charsRemoved }
 */
function hashAndTruncateSystemReminder(content, prefixLength = 50, deduplicator) {
  if (!content) {
    return { hash: null, content: null, truncated: false, originalLength: null, charsRemoved: 0 };
  }

  // Hash the ORIGINAL content before any truncation
  const hash = deduplicator ? deduplicator.hashContent(content) : null;

  // Then apply smart truncation
  const truncationResult = truncateSystemReminder(content, prefixLength);

  return {
    hash,
    content: truncationResult.content,
    truncated: truncationResult.truncated,
    originalLength: truncationResult.originalLength,
    charsRemoved: truncationResult.charsRemoved,
  };
}

/**
 * Extract hostname and port from URL
 * @param {string} url - Full URL
 * @returns {Object} { hostname, port }
 */
function parseDestinationUrl(url) {
  try {
    const parsed = new URL(url);
    return {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
      protocol: parsed.protocol.replace(":", ""),
    };
  } catch {
    return { hostname: null, port: null, protocol: null };
  }
}

/**
 * Create audit logger wrapper with convenience methods
 * @param {Object} config - Audit configuration from config.js
 * @returns {Object} Audit logger interface
 */
function createAuditLoggerWrapper(config) {
  if (!config.enabled) {
    // Return no-op logger if disabled
    return {
      logLlmRequest: () => {},
      logLlmResponse: () => {},
      restoreLogEntry: (entry) => entry,
      enabled: false,
    };
  }

  const logger = createAuditLogger(config);

  // Support both legacy single value and new object format for maxContentLength
  const maxContentLength =
    typeof config.maxContentLength === 'object'
      ? config.maxContentLength
      : {
          systemPrompt: config.maxContentLength || 5000,
          userMessages: config.maxContentLength || 5000,
          response: config.maxContentLength || 5000,
        };

  // Initialize deduplicator if enabled
  const deduplicator =
    config.deduplication?.enabled
      ? new ContentDeduplicator(config.deduplication.dictionaryPath, {
          minSize: config.deduplication.minSize,
          cacheSize: config.deduplication.cacheSize,
          sanitize: config.deduplication.sanitize,
          sessionCache: config.deduplication.sessionCache,
        })
      : null;

  /**
   * Log hash annotation line for easy lookup
   * @private
   * @param {Object} hashes - Hash values to annotate
   */
  function logHashAnnotation(hashes) {
    if (!config.annotations) {
      return; // Skip if annotations disabled
    }

    const annotationEntry = {
      _annotation: true,
      lookup: "Use: node scripts/audit-log-reader.js --hash <hash>",
    };

    // Add any provided hashes
    if (hashes.systemPromptHash) {
      annotationEntry.systemPromptHash = hashes.systemPromptHash;
    }
    if (hashes.userMessagesHash) {
      annotationEntry.userMessagesHash = hashes.userMessagesHash;
    }
    if (hashes.userQueryHash) {
      annotationEntry.userQueryHash = hashes.userQueryHash;
    }

    logger.info(annotationEntry);
  }

  return {
    /**
     * Log LLM request (user message sent to provider)
     * @param {Object} context - Request context
     */
    logLlmRequest(context) {
      const {
        correlationId,
        sessionId,
        provider,
        model,
        stream,
        destinationUrl,
        userMessages,
        systemPrompt,
        tools,
        maxTokens,
      } = context;

      const { hostname, port, protocol } = parseDestinationUrl(destinationUrl);

      // Hash BEFORE truncate - this ensures we track the original content
      // Use specific max lengths for different content types
      const hashedMessages = hashAndTruncate(userMessages, maxContentLength.userMessages, deduplicator);
      const hashedSystem = systemPrompt
        ? hashAndTruncate(systemPrompt, maxContentLength.systemPrompt, deduplicator)
        : { hash: null, content: null, truncated: false };

      // Deduplicate large content if enabled (using original content hash)
      // Session-level deduplication: first time outputs truncated content, subsequent times output reference
      let finalUserMessages = hashedMessages.content;
      let finalSystemPrompt = hashedSystem.content;

      if (deduplicator) {
        // Deduplicate userMessages if original content is large enough
        if (userMessages && deduplicator.shouldDeduplicate(userMessages)) {
          const isFirstTime = deduplicator.isFirstTimeInSession(hashedMessages.hash);
          if (isFirstTime) {
            // First time: output truncated content, but store in dictionary
            deduplicator.storeContentWithHash(userMessages, hashedMessages.hash);
            finalUserMessages = hashedMessages.content; // Use truncated content
          } else {
            // Subsequent times: output only reference
            finalUserMessages = deduplicator.storeContentWithHash(
              userMessages,
              hashedMessages.hash
            );
          }
        }

        // Deduplicate systemPrompt if original content is large enough
        if (systemPrompt && deduplicator.shouldDeduplicate(systemPrompt)) {
          const isFirstTime = deduplicator.isFirstTimeInSession(hashedSystem.hash);
          if (isFirstTime) {
            // First time: output truncated content, but store in dictionary
            deduplicator.storeContentWithHash(systemPrompt, hashedSystem.hash);
            finalSystemPrompt = hashedSystem.content; // Use truncated content
          } else {
            // Subsequent times: output only reference
            finalSystemPrompt = deduplicator.storeContentWithHash(
              systemPrompt,
              hashedSystem.hash
            );
          }
        }
      }

      const logEntry = {
        type: "llm_request",
        correlationId,
        sessionId,
        provider,
        model,
        stream: stream || false,
        destinationUrl,
        destinationHostname: hostname,
        destinationPort: port,
        protocol,
        userMessages: finalUserMessages,
        systemPrompt: finalSystemPrompt,
        tools: Array.isArray(tools) ? tools : null,
        maxTokens: maxTokens || null,
        contentTruncated: hashedMessages.truncated || hashedSystem.truncated,
        msg: "LLM request initiated",
      };

      // Add original length indicators if truncated
      if (hashedMessages.truncated) {
        logEntry.userMessagesOriginalLength = hashedMessages.originalLength;
      }
      if (hashedSystem.truncated) {
        logEntry.systemPromptOriginalLength = hashedSystem.originalLength;
      }

      logger.info(logEntry);

      // Log hash annotation for easy lookup
      logHashAnnotation({
        userMessagesHash: hashedMessages.hash,
        systemPromptHash: hashedSystem.hash,
      });
    },

    /**
     * Log LLM response (response received from provider)
     * @param {Object} context - Response context
     */
    logLlmResponse(context) {
      const {
        correlationId,
        sessionId,
        provider,
        model,
        stream,
        destinationUrl,
        destinationHostname,
        destinationIp,
        destinationIpFamily,
        assistantMessage,
        stopReason,
        requestTokens,
        responseTokens,
        latencyMs,
        status,
        error,
        streamingNote,
      } = context;

      const { hostname, port, protocol } = parseDestinationUrl(destinationUrl);

      // Truncate response content if needed (but not for streaming)
      let truncatedMessage = { content: null, truncated: false };
      if (assistantMessage && !stream) {
        truncatedMessage = truncateContent(assistantMessage, maxContentLength.response);
      }

      const logEntry = {
        type: "llm_response",
        correlationId,
        sessionId,
        provider,
        model,
        stream: stream || false,
        destinationUrl,
        destinationHostname: destinationHostname || hostname,
        destinationPort: port,
        destinationIp: destinationIp || null,
        destinationIpFamily: destinationIpFamily || null,
        protocol,
        status: status || null,
        latencyMs: latencyMs || null,
        msg: error ? "LLM request failed" : "LLM response received",
      };

      // Add response content for non-streaming
      if (!stream && assistantMessage) {
        logEntry.assistantMessage = truncatedMessage.content;
        logEntry.stopReason = stopReason || null;
        logEntry.contentTruncated = truncatedMessage.truncated;
        if (truncatedMessage.truncated) {
          logEntry.assistantMessageOriginalLength = truncatedMessage.originalLength;
        }
      }

      // Add streaming note if applicable
      if (stream && streamingNote) {
        logEntry.streamingNote = streamingNote;
      }

      // Add token usage
      if (requestTokens || responseTokens) {
        logEntry.usage = {
          requestTokens: requestTokens || null,
          responseTokens: responseTokens || null,
          totalTokens: (requestTokens || 0) + (responseTokens || 0),
        };
      }

      // Add error details if present
      if (error) {
        logEntry.error = typeof error === "string" ? error : error.message || "Unknown error";
        logEntry.errorStack = error.stack || null;
      }

      logger.info(logEntry);
    },

    /**
     * Log query-response pair with full content (NO truncation)
     * This is logged AFTER the response for easy query/response correlation
     * @param {Object} context - Query-response context
     */
    logQueryResponsePair(context) {
      const {
        correlationId,
        sessionId,
        provider,
        model,
        requestTime,
        responseTime,
        userQuery,
        assistantResponse,
        stopReason,
        latencyMs,
        requestTokens,
        responseTokens,
      } = context;

      // Hash BEFORE truncate - apply smart truncation to userQuery
      const hashedQuery = hashAndTruncateSystemReminder(userQuery, 50, deduplicator);

      // Deduplicate userQuery if original content is large enough
      // Session-level deduplication: first time outputs truncated content, subsequent times output reference
      let finalUserQuery = hashedQuery.content;
      if (deduplicator && userQuery && deduplicator.shouldDeduplicate(userQuery)) {
        const isFirstTime = deduplicator.isFirstTimeInSession(hashedQuery.hash);
        if (isFirstTime) {
          // First time: output truncated content, but store in dictionary
          deduplicator.storeContentWithHash(userQuery, hashedQuery.hash);
          finalUserQuery = hashedQuery.content; // Use truncated content
        } else {
          // Subsequent times: output only reference
          finalUserQuery = deduplicator.storeContentWithHash(userQuery, hashedQuery.hash);
        }
      }

      const logEntry = {
        type: "llm_query_response_pair",
        correlationId,
        sessionId,
        provider,
        model,
        requestTime,
        responseTime,
        latencyMs: latencyMs || null,
        userQuery: finalUserQuery, // Smart truncation + deduplication applied
        assistantResponse, // Full response, NO truncation or deduplication (usually unique)
        stopReason: stopReason || null,
        msg: "Query-response pair (full content)",
      };

      // Add truncation metadata if truncation occurred
      if (hashedQuery.truncated) {
        logEntry.userQueryTruncated = true;
        logEntry.userQueryOriginalLength = hashedQuery.originalLength;
        logEntry.userQueryCharsRemoved = hashedQuery.charsRemoved;
      }

      // Add token usage if available
      if (requestTokens || responseTokens) {
        logEntry.usage = {
          requestTokens: requestTokens || null,
          responseTokens: responseTokens || null,
          totalTokens: (requestTokens || 0) + (responseTokens || 0),
        };
      }

      logger.info(logEntry);

      // Log hash annotation for easy lookup
      logHashAnnotation({
        userQueryHash: hashedQuery.hash,
      });
    },

    /**
     * Restore full content from hash references in a log entry
     * @param {Object} entry - Log entry with potential hash references
     * @returns {Object} Entry with full content restored
     */
    restoreLogEntry(entry) {
      return deduplicator ? deduplicator.restoreEntry(entry) : entry;
    },

    /**
     * Get deduplication statistics
     * @returns {Object|null} Statistics or null if deduplication disabled
     */
    getDeduplicationStats() {
      return deduplicator ? deduplicator.getStats() : null;
    },

    enabled: true,
  };
}

module.exports = {
  createAuditLogger: createAuditLoggerWrapper,
  truncateContent,
  truncateSystemReminder,
  hashAndTruncate,
  hashAndTruncateSystemReminder,
  parseDestinationUrl,
};
