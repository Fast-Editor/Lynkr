/**
 * Semantic Response Cache
 *
 * Caches LLM responses with embeddings for semantic similarity matching.
 * If a new prompt is sufficiently similar to a cached one, returns the
 * cached response instantly without making an LLM call.
 *
 * @module cache/semantic
 */

const crypto = require('crypto');
const { generateEmbedding, cosineSimilarity } = require('./embeddings');
const logger = require('../logger');
const config = require('../config');

// Default configuration (can be overridden via config.semanticCache)
function getDefaultConfig() {
  const configOverrides = config.semanticCache || {};
  return {
    enabled: configOverrides.enabled ?? true,
    similarityThreshold: configOverrides.similarityThreshold ?? 0.92,
    maxEntries: configOverrides.maxEntries ?? 500,
    ttlMs: configOverrides.ttlMs ?? 3600000,  // 1 hour
    minPromptLength: 20,        // Don't cache very short prompts
    maxPromptLength: 5000,      // Don't cache very long prompts (too specific)
    excludePatterns: [          // Patterns to exclude from caching
      /current time/i,
      /today's date/i,
      /right now/i,
      /latest news/i,
      /weather/i,
    ],
  };
}

class SemanticCache {
  constructor(options = {}) {
    this.config = { ...getDefaultConfig(), ...options };
    this.cache = new Map(); // key -> { embedding, response, timestamp, hits }
    this.stats = {
      hits: 0,
      misses: 0,
      stores: 0,
      evictions: 0,
      avgSimilarity: 0,
      embeddingErrors: 0,
    };
    this.initialized = false;
  }

  /**
   * Initialize the semantic cache
   */
  async initialize() {
    if (this.initialized) return;

    // Test embedding generation
    try {
      const testEmbedding = await generateEmbedding('test');
      if (!testEmbedding || !Array.isArray(testEmbedding)) {
        throw new Error('Invalid embedding response');
      }
      this.embeddingDimensions = testEmbedding.length;
      logger.info({
        dimensions: this.embeddingDimensions,
        threshold: this.config.similarityThreshold,
        maxEntries: this.config.maxEntries,
      }, '[SemanticCache] Initialized');
      this.initialized = true;
    } catch (err) {
      logger.warn({ error: err.message }, '[SemanticCache] Failed to initialize, will use fallback');
      this.initialized = true; // Continue with fallback
    }
  }

  /**
   * Check if a prompt should be cached
   * @param {string} prompt - The prompt to check
   * @returns {boolean}
   */
  _shouldCache(prompt) {
    if (!prompt || typeof prompt !== 'string') return false;
    if (prompt.length < this.config.minPromptLength) return false;
    if (prompt.length > this.config.maxPromptLength) return false;

    // Check exclude patterns
    for (const pattern of this.config.excludePatterns) {
      if (pattern.test(prompt)) {
        return false;
      }
    }

    return true;
  }

  /**
   * Generate a hash of the conversation context for exact matching.
   * Includes system prompt + conversation state (tool results, message count).
   * This prevents false cache hits during tool execution loops.
   *
   * @param {Array} messages - Chat messages
   * @returns {string|null} - Hash of conversation context or null
   */
  _getConversationContextHash(messages) {
    if (!Array.isArray(messages)) return null;

    const hash = crypto.createHash('sha256');

    // Include system prompt
    const systemMsg = messages.find(m => m.role === 'system');
    if (systemMsg && typeof systemMsg.content === 'string') {
      hash.update(systemMsg.content);
    }

    // Include conversation state indicators to prevent tool loop caching
    // This captures: message count, presence of tool calls/results
    const conversationState = {
      messageCount: messages.length,
      hasToolUse: messages.some(m =>
        m.role === 'assistant' &&
        Array.isArray(m.content) &&
        m.content.some(c => c.type === 'tool_use')
      ),
      hasToolResult: messages.some(m =>
        m.role === 'user' &&
        Array.isArray(m.content) &&
        m.content.some(c => c.type === 'tool_result')
      ),
      // Count tool results to differentiate between different stages
      toolResultCount: messages.reduce((count, m) => {
        if (m.role === 'user' && Array.isArray(m.content)) {
          return count + m.content.filter(c => c.type === 'tool_result').length;
        }
        return count;
      }, 0),
    };

    hash.update(JSON.stringify(conversationState));

    return hash.digest('hex').substring(0, 16);
  }

