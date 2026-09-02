/**
 * Embedding Generation
 *
 * Generates text embeddings using configured provider (Ollama, OpenAI, etc.)
 * Used for semantic similarity matching in response cache.
 *
 * @module cache/embeddings
 */

const config = require('../config');
const logger = require('../logger');

/**
 * Generate embedding for text using Ollama
 * @param {string} text - Text to embed
 * @returns {Promise<number[]>} - Embedding vector
 */
async function generateOllamaEmbedding(text) {
  const endpoint = config.ollama?.embeddingsEndpoint || 'http://localhost:11434/api/embeddings';
  const model = config.ollama?.embeddingsModel || 'nomic-embed-text';

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      prompt: text,
    }),
  });

  if (!response.ok) {
    throw new Error(`Ollama embedding failed: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  return data.embedding;
}

/**
 * Generate embedding for text using LlamaCpp
 * @param {string} text - Text to embed
 * @returns {Promise<number[]>} - Embedding vector
 */
async function generateLlamaCppEmbedding(text) {
  const endpoint = config.llamacpp?.embeddingsEndpoint || 'http://localhost:8080/embeddings';

  const headers = { 'Content-Type': 'application/json' };
  if (config.llamacpp?.apiKey) {
    headers['Authorization'] = `Bearer ${config.llamacpp.apiKey}`;
  }

  const response = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify({ content: text }),
  });

  if (!response.ok) {
    throw new Error(`LlamaCpp embedding failed: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  return data.embedding;
}

/**
 * Simple hash-based pseudo-embedding (fallback when no embedding provider)
 * Uses character n-grams to create a fixed-size vector
 * Not as good as real embeddings but better than nothing
 * @param {string} text - Text to embed
 * @param {number} dimensions - Vector dimensions
 * @returns {number[]} - Pseudo-embedding vector
 */
function generateHashEmbedding(text, dimensions = 384) {
  const normalized = text.toLowerCase().replace(/\s+/g, ' ').trim();
  const vector = new Array(dimensions).fill(0);

  // Use character trigrams
  for (let i = 0; i < normalized.length - 2; i++) {
    const trigram = normalized.substring(i, i + 3);
    const hash = simpleHash(trigram);
    const index = Math.abs(hash) % dimensions;
    vector[index] += 1;
  }

  // Add word-level features
  const words = normalized.split(/\s+/);
  for (const word of words) {
    const hash = simpleHash(word);
    const index = Math.abs(hash) % dimensions;
    vector[index] += 2; // Words weighted more than trigrams
  }

  // Normalize to unit vector
  const magnitude = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
  if (magnitude > 0) {
    for (let i = 0; i < dimensions; i++) {
      vector[i] /= magnitude;
    }
  }

  return vector;
}

/**
 * Simple string hash function
 */
function simpleHash(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return hash;
}

// Embedding provider availability state.
//
// The hash fallback is NOT a semantic embedding — when it's active, the
// semantic cache and kNN router are effectively disabled (hash vectors are
// 384-dim vs the providers' 768-dim, so they never match real entries; the
// kNN index rejects them on dimension). Historically this degradation was a
// permanent latch (one transient provider failure disabled semantic matching
// until process restart) and logged only at debug level — i.e. invisible.
// The same failure shape elsewhere in the industry silently misrouted ~20%
// of a production cluster's spend before anyone noticed, so this state is
// now: retried on a cooldown, logged loudly on every transition, counted,
// and exposed via getEmbeddingStatus() for /metrics.
let embeddingProviderAvailable = null;
let degradedSince = null;
let lastProviderAttempt = 0;
let fallbackCount = 0;
let lastProviderError = null;

// After a provider failure, wait this long before trying it again (instead
// of latching to the fallback forever). Env-tunable for tests/impatience.
const RETRY_COOLDOWN_MS = Number.parseInt(process.env.LYNKR_EMBEDDINGS_RETRY_COOLDOWN_MS, 10) || 60_000;

// Strict mode: throw instead of silently degrading to hash embeddings.
// For deployments that prefer fail-loud (no semantic cache is better than a
// silently fake one). Default stays fail-soft to match Lynkr's philosophy.
const STRICT = process.env.LYNKR_EMBEDDINGS_STRICT === 'true';

function _noteFallback(providerName, err) {
  fallbackCount += 1;
  lastProviderError = err?.message || String(err);
  if (embeddingProviderAvailable !== false) {
    embeddingProviderAvailable = false;
    degradedSince = Date.now();
    logger.warn({
      provider: providerName,
      error: lastProviderError,
      retryCooldownMs: RETRY_COOLDOWN_MS,
    }, '[Embeddings] Provider unreachable — DEGRADED to non-semantic hash embeddings. Semantic cache and kNN routing are effectively disabled until the provider recovers.');
  }
}

function _noteRecovery(providerName) {
  if (embeddingProviderAvailable === false) {
    logger.info({
      provider: providerName,
      degradedForMs: degradedSince ? Date.now() - degradedSince : null,
      fallbacksServed: fallbackCount,
    }, '[Embeddings] Provider recovered — semantic embeddings restored');
  }
  embeddingProviderAvailable = true;
  degradedSince = null;
}

function _wrapProvider(providerName, providerFn) {
  return async (text) => {
    // While degraded, only re-attempt the provider after the cooldown; serve
    // the fallback in between so a dead provider doesn't add per-request
    // connect timeouts to the hot path.
    if (embeddingProviderAvailable === false
        && Date.now() - lastProviderAttempt < RETRY_COOLDOWN_MS) {
      if (STRICT) throw new Error(`Embedding provider ${providerName} degraded: ${lastProviderError}`);
      fallbackCount += 1;
      return generateHashEmbedding(text);
    }
    lastProviderAttempt = Date.now();
    try {
      const result = await providerFn(text);
      _noteRecovery(providerName);
      return result;
    } catch (err) {
      _noteFallback(providerName, err);
      if (STRICT) throw err;
      return generateHashEmbedding(text);
    }
  };
}

/**
 * Get the appropriate embedding function based on config
 * @returns {Function} - Embedding generation function
 */
function getEmbeddingFunction() {
  const provider = config.modelProvider?.type || 'databricks';

  // In-process ONNX embedder (opt-in): no external embedding server on the
  // hot path at all. Same underlying model as the Ollama default
  // (nomic-embed-text, 768-dim), so existing kNN/cache vectors stay valid.
  // Wrapped in the same degradation machinery — a failed model load logs
  // loudly, serves the hash fallback, and retries after the cooldown.
  if (process.env.LYNKR_EMBEDDINGS_PROVIDER === 'onnx') {
    const { generateOnnxEmbedding, isOnnxAvailable } = require('./onnx-embedder');
    if (isOnnxAvailable()) {
      return _wrapProvider('onnx', generateOnnxEmbedding);
    }
    logger.warn('[Embeddings] LYNKR_EMBEDDINGS_PROVIDER=onnx but @huggingface/transformers is not installed (optionalDependency) — falling through to the configured network provider');
  }

  // Check if we have a local embedding provider configured
  if (config.ollama?.embeddingsEndpoint || provider === 'ollama') {
    return _wrapProvider('ollama', generateOllamaEmbedding);
  }

  if (config.llamacpp?.embeddingsEndpoint || provider === 'llamacpp') {
    return _wrapProvider('llamacpp', generateLlamaCppEmbedding);
  }

  // No provider configured at all — hash fallback is the deliberate mode,
  // not a degradation. Warn once so the operator knows semantic matching is
  // approximate, then stay quiet.
  if (embeddingProviderAvailable === null) {
    embeddingProviderAvailable = false;
    logger.warn('[Embeddings] No embedding provider configured — using non-semantic hash embeddings. Semantic cache matches will be approximate; configure an Ollama/llama.cpp embeddings endpoint for real semantic matching.');
  }
  return (text) => Promise.resolve(generateHashEmbedding(text));
}

/**
 * Current embedding subsystem status, for /metrics and health surfaces.
 * @returns {{ providerAvailable: boolean|null, degradedSince: number|null,
 *             fallbackCount: number, lastProviderError: string|null }}
 */
function getEmbeddingStatus() {
  return {
    providerAvailable: embeddingProviderAvailable,
    degradedSince,
    fallbackCount,
    lastProviderError,
  };
}

/**
 * Generate embedding for text
 * @param {string} text - Text to embed
 * @returns {Promise<number[]>} - Embedding vector
 */
async function generateEmbedding(text) {
  if (!text || typeof text !== 'string' || text.trim().length === 0) {
    throw new Error('Cannot generate embedding for empty text');
  }

  // Truncate very long text (most embedding models have limits)
  const maxLength = 8000;
  const truncated = text.length > maxLength ? text.substring(0, maxLength) : text;

  const embedFn = getEmbeddingFunction();
  if (STRICT) return embedFn(truncated);
  try {
    return await embedFn(truncated);
  } catch (err) {
    // Final fallback to hash embeddings if everything else fails. The
    // provider wrapper already logged the degradation transition loudly;
    // this catch only covers unexpected non-provider errors.
    logger.warn({ error: err.message }, '[Embeddings] Embedding generation failed unexpectedly, serving hash fallback');
    fallbackCount += 1;
    return generateHashEmbedding(truncated);
  }
}

/**
 * Reset embedding provider availability (for testing)
 */
function resetEmbeddingProvider() {
  embeddingProviderAvailable = null;
  degradedSince = null;
  lastProviderAttempt = 0;
  fallbackCount = 0;
  lastProviderError = null;
}

/**
 * Compute cosine similarity between two vectors
 * @param {number[]} a - First vector
 * @param {number[]} b - Second vector
 * @returns {number} - Similarity score (0-1)
 */
function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) {
    return 0;
  }

  let dotProduct = 0;
  let magnitudeA = 0;
  let magnitudeB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    magnitudeA += a[i] * a[i];
    magnitudeB += b[i] * b[i];
  }

  magnitudeA = Math.sqrt(magnitudeA);
  magnitudeB = Math.sqrt(magnitudeB);

  if (magnitudeA === 0 || magnitudeB === 0) {
    return 0;
  }

  return dotProduct / (magnitudeA * magnitudeB);
}

module.exports = {
  generateEmbedding,
  generateHashEmbedding,
  cosineSimilarity,
  getEmbeddingFunction,
  getEmbeddingStatus,
  resetEmbeddingProvider,
};
