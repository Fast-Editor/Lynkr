/**
 * kNN-based routing decision (Phase 3.1).
 *
 * Embeds the incoming query, finds the K nearest historical queries from the
 * hnswlib-node index, and returns a confidence-weighted recommendation
 * (model, expected quality, expected cost) based on those neighbors' actual
 * outcomes from telemetry.
 *
 * Behavior:
 *   - Empty index → returns null. Caller falls back to heuristic router.
 *   - Sparse index (N < MIN_INDEX_SIZE) → returns null. Heuristic wins until
 *     we have enough data to be confident.
 *   - Embedder unavailable → returns null. Same fallback path.
 *
 * Bootstrap: scripts/build-knn-index.js (also accepts optional RouterBench
 * corpus path to seed the index).
 */

const fs = require('fs');
const path = require('path');
const logger = require('../logger');
const { generateEmbedding } = require('../cache/embeddings');
const { getEmbeddingCache } = require('./embedding-cache');

const INDEX_DIR = path.join(__dirname, '../../data/knn');
const INDEX_FILE = path.join(INDEX_DIR, 'index.hnsw');
const META_FILE = path.join(INDEX_DIR, 'meta.json');

const MAX_ELEMENTS = 50000;
const DIM = 768; // nomic-embed-text default
const K = 10;
// WS5.2 — lowered from 1000 → 100 so kNN advises earlier. The `query()`
// path dampens confidence by `min(1, size/1000)` when the index is small,
// so the HIGH/LOW thresholds in `src/routing/index.js` still gate strong
// advice properly. Override with LYNKR_KNN_MIN_INDEX_SIZE.
const MIN_INDEX_SIZE = Number.parseInt(process.env.LYNKR_KNN_MIN_INDEX_SIZE, 10) || 100;
// Cold-start confidence damping — under this many entries, confidence is
// linearly damped; at DAMP_FULL_SIZE and above, damping is a no-op.
const DAMP_FULL_SIZE = 1000;
// Persist the index every N `add()` calls so online growth survives crashes.
const SAVE_EVERY_N_ADDS = 50;

let _hnsw = null;
let _hnswLoaded = false;
function _loadHnsw() {
  if (_hnswLoaded) return _hnsw;
  _hnswLoaded = true;
  try {
    _hnsw = require('hnswlib-node');
  } catch (err) {
    logger.debug({ err: err.message }, '[KnnRouter] hnswlib-node not available');
    _hnsw = null;
  }
  return _hnsw;
}

class KnnRouter {
  constructor() {
    this.index = null;
    this.meta = []; // parallel to index: per-id outcome { query, model, quality, cost, latency, tier }
    this.size = 0;
    this.dim = DIM;
    this.ready = false;
  }

  load() {
    const hnsw = _loadHnsw();
    if (!hnsw) return false;
    try {
      if (!fs.existsSync(INDEX_FILE) || !fs.existsSync(META_FILE)) {
        // Initialize empty index (caller can add() later)
        this.index = new hnsw.HierarchicalNSW('cosine', this.dim);
        this.index.initIndex(MAX_ELEMENTS);
        this.meta = [];
        this.size = 0;
        this.ready = true;
        return true;
      }
      const metaData = JSON.parse(fs.readFileSync(META_FILE, 'utf8'));
      this.dim = metaData.dim || DIM;
      this.meta = metaData.entries || [];
      this.size = this.meta.length;
      this.index = new hnsw.HierarchicalNSW('cosine', this.dim);
      // hnswlib-node v3 API: readIndexSync(filename, allowReplaceDeleted=false).
      // (Earlier Lynkr code passed MAX_ELEMENTS here — wrong type, threw on load.)
      this.index.readIndexSync(INDEX_FILE, false);
      // resize if needed so we can keep adding up to MAX_ELEMENTS
      try { this.index.resizeIndex(MAX_ELEMENTS); } catch (_) {}
      this.ready = true;
      logger.info({ size: this.size, dim: this.dim }, '[KnnRouter] Index loaded');
      return true;
    } catch (err) {
      logger.warn({ err: err.message }, '[KnnRouter] Index load failed');
      return false;
    }
  }

  save() {
    if (!this.ready || !this.index) return;
    try {
      fs.mkdirSync(INDEX_DIR, { recursive: true });
      this.index.writeIndexSync(INDEX_FILE);
      fs.writeFileSync(META_FILE, JSON.stringify({ dim: this.dim, entries: this.meta }, null, 0));
    } catch (err) {
      logger.warn({ err: err.message }, '[KnnRouter] Index save failed');
    }
  }