  /**
   * Extract cacheable text from messages
   * IMPORTANT: Only extracts user message content, NOT system prompt.
   * System prompt is handled separately via hash for exact matching.
   * This prevents false cache hits when system prompts are large and similar.
   *
   * @param {Array} messages - Chat messages
   * @returns {string|null} - Extracted user prompt or null
   */
  _extractPrompt(messages) {
    if (!Array.isArray(messages) || messages.length === 0) return null;

    // Get the last user message as the primary prompt
    const userMessages = messages.filter(m => m.role === 'user');
    if (userMessages.length === 0) return null;

    const lastUser = userMessages[userMessages.length - 1];
    let content = '';

    if (typeof lastUser.content === 'string') {
      content = lastUser.content;
    } else if (Array.isArray(lastUser.content)) {
      // Extract text from content array
      content = lastUser.content
        .filter(part => part.type === 'text' || part.type === 'input_text')
        .map(part => part.text || part.input_text || '')
        .join('\n');
    }

    // REMOVED: System prompt inclusion was causing false cache hits
    // The system prompt is now handled via hash matching instead

    return content.trim() || null;
  }

  /**
   * Find the most similar cached response
   * IMPORTANT: Only matches entries with the same system prompt hash.
   * This ensures we don't serve cached responses from different system contexts.
   *
   * @param {number[]} embedding - Query embedding
   * @param {string|null} contextHash - Hash of current system prompt
   * @returns {{ entry: Object, similarity: number }|null}
   */
  _findSimilar(embedding, contextHash) {
    let bestMatch = null;
    let bestSimilarity = 0;

    const now = Date.now();

    for (const [key, entry] of this.cache) {
      // Skip expired entries
      if (now - entry.timestamp > this.config.ttlMs) {
        continue;
      }

      // CRITICAL: Only match entries with same system prompt hash
      // This prevents false hits when system prompts differ
      if (entry.contextHash !== contextHash) {
        continue;
      }

      const similarity = cosineSimilarity(embedding, entry.embedding);

      if (similarity > bestSimilarity) {
        bestSimilarity = similarity;
        bestMatch = { key, entry, similarity };
      }
    }

    return bestMatch;
  }

  /**
   * Evict old/least-used entries if cache is full
   */
  _evictIfNeeded() {
    if (this.cache.size < this.config.maxEntries) return;

    const now = Date.now();
    const toEvict = [];

    // First pass: collect expired entries
    for (const [key, entry] of this.cache) {
      if (now - entry.timestamp > this.config.ttlMs) {
        toEvict.push(key);
      }
    }

    // If not enough expired, evict least recently used
    if (toEvict.length < this.config.maxEntries * 0.1) {
      const entries = Array.from(this.cache.entries())
        .sort((a, b) => {
          // Sort by hits (ascending) then by timestamp (ascending)
          if (a[1].hits !== b[1].hits) {
            return a[1].hits - b[1].hits;
          }
          return a[1].timestamp - b[1].timestamp;
        });

      // Mark bottom 20% for eviction
      const evictCount = Math.ceil(this.config.maxEntries * 0.2);
      for (let i = 0; i < evictCount && i < entries.length; i++) {
        toEvict.push(entries[i][0]);
      }
    }

    // Evict
    for (const key of toEvict) {
      this.cache.delete(key);
      this.stats.evictions++;
    }

    if (toEvict.length > 0) {
      logger.debug({ evicted: toEvict.length }, '[SemanticCache] Evicted entries');
    }
  }

