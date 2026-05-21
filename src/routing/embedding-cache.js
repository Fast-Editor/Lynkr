/**
 * In-memory LRU cache for query embeddings.
 *
 * Used by Phase 3.1 (kNN router) and Phase 4.3 (drift detector) to avoid
 * repeated embedding calls for queries we've already seen.
 */

const crypto = require('crypto');
const logger = require('../logger');

const DEFAULT_MAX = 5000;

class EmbeddingCache {
  constructor(maxSize = DEFAULT_MAX) {
    this.maxSize = maxSize;
    this.cache = new Map(); // hash -> { embedding, lastAccess }
    this.hits = 0;
    this.misses = 0;
  }

  _hash(text) {
    return crypto.createHash('sha1').update(text).digest('hex');
  }

  get(text) {
    if (!text || typeof text !== 'string') return null;
    const key = this._hash(text);
    const entry = this.cache.get(key);
    if (!entry) {
      this.misses++;
      return null;
    }
    // LRU touch
    this.cache.delete(key);
    entry.lastAccess = Date.now();
    this.cache.set(key, entry);
    this.hits++;
    return entry.embedding;
  }

  set(text, embedding) {
    if (!text || !embedding) return;
    const key = this._hash(text);
    if (this.cache.has(key)) this.cache.delete(key);
    this.cache.set(key, { embedding, lastAccess: Date.now() });
    if (this.cache.size > this.maxSize) {
      // Evict least-recently-used (Map keeps insertion/access order)
      const oldest = this.cache.keys().next().value;
      this.cache.delete(oldest);
    }
  }

  getStats() {
    const total = this.hits + this.misses;
    return {
      size: this.cache.size,
      maxSize: this.maxSize,
      hits: this.hits,
      misses: this.misses,
      hitRate: total > 0 ? (this.hits / total).toFixed(3) : '0',
    };
  }

  clear() {
    this.cache.clear();
    this.hits = 0;
    this.misses = 0;
  }
}

let _instance = null;
function getEmbeddingCache() {
  if (!_instance) _instance = new EmbeddingCache();
  return _instance;
}

module.exports = { EmbeddingCache, getEmbeddingCache };
