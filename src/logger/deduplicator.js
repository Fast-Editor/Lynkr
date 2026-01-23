const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const readline = require("readline");

/**
 * Content Deduplicator for LLM Audit Logs
 *
 * Implements content-addressable storage using SHA-256 hashes to deduplicate
 * repetitive content in audit logs. Large content blocks are stored once in a
 * dictionary file and referenced by hash in the main log.
 *
 * Key Features:
 * - Hash-based deduplication (SHA-256, first 16 chars)
 * - LRU cache for hot content (avoids disk I/O)
 * - Configurable minimum content size threshold
 * - Async dictionary writes for minimal latency impact
 * - Backward compatible (handles both references and inline content)
 *
 * Dictionary Format (JSONL):
 * {"hash": "sha256:abc...", "content": "...", "firstSeen": "ISO timestamp", "useCount": 123}
 *
 * Reference Format:
 * {"$ref": "sha256:abc...", "size": 1234}
 */

class LRUCache {
  constructor(maxSize = 100) {
    this.maxSize = maxSize;
    this.cache = new Map();
  }

  get(key) {
    if (!this.cache.has(key)) {
      return undefined;
    }
    // Move to end (most recently used)
    const value = this.cache.get(key);
    this.cache.delete(key);
    this.cache.set(key, value);
    return value;
  }

  set(key, value) {
    // Remove if exists (to update position)
    if (this.cache.has(key)) {
      this.cache.delete(key);
    }
    // Add to end
    this.cache.set(key, value);
    // Evict oldest if over size
    if (this.cache.size > this.maxSize) {
      const firstKey = this.cache.keys().next().value;
      this.cache.delete(firstKey);
    }
  }

  has(key) {
    return this.cache.has(key);
  }
}

class ContentDeduplicator {
  constructor(dictionaryPath, options = {}) {
    this.dictionaryPath = dictionaryPath;
    this.minSize = options.minSize || 500;
    this.cacheSize = options.cacheSize || 100;

    // LRU cache: hash -> content
    this.contentCache = new LRUCache(this.cacheSize);

    // Track usage counts: hash -> count
    this.usageCounts = new Map();

    // Track last seen timestamps: hash -> ISO timestamp
    this.lastSeenTimestamps = new Map();

    // Ensure dictionary directory exists
    const dictDir = path.dirname(this.dictionaryPath);
    if (!fs.existsSync(dictDir)) {
      fs.mkdirSync(dictDir, { recursive: true });
    }

    // Load existing dictionary into cache
    this._loadDictionary();
  }

  /**
   * Load existing dictionary file into cache
   * @private
   */
  _loadDictionary() {
    if (!fs.existsSync(this.dictionaryPath)) {
      return;
    }

    try {
      const fileStream = fs.createReadStream(this.dictionaryPath);
      const rl = readline.createInterface({
        input: fileStream,
        crlfDelay: Infinity,
      });

      rl.on("line", (line) => {
        try {
          const entry = JSON.parse(line);
          if (!entry.hash) return;

          // Handle full entry (has content)
          if (entry.content !== undefined && entry.content !== null) {
            this.contentCache.set(entry.hash, entry.content);
            this.usageCounts.set(entry.hash, entry.useCount || 1);
            this.lastSeenTimestamps.set(entry.hash, entry.lastSeen || entry.firstSeen);
          }
          // Handle update entry (content is null, only metadata)
          else if (entry.firstSeen === null) {
            // This is an update entry - update metadata only
            if (entry.useCount !== undefined) {
              this.usageCounts.set(entry.hash, entry.useCount);
            }
            if (entry.lastSeen) {
              this.lastSeenTimestamps.set(entry.hash, entry.lastSeen);
            }
          }
        } catch (err) {
          // Skip malformed lines (silent - don't pollute logs)
        }
      });

      // Suppress error events during load (file may not exist yet)
      rl.on("error", () => {
        // Silently ignore - dictionary will be created on first write
      });

      // Wait for file to be fully read (synchronously for initialization)
      return new Promise((resolve) => {
        rl.on("close", resolve);
      });
    } catch (err) {
      // Silently ignore load errors - dictionary will be created on first write
    }
  }

  /**
   * Compute SHA-256 hash of content (first 16 chars for brevity)
   * @param {string|object|array} content - Content to hash
   * @returns {string} Hash in format "sha256:abc..."
   */
  hashContent(content) {
    const stringContent = typeof content === "string" ? content : JSON.stringify(content);
    const hash = crypto.createHash("sha256").update(stringContent, "utf8").digest("hex");
    return `sha256:${hash.substring(0, 16)}`;
  }

  /**
   * Check if content should be deduplicated
   * @param {string|object|array} content - Content to check
   * @param {number} minSize - Minimum size threshold (default: from config)
   * @returns {boolean} True if content should be deduplicated
   */
  shouldDeduplicate(content, minSize = null) {
    if (!content) return false;

    const threshold = minSize !== null ? minSize : this.minSize;
    const stringContent = typeof content === "string" ? content : JSON.stringify(content);

    // Check size threshold
    if (stringContent.length < threshold) {
      return false;
    }

    // Don't deduplicate already truncated content (contains truncation indicators)
    if (
      typeof stringContent === "string" &&
      (stringContent.includes("[truncated,") || stringContent.includes("... [truncated"))
    ) {
      return false;
    }

    return true;
  }

