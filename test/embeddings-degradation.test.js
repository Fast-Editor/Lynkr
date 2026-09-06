/**
 * Embedding-provider degradation behavior (ROUTING-NOTES §4.10.1).
 *
 * The hash fallback is non-semantic — while it's active, semantic cache and
 * kNN matching are effectively disabled. Previously a single provider
 * failure latched the fallback permanently (until process restart) and
 * logged only at debug level. These tests pin the fixed behavior:
 *
 *   1. a provider failure degrades to the hash fallback (fail-soft kept)
 *   2. the degradation is NOT a permanent latch — after the retry cooldown,
 *      the provider is re-attempted and recovery is automatic
 *   3. within the cooldown, the dead provider is not re-dialed per request
 *   4. getEmbeddingStatus() reports the degraded state for /metrics
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

process.env.DATABRICKS_API_KEY = process.env.DATABRICKS_API_KEY || 'test-key';
process.env.DATABRICKS_API_BASE = process.env.DATABRICKS_API_BASE || 'http://test.com';
process.env.LOG_FILE_ENABLED = 'false';
// Short cooldown so the re-attempt path is testable without sleeping 60s.
process.env.LYNKR_EMBEDDINGS_RETRY_COOLDOWN_MS = '150';

// A controllable fake Ollama /api/embeddings endpoint.
let failMode = false;
let providerHits = 0;
const fakeOllama = http.createServer((req, res) => {
  providerHits += 1;
  if (failMode) {
    res.statusCode = 500;
    res.end('{"error":"down"}');
    return;
  }
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ embedding: new Array(768).fill(0.5) }));
});

let embeddings;

test.before(async () => {
  await new Promise((resolve) => fakeOllama.listen(0, '127.0.0.1', resolve));
  const { port } = fakeOllama.address();
  process.env.OLLAMA_EMBEDDINGS_ENDPOINT = `http://127.0.0.1:${port}/api/embeddings`;
  // Fresh config + module so the endpoint override is picked up.
  delete require.cache[require.resolve('../src/config')];
  delete require.cache[require.resolve('../src/cache/embeddings')];
  embeddings = require('../src/cache/embeddings');
});

test.after(() => fakeOllama.close());

test.beforeEach(() => {
  embeddings.resetEmbeddingProvider();
  failMode = false;
  providerHits = 0;
});

test('healthy provider: real 768-dim embedding, status available', async () => {
  const vec = await embeddings.generateEmbedding('hello world');
  assert.equal(vec.length, 768);
  const status = embeddings.getEmbeddingStatus();
  assert.equal(status.providerAvailable, true);
  assert.equal(status.fallbackCount, 0);
});

test('provider failure degrades to hash fallback and reports degraded status', async () => {
  failMode = true;
  const vec = await embeddings.generateEmbedding('hello world');
  assert.equal(vec.length, 384, 'hash fallback is 384-dim');
  const status = embeddings.getEmbeddingStatus();
  assert.equal(status.providerAvailable, false);
  assert.ok(status.degradedSince > 0, 'degradedSince timestamp set');
  assert.ok(status.fallbackCount >= 1);
  assert.match(status.lastProviderError, /500/);
});

test('within the cooldown, the dead provider is not re-dialed per request', async () => {
  failMode = true;
  await embeddings.generateEmbedding('first — triggers degradation');
  const hitsAfterFirst = providerHits;
  await embeddings.generateEmbedding('second — must be served from fallback without dialing');
  await embeddings.generateEmbedding('third — same');
  assert.equal(providerHits, hitsAfterFirst, 'no additional provider dials inside the cooldown window');
});

test('degradation is not a permanent latch: provider recovery is automatic after cooldown', async () => {
  failMode = true;
  const degraded = await embeddings.generateEmbedding('while down');
  assert.equal(degraded.length, 384);

  failMode = false;
  await new Promise((r) => setTimeout(r, 200)); // > LYNKR_EMBEDDINGS_RETRY_COOLDOWN_MS

  const recovered = await embeddings.generateEmbedding('after recovery');
  assert.equal(recovered.length, 768, 'real embeddings resume after the provider comes back');
  const status = embeddings.getEmbeddingStatus();
  assert.equal(status.providerAvailable, true);
  assert.equal(status.degradedSince, null);
});
