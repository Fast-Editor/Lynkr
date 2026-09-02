/**
 * In-process ONNX embedder (ROUTING-NOTES §4.10.2).
 *
 * Runs the embedding model inside the Lynkr process via transformers.js
 * (@huggingface/transformers, an optionalDependency), removing the external
 * Ollama/llama.cpp server from the semantic-cache and kNN hot path — no
 * network hop, no "is the server up" failure mode, no contention with
 * completion traffic on the same local runtime.
 *
 * Model choice is deliberate: the ONNX build of the SAME model the Ollama
 * path defaults to (nomic-embed-text, 768-dim). Same model = same embedding
 * space = existing kNN index entries and semantic-cache vectors stay valid.
 * (INT8 quantization introduces small numeric differences vs Ollama's
 * serving precision, but cosine similarity is preserved far above the 0.92
 * cache threshold.)
 *
 * Weights are downloaded once from the HuggingFace hub into
 * ~/.lynkr/models (override: LYNKR_ONNX_CACHE_DIR) and verified by
 * transformers.js's own integrity checks. Nothing is bundled in the npm
 * package.
 *
 * Opt-in via LYNKR_EMBEDDINGS_PROVIDER=onnx. If the optional dependency is
 * missing or the model fails to load, the caller's degradation machinery
 * (cache/embeddings.js) takes over — loud, observable, recoverable.
 *
 * @module cache/onnx-embedder
 */

const os = require('os');
const path = require('path');
const logger = require('../logger');

const MODEL_ID = process.env.LYNKR_ONNX_EMBEDDING_MODEL || 'Xenova/nomic-embed-text-v1';
const CACHE_DIR = process.env.LYNKR_ONNX_CACHE_DIR
  || path.join(os.homedir(), '.lynkr', 'models');
// q8 keeps the download ~25–35MB and inference CPU-friendly.
const DTYPE = process.env.LYNKR_ONNX_DTYPE || 'q8';

/** @type {Promise<Function>|null} memoized pipeline load (single flight) */
let pipelinePromise = null;

async function _loadPipeline() {
  // Lazy, inside the function: @huggingface/transformers is an
  // optionalDependency and an ESM-only package — import() from CJS.
  const { pipeline, env } = await import('@huggingface/transformers');
  env.cacheDir = CACHE_DIR;
  const started = Date.now();
  logger.info({ model: MODEL_ID, cacheDir: CACHE_DIR, dtype: DTYPE },
    '[OnnxEmbedder] Loading embedding model (first run downloads weights)');
  const extractor = await pipeline('feature-extraction', MODEL_ID, { dtype: DTYPE });
  logger.info({ model: MODEL_ID, loadMs: Date.now() - started },
    '[OnnxEmbedder] Embedding model ready');
  return extractor;
}

/**
 * Generate an embedding fully in-process.
 * @param {string} text
 * @returns {Promise<number[]>} mean-pooled, L2-normalized vector (768-dim
 *   for the default model)
 */
async function generateOnnxEmbedding(text) {
  if (!pipelinePromise) {
    pipelinePromise = _loadPipeline().catch((err) => {
      // Reset so a later call can retry (e.g. transient download failure) —
      // a failed load must not latch permanently, same principle as the
      // provider degradation fix in cache/embeddings.js.
      pipelinePromise = null;
      throw err;
    });
  }
  const extractor = await pipelinePromise;
  const output = await extractor(text, { pooling: 'mean', normalize: true });
  return Array.from(output.data);
}

/** True when the optional dependency is installed (cheap resolve check). */
function isOnnxAvailable() {
  try {
    require.resolve('@huggingface/transformers');
    return true;
  } catch {
    return false;
  }
}

/** Test helper — drop the memoized pipeline. */
function _resetPipeline() {
  pipelinePromise = null;
}

module.exports = { generateOnnxEmbedding, isOnnxAvailable, _resetPipeline, MODEL_ID };