  /**
   * Store content in dictionary and return reference
   * @param {string|object|array} content - Content to store
   * @returns {object} Reference object: { $ref: "sha256:abc...", size: 1234 }
   */
  storeContent(content) {
    if (!content) {
      return null;
    }

    const stringContent = typeof content === "string" ? content : JSON.stringify(content);
    const hash = this.hashContent(stringContent);
    const size = stringContent.length;

    // Update usage count
    const currentCount = this.usageCounts.get(hash) || 0;
    this.usageCounts.set(hash, currentCount + 1);

    // If already in cache, just return reference
    if (this.contentCache.has(hash)) {
      // Update lastSeen timestamp
      const now = new Date().toISOString();
      this.lastSeenTimestamps.set(hash, now);
      // Update dictionary entry asynchronously (increment useCount, update lastSeen)
      this._updateDictionaryEntry(hash, currentCount + 1, now);
      return { $ref: hash, size };
    }

    // Store in cache
    this.contentCache.set(hash, stringContent);

    // Track lastSeen
    const now = new Date().toISOString();
    this.lastSeenTimestamps.set(hash, now);

    // Append to dictionary file asynchronously
    this._appendToDictionary(hash, stringContent, currentCount + 1, now);

    return { $ref: hash, size };
  }

  /**
   * Append new entry to dictionary file
   * @private
   * @param {string} hash - Content hash
   * @param {string} content - Actual content
   * @param {number} useCount - Usage count
   * @param {string} timestamp - ISO timestamp for firstSeen/lastSeen
   */
  _appendToDictionary(hash, content, useCount, timestamp) {
    const entry = {
      hash,
      firstSeen: timestamp,
      useCount,
      lastSeen: timestamp,
      content,
    };

    // Async append (non-blocking)
    fs.appendFile(this.dictionaryPath, JSON.stringify(entry) + "\n", (err) => {
      if (err) {
        console.error("Failed to append to dictionary:", err.message);
      }
    });
  }

  /**
   * Update existing dictionary entry (append update line to dictionary)
   * @private
   * @param {string} hash - Content hash
   * @param {number} newCount - New usage count
   * @param {string} timestamp - ISO timestamp for lastSeen
   */
  _updateDictionaryEntry(hash, newCount, timestamp) {
    // Append an update entry with the same hash to track updated metadata
    // The reader/compactor should use the LAST entry for a given hash
    const updateEntry = {
      hash,
      firstSeen: null, // Null indicates this is an update, not a new entry
      useCount: newCount,
      lastSeen: timestamp,
      content: null,
    };

    // Async append (non-blocking)
    fs.appendFile(this.dictionaryPath, JSON.stringify(updateEntry) + "\n", (err) => {
      if (err) {
        console.error("Failed to append update to dictionary:", err.message);
      }
    });
  }

  /**
   * Retrieve content by hash reference
   * @param {string} hashRef - Hash reference (e.g., "sha256:abc...")
   * @returns {string|null} Content or null if not found
   */
  getContent(hashRef) {
    // Check cache first
    if (this.contentCache.has(hashRef)) {
      return this.contentCache.get(hashRef);
    }

    // If not in cache, read from dictionary (synchronously for now)
    return this._readFromDictionary(hashRef);
  }

  /**
   * Read content from dictionary file by hash
   * @private
   * @param {string} hashRef - Hash reference
   * @returns {string|null} Content or null if not found
   */
  _readFromDictionary(hashRef) {
    if (!fs.existsSync(this.dictionaryPath)) {
      return null;
    }

    try {
      const fileContent = fs.readFileSync(this.dictionaryPath, "utf8");
      const lines = fileContent.split("\n");

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line);
          if (entry.hash === hashRef) {
            // Cache it for future use
            this.contentCache.set(hashRef, entry.content);
            return entry.content;
          }
        } catch {
          // Skip malformed lines
        }
      }
    } catch (err) {
      console.error("Failed to read dictionary:", err.message);
    }

    return null;
  }

  /**
   * Process log entry fields for deduplication
   * @param {object} entry - Log entry object
   * @param {string[]} fields - Fields to deduplicate (default: common large fields)
   * @returns {object} Entry with deduplicated fields
   */
  deduplicateEntry(entry, fields = ["userMessages", "systemPrompt", "userQuery"]) {
    if (!entry || typeof entry !== "object") {
      return entry;
    }

    const deduplicated = { ...entry };

    for (const field of fields) {
      const content = entry[field];

      // Skip if field doesn't exist or is already a reference
      if (!content || (typeof content === "object" && content.$ref)) {
        continue;
      }

      // Check if should deduplicate
      if (this.shouldDeduplicate(content)) {
        const ref = this.storeContent(content);
        if (ref) {
          deduplicated[field] = ref;
        }
      }
    }

    return deduplicated;
  }

  /**
   * Restore full content from hash references in a log entry
   * @param {object} entry - Log entry with potential references
   * @returns {object} Entry with full content restored
   */
  restoreEntry(entry) {
    if (!entry || typeof entry !== "object") {
      return entry;
    }

    const restored = { ...entry };

    // Check all fields for references
    for (const [key, value] of Object.entries(entry)) {
      if (typeof value === "object" && value !== null && value.$ref) {
        const content = this.getContent(value.$ref);
        if (content !== null) {
          // Try to parse back to original type
          try {
            restored[key] = JSON.parse(content);
          } catch {
            restored[key] = content;
          }
        }
      }
    }

    return restored;
  }

  /**
   * Get statistics about deduplication
   * @returns {object} Statistics
   */
  getStats() {
    return {
      cacheSize: this.contentCache.cache.size,
      uniqueContentBlocks: this.usageCounts.size,
      totalReferences: Array.from(this.usageCounts.values()).reduce((a, b) => a + b, 0),
    };
  }
}

module.exports = {
  ContentDeduplicator,
  LRUCache,
};
