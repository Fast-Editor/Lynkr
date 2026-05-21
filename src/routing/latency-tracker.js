/**
 * Rolling Latency Tracker (per provider:model)
 *
 * Tracks latency keyed by `${provider}:${model}` so models within a provider
 * (Opus vs Haiku) get separate stats. Backward-compatible: callers that pass
 * only a provider still work — they're tracked under `${provider}:*`.
 *
 * Phase 1.5 of the routing overhaul: previous version keyed by provider only.
 *
 * @module routing/latency-tracker
 */

const logger = require("../logger");

const BUFFER_SIZE = 200;
const MIN_SAMPLES = 10;

/** Wildcard model used when caller doesn't specify one. */
const ANY_MODEL = '*';

function _key(provider, model) {
  return `${provider}:${model || ANY_MODEL}`;
}

class LatencyTracker {
  constructor() {
    /** @type {Map<string, { buffer: number[], index: number, count: number, lastUpdated: number, provider: string, model: string }>} */
    this._entries = new Map();
  }

  /**
   * Record a latency measurement.
   *
   * Signatures:
   *   record(provider, latencyMs)              // legacy
   *   record(provider, model, latencyMs)       // preferred
   */
  record(provider, modelOrLatency, maybeLatency) {
    let model;
    let latencyMs;
    if (typeof modelOrLatency === 'number') {
      model = ANY_MODEL;
      latencyMs = modelOrLatency;
    } else {
      model = modelOrLatency || ANY_MODEL;
      latencyMs = maybeLatency;
    }

    if (!provider || typeof latencyMs !== "number" || latencyMs < 0) return;

    const k = _key(provider, model);
    let entry = this._entries.get(k);
    if (!entry) {
      entry = {
        buffer: new Array(BUFFER_SIZE).fill(0),
        index: 0,
        count: 0,
        lastUpdated: 0,
        provider,
        model,
      };
      this._entries.set(k, entry);
    }
    entry.buffer[entry.index] = latencyMs;
    entry.index = (entry.index + 1) % BUFFER_SIZE;
    entry.count += 1;
    entry.lastUpdated = Date.now();
  }

  _computeStats(entry) {
    if (!entry || entry.count === 0) return null;
    const sampleCount = Math.min(entry.count, BUFFER_SIZE);
    const samples = entry.buffer.slice(0, sampleCount);
    const sorted = samples.slice().sort((a, b) => a - b);
    const sum = sorted.reduce((acc, v) => acc + v, 0);
    return {
      p50: sorted[Math.floor(sampleCount * 0.5)],
      p95: sorted[Math.floor(sampleCount * 0.95)],
      p99: sorted[Math.floor(sampleCount * 0.99)],
      avg: Math.round(sum / sampleCount),
      count: entry.count,
      lastUpdated: entry.lastUpdated,
      provider: entry.provider,
      model: entry.model,
    };
  }

  /**
   * Get stats for a specific (provider, model) pair, or aggregated for a provider
   * if model is omitted.
   */
  getStats(provider, model = null) {
    if (model) {
      return this._computeStats(this._entries.get(_key(provider, model)));
    }
    // Aggregate across all models for this provider
    const provEntries = [];
    for (const [k, entry] of this._entries) {
      if (entry.provider === provider) provEntries.push(entry);
    }
    if (provEntries.length === 0) return null;
    if (provEntries.length === 1) return this._computeStats(provEntries[0]);

    // Pool samples across model entries to compute combined percentiles
    const pooled = [];
    let total = 0;
    let lastUpdated = 0;
    for (const e of provEntries) {
      const n = Math.min(e.count, BUFFER_SIZE);
      for (let i = 0; i < n; i++) pooled.push(e.buffer[i]);
      total += e.count;
      if (e.lastUpdated > lastUpdated) lastUpdated = e.lastUpdated;
    }
    if (pooled.length === 0) return null;
    pooled.sort((a, b) => a - b);
    const sum = pooled.reduce((acc, v) => acc + v, 0);
    return {
      p50: pooled[Math.floor(pooled.length * 0.5)],
      p95: pooled[Math.floor(pooled.length * 0.95)],
      p99: pooled[Math.floor(pooled.length * 0.99)],
      avg: Math.round(sum / pooled.length),
      count: total,
      lastUpdated,
      provider,
      model: ANY_MODEL,
    };
  }

  /** Latency penalty/bonus used by complexity-analyzer. */
  penalizeScore(provider, model = null) {
    const stats = this.getStats(provider, model);
    if (!stats || stats.count < MIN_SAMPLES) return 0;
    if (stats.p95 > 10000) return 10;
    if (stats.p95 > 5000) return 5;
    if (stats.p50 < 1000) return -5;
    return 0;
  }

  /**
   * Phase 1.5: per-model P95 lookup for deadline-aware routing (Phase 6.3).
   * Returns null if insufficient samples.
   */
  getModelP95(provider, model) {
    const stats = this.getStats(provider, model);
    if (!stats || stats.count < MIN_SAMPLES) return null;
    return stats.p95;
  }

  /**
   * Whether a model is currently degraded (P95 > 2x its historical median).
   * Currently uses a simple absolute threshold — better signal will come in
   * Phase 4.3 (drift detection).
   */
  isDegraded(provider, model) {
    const stats = this.getStats(provider, model);
    if (!stats || stats.count < MIN_SAMPLES) return false;
    return stats.p95 > stats.p50 * 2 && stats.p95 > 5000;
  }

  /**
   * Get stats for every tracked entry.
   *
   * Backward-compat: when an entry was recorded via the legacy 2-arg
   * `record(provider, latency)` signature, the model is the wildcard `*`
   * and we return it keyed by provider name only. Entries with explicit
   * models use the `provider:model` key.
   */
  getAllStats() {
    const result = new Map();
    for (const [k, entry] of this._entries) {
      const stats = this._computeStats(entry);
      if (!stats) continue;
      const outKey = entry.model === ANY_MODEL ? entry.provider : k;
      result.set(outKey, stats);
    }
    return result;
  }
}

let instance = null;

function getLatencyTracker() {
  if (!instance) {
    instance = new LatencyTracker();
    logger.debug("LatencyTracker initialised");
  }
  return instance;
}

module.exports = { LatencyTracker, getLatencyTracker, ANY_MODEL };
