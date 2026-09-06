/**
 * ONNX embedder wiring (ROUTING-NOTES §4.10.2).
 *
 * Unit-level tests only: provider-branch selection, availability detection,
 * and fallthrough when the optionalDependency is missing. Real inference
 * (model download + embed) is deliberately NOT exercised here — it pulls
 * ~30MB from the HuggingFace hub and takes ~1 min cold. That path is
 * verified manually / in integration, not in the unit suite.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.DATABRICKS_API_KEY = process.env.DATABRICKS_API_KEY || 'test-key';
process.env.DATABRICKS_API_BASE = process.env.DATABRICKS_API_BASE || 'http://test.com';
process.env.LOG_FILE_ENABLED = 'false';

function freshEmbeddings() {
  delete require.cache[require.resolve('../src/cache/embeddings')];
  return require('../src/cache/embeddings');
}

function mockOnnxEmbedder({ available, vector }) {
  const modulePath = require.resolve('../src/cache/onnx-embedder');
  delete require.cache[modulePath];
  require.cache[modulePath] = {
    id: modulePath,
    filename: modulePath,
    loaded: true,
    exports: {
      isOnnxAvailable: () => available,
      generateOnnxEmbedding: async () => vector,
      _resetPipeline: () => {},
      MODEL_ID: 'mock-model',
    },
  };
}

function restoreOnnxEmbedder() {
  const modulePath = require.resolve('../src/cache/onnx-embedder');
  delete require.cache[modulePath];
}

test.afterEach(() => {
  delete process.env.LYNKR_EMBEDDINGS_PROVIDER;
  restoreOnnxEmbedder();
});

test('isOnnxAvailable reflects the installed optionalDependency', () => {
  const { isOnnxAvailable } = require('../src/cache/onnx-embedder');
  // In this repo the dep is installed; the check must agree with require.resolve.
  let resolvable = true;
  try { require.resolve('@huggingface/transformers'); } catch { resolvable = false; }
  assert.equal(isOnnxAvailable(), resolvable);
});

test('LYNKR_EMBEDDINGS_PROVIDER=onnx routes embedding through the in-process embedder', async () => {
  process.env.LYNKR_EMBEDDINGS_PROVIDER = 'onnx';
  const fake = new Array(768).fill(0.25);
  mockOnnxEmbedder({ available: true, vector: fake });
  const embeddings = freshEmbeddings();
  embeddings.resetEmbeddingProvider();

  const vec = await embeddings.generateEmbedding('hello');
  assert.equal(vec.length, 768);
  assert.equal(vec[0], 0.25);
  const status = embeddings.getEmbeddingStatus();
  assert.equal(status.providerAvailable, true, 'onnx path marks the provider healthy');
});

test('onnx requested but dependency missing falls through to the network provider chain', async () => {
  process.env.LYNKR_EMBEDDINGS_PROVIDER = 'onnx';
  mockOnnxEmbedder({ available: false, vector: null });
  const embeddings = freshEmbeddings();
  embeddings.resetEmbeddingProvider();

  // No Ollama/llamacpp endpoints reachable in unit tests — the chain ends at
  // the hash fallback (384-dim). The point: no crash, and the onnx branch
  // was skipped rather than erroring.
  const vec = await embeddings.generateEmbedding('hello');
  assert.ok(vec.length === 384 || vec.length === 768,
    `expected hash fallback (384) or a real provider vector (768), got ${vec.length}`);
});

test('onnx load failure degrades loudly via the shared degradation machinery', async () => {
  process.env.LYNKR_EMBEDDINGS_PROVIDER = 'onnx';
  const modulePath = require.resolve('../src/cache/onnx-embedder');
  delete require.cache[modulePath];
  require.cache[modulePath] = {
    id: modulePath,
    filename: modulePath,
    loaded: true,
    exports: {
      isOnnxAvailable: () => true,
      generateOnnxEmbedding: async () => { throw new Error('model load failed'); },
      _resetPipeline: () => {},
      MODEL_ID: 'mock-model',
    },
  };
  const embeddings = freshEmbeddings();
  embeddings.resetEmbeddingProvider();

  const vec = await embeddings.generateEmbedding('hello');
  assert.equal(vec.length, 384, 'hash fallback served');
  const status = embeddings.getEmbeddingStatus();
  assert.equal(status.providerAvailable, false, 'degraded state is recorded, not silent');
  assert.match(status.lastProviderError, /model load failed/);
});