  /**
   * Look up a semantically similar cached response
   * Requires BOTH:
   * 1. Same system prompt (exact hash match)
   * 2. Semantically similar user message (above threshold)
   *
   * @param {Array} messages - Chat messages
   * @returns {Promise<{ hit: boolean, response?: Object, similarity?: number }>}
   */
  async lookup(messages) {
    if (!this.config.enabled) {
      return { hit: false };
    }

    if (!this.initialized) {
      await this.initialize();
    }

    const prompt = this._extractPrompt(messages);
    const contextHash = this._getConversationContextHash(messages);

    if (!prompt || !this._shouldCache(prompt)) {
      this.stats.misses++;
      return { hit: false };
    }

    try {
      const embedding = await generateEmbedding(prompt);
      // Pass system hash to ensure we only match same-context entries
      const match = this._findSimilar(embedding, contextHash);

      if (match && match.similarity >= this.config.similarityThreshold) {
        // Cache hit!
        match.entry.hits++;
        match.entry.lastAccess = Date.now();
        this.stats.hits++;

        // Update rolling average similarity
        this.stats.avgSimilarity =
          (this.stats.avgSimilarity * (this.stats.hits - 1) + match.similarity) / this.stats.hits;

        logger.info({
          similarity: match.similarity.toFixed(4),
          promptPreview: prompt.substring(0, 100),
          contextHash: contextHash?.substring(0, 8),
          cacheHits: match.entry.hits,
        }, '[SemanticCache] Cache hit');

        return {
          hit: true,
          response: match.entry.response,
          similarity: match.similarity,
          cacheKey: match.key,
        };
      }

      this.stats.misses++;
      return {
        hit: false,
        embedding, // Return embedding for later storage
        prompt,
        contextHash, // Return for storage
      };

    } catch (err) {
      this.stats.embeddingErrors++;
      logger.debug({ error: err.message }, '[SemanticCache] Embedding generation failed');
      this.stats.misses++;
      return { hit: false };
    }
  }

  /**
   * Store a response in the cache
   * @param {Object} lookupResult - Result from lookup() with embedding
   * @param {Object} response - The LLM response to cache
   */
  async store(lookupResult, response) {
    if (!this.config.enabled) return;
    if (!lookupResult || lookupResult.hit) return; // Don't store if it was a hit
    if (!response) return;

    // Don't cache forced responses from ToolLoopGuard
    if (response.id?.startsWith('msg_forced_')) {
      logger.debug('[SemanticCache] Skipping cache for forced ToolLoopGuard response');
      return;
    }

    // Don't cache responses that contain tool_use (intermediate responses)
    if (Array.isArray(response.content)) {
      const hasToolUse = response.content.some(block => block?.type === 'tool_use');
      if (hasToolUse) {
        logger.debug('[SemanticCache] Skipping cache for response with tool_use');
        return;
      }
    }

    const { embedding, prompt, contextHash } = lookupResult;
    if (!embedding || !prompt) return;

    // Generate a cache key
    const key = `sem_${Date.now()}_${Math.random().toString(36).substring(7)}`;

    this._evictIfNeeded();

    this.cache.set(key, {
      embedding,
      contextHash, // Store system hash for context matching
      prompt: prompt.substring(0, 500), // Store truncated prompt for debugging
      response: this._cloneResponse(response),
      timestamp: Date.now(),
      lastAccess: Date.now(),
      hits: 0,
    });

    this.stats.stores++;

    logger.debug({
      cacheSize: this.cache.size,
      promptPreview: prompt.substring(0, 100),
      contextHash: contextHash?.substring(0, 8),
    }, '[SemanticCache] Stored response');
  }

  /**
   * Clone response for storage (strip streaming artifacts)
   */
  _cloneResponse(response) {
    // Deep clone and clean
    const cloned = JSON.parse(JSON.stringify(response));

    // Mark as from semantic cache
    if (cloned) {
      cloned._semanticCache = true;
    }

    return cloned;
  }

  /**
   * Clear the cache
   */
  clear() {
    this.cache.clear();
    logger.info('[SemanticCache] Cache cleared');
  }

  /**
   * Get cache statistics
   */
  getStats() {
    const hitRate = this.stats.hits + this.stats.misses > 0
      ? (this.stats.hits / (this.stats.hits + this.stats.misses) * 100).toFixed(2)
      : 0;

    return {
      ...this.stats,
      hitRate: `${hitRate}%`,
      cacheSize: this.cache.size,
      maxEntries: this.config.maxEntries,
      threshold: this.config.similarityThreshold,
    };
  }

  /**
   * Check if cache is enabled
   */
  isEnabled() {
    return this.config.enabled;
  }
}

// Singleton instance
let instance = null;

/**
 * Get the semantic cache instance
 * @param {Object} options - Cache options (only used on first call)
 * @returns {SemanticCache}
 */
function getSemanticCache(options) {
  if (!instance) {
    instance = new SemanticCache(options);
  }
  return instance;
}

/**
 * Check if semantic cache is enabled
 * @returns {boolean}
 */
function isSemanticCacheEnabled() {
  return instance?.isEnabled() ?? false;
}

module.exports = {
  SemanticCache,
  getSemanticCache,
  isSemanticCacheEnabled,
};
