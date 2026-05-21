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
const MIN_INDEX_SIZE = 1000;

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
      this.index.readIndexSync(INDEX_FILE, MAX_ELEMENTS);
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
  }

  async query(text) {
    if (!this.ready) this.load();
    if (!this.ready || !this.index || this.size < MIN_INDEX_SIZE) return null;
    if (!text || typeof text !== 'string') return null;

    const cache = getEmbeddingCache();
    let embedding = cache.get(text);
    if (!embedding) {
      try {
        embedding = await generateEmbedding(text);
        if (!embedding || embedding.length !== this.dim) {
          // Skip if dim mismatch (embedder produced different dimensions)
          return null;
        }
        cache.set(text, embedding);
      } catch (err) {
        logger.debug({ err: err.message }, '[KnnRouter] Embedding failed, skipping');
        return null;
      }
    }

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
          confidence: Math.min(1, agg.weight / K),
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
function getKnnRouter() {
  if (!_instance) {
    _instance = new KnnRouter();
    _instance.load();
  }
  return _instance;
}

module.exports = { KnnRouter, getKnnRouter };
