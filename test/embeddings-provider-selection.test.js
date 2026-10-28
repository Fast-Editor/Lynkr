/**
 * Local embedding-provider selection (GitHub #129).
 *
 * config ALWAYS derives ollama.embeddingsEndpoint from OLLAMA_ENDPOINT, so
 * the old `if (config.ollama?.embeddingsEndpoint || …)` check made the
 * llama.cpp branch unreachable: every llama.cpp deployment dialed
 * localhost:11434, failed, and degraded to hash vectors (which the 768-dim
 * kNN embedder rejects, dropping intent scoring to lexical mode).
 *
 * These tests pin the resolution order:
 *   EMBEDDINGS_PROVIDER > MODEL_PROVIDER > TIER_* providers
 *   > explicit LLAMACPP_EMBEDDINGS_ENDPOINT > legacy Ollama default.
 *
 * Both fake servers count hits, so "never dialed Ollama" is asserted, not
 * inferred. Like embeddings-degradation.test.js, this assumes no conflicting
 * .env in the cwd (config loads dotenv, which fills unset keys).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

process.env.DATABRICKS_API_KEY = process.env.DATABRICKS_API_KEY || 'test-key';
process.env.DATABRICKS_API_BASE = process.env.DATABRICKS_API_BASE || 'http://test.com';
process.env.LOG_FILE_ENABLED = 'false';
process.env.LYNKR_EMBEDDINGS_RETRY_COOLDOWN_MS = '1';

function fakeServer(counter) {
  return http.createServer((req, res) => {
    counter.hits += 1;
    counter.lastPath = req.url;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ embedding: new Array(768).fill(0.25) }));
  });
}

const ollamaCount = { hits: 0, lastPath: null };
const llamaCount = { hits: 0, lastPath: null };
const fakeOllama = fakeServer(ollamaCount);
const fakeLlama = fakeServer(llamaCount);
let ollamaUrl;
let llamaUrl;

const ENV_KEYS = [
  'EMBEDDINGS_PROVIDER', 'MODEL_PROVIDER',
  'TIER_SIMPLE', 'TIER_MEDIUM', 'TIER_COMPLEX', 'TIER_REASONING',
  'OLLAMA_ENDPOINT', 'OLLAMA_EMBEDDINGS_ENDPOINT',
  'LLAMACPP_ENDPOINT', 'LLAMACPP_EMBEDDINGS_ENDPOINT',
];
const saved = {};

function load(envOverrides) {
  for (const k of ENV_KEYS) delete process.env[k];
  Object.assign(process.env, envOverrides);
  delete require.cache[require.resolve('../src/config')];
  delete require.cache[require.resolve('../src/cache/embeddings')];
  const embeddings = require('../src/cache/embeddings');
  embeddings.resetEmbeddingProvider();
  ollamaCount.hits = 0; ollamaCount.lastPath = null;
  llamaCount.hits = 0; llamaCount.lastPath = null;
  return embeddings;
}

const ALL_LLAMACPP_TIERS = {
  TIER_SIMPLE: 'llamacpp:qwen2.5-coder',
  TIER_MEDIUM: 'llamacpp:qwen2.5-coder',
  TIER_COMPLEX: 'llamacpp:qwen3-32b',
  TIER_REASONING: 'llamacpp:qwen3-32b',
};

test.before(async () => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  await new Promise((r) => fakeOllama.listen(0, '127.0.0.1', r));
  await new Promise((r) => fakeLlama.listen(0, '127.0.0.1', r));
  ollamaUrl = `http://127.0.0.1:${fakeOllama.address().port}`;
  llamaUrl = `http://127.0.0.1:${fakeLlama.address().port}`;
});

test.after(() => {
  fakeOllama.close();
  fakeLlama.close();
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

test('all-llama.cpp deployment embeds via llama.cpp and never dials Ollama (#129)', async () => {
  const e = load({
    MODEL_PROVIDER: 'llamacpp',
    ...ALL_LLAMACPP_TIERS,
    LLAMACPP_ENDPOINT: llamaUrl,
    // An Ollama endpoint is always present in config (defaulted) — point it at
    // the counting fake so any dial is caught, not just a connection error.
    OLLAMA_ENDPOINT: ollamaUrl,
  });
  assert.equal(e.resolveLocalEmbeddingProvider(), 'llamacpp');
  const vec = await e.generateEmbedding('hello world');
  assert.equal(vec.length, 768, 'real provider vector, not the 384-dim hash fallback');
  assert.equal(llamaCount.hits, 1);
  assert.equal(llamaCount.lastPath, '/embeddings', 'llama.cpp embeddings route derived from LLAMACPP_ENDPOINT');
  assert.equal(ollamaCount.hits, 0, 'localhost Ollama must not be dialed');
  assert.equal(e.getEmbeddingStatus().providerAvailable, true);
});

test('TIER_* on llama.cpp selects llama.cpp even when MODEL_PROVIDER is a cloud provider', async () => {
  const e = load({
    MODEL_PROVIDER: 'databricks',
    ...ALL_LLAMACPP_TIERS,
    LLAMACPP_ENDPOINT: llamaUrl,
    OLLAMA_ENDPOINT: ollamaUrl,
  });
  assert.equal(e.resolveLocalEmbeddingProvider(), 'llamacpp');
  await e.generateEmbedding('tiers decide');
  assert.equal(llamaCount.hits, 1);
  assert.equal(ollamaCount.hits, 0);
});

test('EMBEDDINGS_PROVIDER=ollama overrides a llama.cpp MODEL_PROVIDER', async () => {
  const e = load({
    EMBEDDINGS_PROVIDER: 'ollama',
    MODEL_PROVIDER: 'llamacpp',
    ...ALL_LLAMACPP_TIERS,
    LLAMACPP_ENDPOINT: llamaUrl,
    OLLAMA_ENDPOINT: ollamaUrl,
  });
  assert.equal(e.resolveLocalEmbeddingProvider(), 'ollama');
  await e.generateEmbedding('explicit override');
  assert.equal(ollamaCount.hits, 1);
  assert.equal(ollamaCount.lastPath, '/api/embeddings');
  assert.equal(llamaCount.hits, 0);
});

test('a mixed deployment with any Ollama tier keeps Ollama embeddings', () => {
  const e = load({
    MODEL_PROVIDER: 'databricks',
    TIER_SIMPLE: 'ollama:qwen2.5-coder:latest',
    TIER_MEDIUM: 'llamacpp:qwen2.5-coder',
    TIER_COMPLEX: 'databricks:claude',
    TIER_REASONING: 'databricks:claude',
    OLLAMA_ENDPOINT: ollamaUrl,
    LLAMACPP_ENDPOINT: llamaUrl,
  });
  assert.equal(e.resolveLocalEmbeddingProvider(), 'ollama');
});

test('explicit LLAMACPP_EMBEDDINGS_ENDPOINT alone selects llama.cpp for a cloud-primary deployment', async () => {
  const e = load({
    MODEL_PROVIDER: 'databricks',
    LLAMACPP_EMBEDDINGS_ENDPOINT: `${llamaUrl}/embeddings`,
    OLLAMA_ENDPOINT: ollamaUrl,
  });
  assert.equal(e.resolveLocalEmbeddingProvider(), 'llamacpp');
  await e.generateEmbedding('explicit endpoint');
  assert.equal(llamaCount.hits, 1);
  assert.equal(ollamaCount.hits, 0);
});

test('legacy default is unchanged: nothing local configured → Ollama', () => {
  const e = load({ MODEL_PROVIDER: 'databricks' });
  assert.equal(e.resolveLocalEmbeddingProvider(), 'ollama');
});

test('legacy default is unchanged: explicit OLLAMA_EMBEDDINGS_ENDPOINT with a cloud primary → Ollama', async () => {
  const e = load({
    MODEL_PROVIDER: 'databricks',
    OLLAMA_EMBEDDINGS_ENDPOINT: `${ollamaUrl}/api/embeddings`,
  });
  assert.equal(e.resolveLocalEmbeddingProvider(), 'ollama');
  await e.generateEmbedding('legacy path');
  assert.equal(ollamaCount.hits, 1);
});
