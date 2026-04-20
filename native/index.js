/**
 * Lynkr Native — Rust-powered hot-path functions
 *
 * Loads the native .node addon for 10-50x speedup on:
 * - Complexity analysis (regex patterns)
 * - Cache key computation (recursive sort + SHA-256)
 * - Structural similarity (Jaccard on line sets)
 * - Text normalization (ANSI strip + whitespace collapse)
 * - Payload size estimation
 *
 * Falls back to JS implementations if the native addon is unavailable.
 */

let native = null;

try {
  native = require('./lynkr-native.node');
} catch {
  // Native addon not available — fall back to JS
}

module.exports = {
  available: native !== null,
  analyzeComplexityNative: native?.analyzeComplexityNative ?? null,
  computeCacheKey: native?.computeCacheKey ?? null,
  structuralSimilarity: native?.structuralSimilarity ?? null,
  normalizeText: native?.normalizeText ?? null,
  estimatePayloadSize: native?.estimatePayloadSize ?? null,
};
