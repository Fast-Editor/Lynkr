/**
 * WS5.2 — kNN cold-start damping + online growth.
 *
 * The pre-WS5 router refused to advise until the index held ≥1000 entries.
 * We now advise from 100, but multiply confidence by `min(1, size/1000)` so
 * a small index advises weakly — the caller's HIGH/LOW confidence
 * thresholds naturally treat sparse advice as ambiguous rather than
 * trusting it.
 *
 * These tests use a scratch KnnRouter (not the singleton) so we can drive
 * `size` deterministically. Skipped when `hnswlib-node` is unavailable —
 * the router silently no-ops in that mode.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  KnnRouter,
  MIN_INDEX_SIZE,
  DAMP_FULL_SIZE,
  SAVE_EVERY_N_ADDS,
} = require('../src/routing/knn-router');

function _hnswAvailable() {
  try {
    require('hnswlib-node');
    return true;
  } catch {
    return false;
  }
}

test('MIN_INDEX_SIZE lowered from 1000 to 100', () => {
  // The default MUST be ≤ 100 for the WS5 cold-start rule to apply. Override
  // via LYNKR_KNN_MIN_INDEX_SIZE for tests that need something else.
  if (process.env.LYNKR_KNN_MIN_INDEX_SIZE) {
    // Env override in effect — just assert numeric and skip the ≤100 check.
    assert.ok(Number.isInteger(MIN_INDEX_SIZE));
    return;
  }
  assert.equal(MIN_INDEX_SIZE, 100);
});

test('DAMP_FULL_SIZE = 1000 defines where damping ends', () => {
  assert.equal(DAMP_FULL_SIZE, 1000);
});

test('SAVE_EVERY_N_ADDS is exported for callers that want to force-save', () => {
  assert.equal(SAVE_EVERY_N_ADDS, 50);
});

test('query returns null when size < MIN_INDEX_SIZE', { skip: !_hnswAvailable() }, async () => {
  const router = new KnnRouter();
  const hnsw = require('hnswlib-node');
  router.index = new hnsw.HierarchicalNSW('cosine', 4);
  router.index.initIndex(1000);
  router.dim = 4;
  router.ready = true;
  // Seed a handful of entries — below MIN_INDEX_SIZE by construction.
  for (let i = 0; i < 5; i++) {
    router.add([Math.random(), Math.random(), Math.random(), Math.random()], {
      provider: 'p', model: 'm', quality: 80, cost: 0.01, latency: 100,
    });
  }
  // Even bypassing the embedder (we call embed=() => vec directly), the
  // size gate at the top of query() must return null.
  router.embed = async () => [1, 0, 0, 0];
  const r = await router.query('hi');
  assert.equal(r, null);
});

// The damping tests exercise the aggregation math in query() without
// requiring a real hnsw graph to be constructed and searched. We stub
// `index.searchKnn` to return a fixed neighbour set so the test is purely
// about the confidence formula.
function _mockRouter({ size, dim = 4, neighborCount = 10 }) {
  const router = new KnnRouter();
  router.dim = dim;
  router.ready = true;
  router.size = size;
  // Populate meta parallel to a fake index — every neighbour lands on the
  // same (provider, model) so the aggregation returns one candidate.
  router.meta = Array.from({ length: size }, () => ({
    provider: 'databricks',
    model: 'claude-3-5-haiku',
    tier: 'SIMPLE',
    quality: 80,
    cost: 0.001,
    latency: 200,
  }));
  router.index = {
    // Return K neighbours all at distance 0 (identical vectors) ⇒ weight=1.
    searchKnn: () => ({
      neighbors: Array.from({ length: neighborCount }, (_, i) => i),
      distances: Array.from({ length: neighborCount }, () => 0),
    }),
  };
  router.embed = async () => new Array(dim).fill(1);
  return router;
}

test('confidence is damped for a small (post-min) index', async () => {
  // Pick a size just above the effective MIN_INDEX_SIZE so damping is
  // clearly < 1. Robust to env overrides that raise MIN_INDEX_SIZE.
  const size = Math.max(MIN_INDEX_SIZE + 50, 150);
  const router = _mockRouter({ size });
  const result = await router.query('some text');
  assert.ok(result, `query should return advice when size (${size}) ≥ MIN_INDEX_SIZE (${MIN_INDEX_SIZE})`);
  // Damping factor: size/DAMP_FULL_SIZE. Raw confidence pre-damping is
  // min(1, weight_sum/K) where weight_sum = K·1 = 10 ⇒ raw = 1.0.
  const expected = Math.min(1, size / DAMP_FULL_SIZE);
  assert.ok(
    Math.abs(result.confidence - expected) < 1e-9,
    `expected confidence ≈ ${expected} with size=${size}, got ${result.confidence}`
  );
  // And it's genuinely damped (below the undamped ceiling).
  assert.ok(result.confidence < 1.0);
});

test('confidence is damped mid-range (500 → factor 0.5)', async () => {
  const size = Math.max(500, MIN_INDEX_SIZE + 1);
  const router = _mockRouter({ size });
  const result = await router.query('anything');
  const expected = Math.min(1, size / DAMP_FULL_SIZE);
  assert.ok(Math.abs(result.confidence - expected) < 1e-9,
    `expected ${expected}, got ${result.confidence}`);
});

test('confidence is undamped at/above DAMP_FULL_SIZE', async () => {
  const router = _mockRouter({ size: DAMP_FULL_SIZE });
  const result = await router.query('anything');
  // dampFactor = min(1, 1000/1000) = 1 ⇒ confidence == raw.
  assert.ok(
    result.confidence > 0.9,
    `expected undamped confidence > 0.9, got ${result.confidence}`
  );
  // Even well beyond DAMP_FULL_SIZE the factor stays 1.
  const router2 = _mockRouter({ size: 5000 });
  const r2 = await router2.query('x');
  assert.ok(r2.confidence > 0.9);
});

test('embed() returns null when embedder unavailable (no-embedding envs)', async () => {
  const router = new KnnRouter();
  router.dim = 4;
  router.ready = true;
  // Call embed with generateEmbedding likely to fail (empty env, no
  // ollama). The router's internal try/catch should swallow and return
  // null instead of throwing.
  const embedding = await router.embed('some query text').catch(() => 'threw');
  assert.notEqual(embedding, 'threw', 'embed must never throw');
  // Value is either null (embedder unavailable) or an array (env has
  // ollama running); either is acceptable — the invariant is no-throw.
});

test('embed() short-circuits on empty / non-string input', async () => {
  const router = new KnnRouter();
  router.dim = 4;
  router.ready = true;
  assert.equal(await router.embed(''), null);
  assert.equal(await router.embed(null), null);
  assert.equal(await router.embed(undefined), null);
  assert.equal(await router.embed(42), null);
});

test('add() persists every SAVE_EVERY_N_ADDS entries', { skip: !_hnswAvailable() }, () => {
  const router = new KnnRouter();
  const hnsw = require('hnswlib-node');
  router.index = new hnsw.HierarchicalNSW('cosine', 4);
  router.index.initIndex(1000);
  router.dim = 4;
  router.ready = true;
  // Stub save() to COUNT ONLY — never call the real save. KnnRouter's
  // INDEX_DIR is a module constant pointing at the production data/knn/,
  // so calling through would clobber the live learned index with dim-4
  // "p:m" fixtures on every suite run (live incident 2026-07-07: the
  // production index was found holding exactly this test's 100 dummy
  // entries, silencing kNN routing entirely).
  let saves = 0;
  router.save = () => { saves++; };
  for (let i = 0; i < SAVE_EVERY_N_ADDS * 2 + 3; i++) {
    router.add([Math.random(), Math.random(), Math.random(), Math.random()], {
      provider: 'p', model: 'm', quality: 80, cost: 0.01, latency: 100,
    });
  }
  // Exactly 2 saves triggered by the modulo boundary (at N and 2N).
  assert.equal(saves, 2, `expected 2 auto-saves, got ${saves}`);
});