  add(embedding, outcome) {
    if (!this.ready || !this.index || !Array.isArray(embedding)) return;
    if (this.size >= MAX_ELEMENTS) {
      // Simple FIFO eviction: drop the oldest meta and reuse its id
      // hnswlib doesn't support deletion in place; we just stop adding past max
      return;
    }
    this.index.addPoint(embedding, this.size);
    this.meta.push(outcome);
    this.size++;
    // WS5.2 — persist online growth incrementally so a crash doesn't lose
    // the learning done since the last full-index rebuild.
    if (this.size % SAVE_EVERY_N_ADDS === 0) this.save();
  }

  /**
   * WS5.2 — expose the embedder to callers so the routing decision can
   * capture the query's embedding at decision time and attach it to the
   * decision object for the feedback path to consume without paying for a
   * second embedding call. Returns null when the embedder is unavailable
   * or the returned vector doesn't match the index dimension.
   *
   * @param {string} text
   * @returns {Promise<number[]|null>}
   */
  async embed(text) {
    if (!text || typeof text !== 'string') return null;
    const cache = getEmbeddingCache();
    const cached = cache.get(text);
    if (cached) return cached;
    try {
      const embedding = await generateEmbedding(text);
      if (!embedding || embedding.length !== this.dim) return null;
      cache.set(text, embedding);
      return embedding;
    } catch (err) {
      logger.debug({ err: err.message }, '[KnnRouter] embed() failed');
      return null;
    }
  }

  async query(text) {
    if (!this.ready) this.load();
    if (!this.ready || !this.index || this.size < MIN_INDEX_SIZE) return null;
    if (!text || typeof text !== 'string') return null;

    const embedding = await this.embed(text);
    if (!embedding) return null;

    let result;
    try {
      result = this.index.searchKnn(embedding, K);
    } catch (err) {
      logger.debug({ err: err.message }, '[KnnRouter] Search failed');
      return null;
    }

    const neighbors = (result.neighbors || []).map((id, i) => ({
      id,
      distance: result.distances?.[i] ?? 1,
      outcome: this.meta[id],
    })).filter(n => n.outcome);

    if (neighbors.length === 0) return null;

    // Confidence-weighted aggregation per candidate model.
    // weight = 1 - distance (cosine distance → similarity)
    const byModel = new Map();
    for (const n of neighbors) {
      const w = Math.max(0, 1 - n.distance);
      const m = `${n.outcome.provider}:${n.outcome.model}`;
      if (!byModel.has(m)) {
        byModel.set(m, { weight: 0, quality: 0, cost: 0, latency: 0, count: 0, sample: n.outcome });
      }
      const agg = byModel.get(m);
      agg.weight += w;
      agg.quality += w * (n.outcome.quality || 50);
      agg.cost += w * (n.outcome.cost || 0);
      agg.latency += w * (n.outcome.latency || 0);
      agg.count++;
    }

    // WS5.2 — cold-start damping. Below DAMP_FULL_SIZE, multiply confidence
    // by size/DAMP_FULL_SIZE so a small index advises weakly. The upstream
    // HIGH/LOW thresholds in index.js then naturally treat sparse advice as
    // ambiguous rather than trusting it. At/above DAMP_FULL_SIZE the factor
    // is 1 (no damping).
    const dampFactor = Math.min(1, this.size / DAMP_FULL_SIZE);

    let best = null;
    let bestScore = -Infinity;
    for (const [model, agg] of byModel) {
      const avgQ = agg.quality / agg.weight;
      const avgC = agg.cost / agg.weight;
      // Score = quality / log(cost+1) — reward quality, penalise cost gently
      const score = avgQ / Math.log(avgC * 1000 + 2);
      if (score > bestScore) {
        bestScore = score;
        best = {
          provider: agg.sample.provider,
          model: agg.sample.model,
          tier: agg.sample.tier,
          expectedQuality: avgQ,
          expectedCost: avgC,
          expectedLatency: agg.latency / agg.weight,
          confidence: Math.min(1, agg.weight / K) * dampFactor,
          neighborCount: agg.count,
        };
      }
    }

    return best;
  }

  getStats() {
    return {
      size: this.size,
      maxElements: MAX_ELEMENTS,
      ready: this.ready,
      dim: this.dim,
    };
  }
}

let _instance = null;
let _beforeExitBound = false;
function getKnnRouter() {
  if (!_instance) {
    _instance = new KnnRouter();
    _instance.load();
    // WS5.2 — best-effort persistence on graceful exit so any online
    // learning done since the last incremental save isn't lost. Bound once
    // per process; the save() call itself no-ops when the index isn't
    // ready, so this is safe even in test environments that never populate
    // the router.
    if (!_beforeExitBound) {
      _beforeExitBound = true;
      try {
        process.on('beforeExit', () => {
          try { _instance && _instance.save(); } catch (_) { /* best-effort */ }
        });
      } catch (_) { /* not a node process (e.g. worker) */ }
    }
  }
  return _instance;
}

module.exports = {
  KnnRouter,
  getKnnRouter,
  MIN_INDEX_SIZE,
  DAMP_FULL_SIZE,
  SAVE_EVERY_N_ADDS,
};
