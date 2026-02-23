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
  const { getOllamaHeaders } = require("../clients/ollama-utils");
  const endpoint = config.ollama?.embeddingsEndpoint || 'http://localhost:11434/api/embeddings';
  const model = config.ollama?.embeddingsModel || 'nomic-embed-text';

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: getOllamaHeaders(),
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

// Track if embedding provider is available
let embeddingProviderAvailable = null;

/**
 * Get the appropriate embedding function based on config
 * @returns {Function} - Embedding generation function
 */
function getEmbeddingFunction() {
  // If we already know embedding provider isn't available, use fallback
  if (embeddingProviderAvailable === false) {
    return (text) => Promise.resolve(generateHashEmbedding(text));
  }

  const provider = config.modelProvider?.type || 'databricks';

  // Check if we have a local embedding provider configured
  if (config.ollama?.embeddingsEndpoint || provider === 'ollama') {
    return async (text) => {
      try {
        const result = await generateOllamaEmbedding(text);
        embeddingProviderAvailable = true;
        return result;
      } catch (err) {
        logger.debug({ error: err.message }, 'Ollama embedding failed, using hash fallback');
        embeddingProviderAvailable = false;
        return generateHashEmbedding(text);
      }
    };
  }

  if (config.llamacpp?.embeddingsEndpoint || provider === 'llamacpp') {
    return async (text) => {
      try {
        const result = await generateLlamaCppEmbedding(text);
        embeddingProviderAvailable = true;
        return result;
      } catch (err) {
        logger.debug({ error: err.message }, 'LlamaCpp embedding failed, using hash fallback');
        embeddingProviderAvailable = false;
        return generateHashEmbedding(text);
      }
    };
  }

  // Fallback to hash-based embeddings
  logger.debug('No embedding provider configured, using hash-based fallback');
  return (text) => Promise.resolve(generateHashEmbedding(text));
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

  try {
    const embedFn = getEmbeddingFunction();
    return await embedFn(truncated);
  } catch (err) {
    // Final fallback to hash embeddings if everything else fails
    logger.debug({ error: err.message }, 'Embedding generation failed, using hash fallback');
    return generateHashEmbedding(truncated);
  }
}

/**
 * Reset embedding provider availability (for testing)
 */
function resetEmbeddingProvider() {
  embeddingProviderAvailable = null;
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
  resetEmbeddingProvider,
};
