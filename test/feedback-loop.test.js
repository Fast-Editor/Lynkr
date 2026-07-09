/**
 * WS5.3/5.4 — feedback loop.
 *
 * Invariants:
 *   - `recordOutcome()` returns synchronously; the actual work runs on
 *     `setImmediate`. Callers must never block on it.
 *   - Never throws. Every internal failure is captured into the
 *     degradation registry so the response path is untouched.
 *   - `bandit.update` is called IFF `routingResult._banditContext` exists
 *     AND provider/model/tier are present.
 *   - `kNN.add` is called IFF `routingResult._queryEmbedding` exists AND
 *     the quality score is conclusive (≥ 70 or ≤ 40). Ambiguous mid-band
 *     outcomes (41-69) are intentionally skipped.
 *   - Missing routingResult / outcome is a no-op, not a crash.
 *
 * Uses the exported `_recordOutcomeSync` so we can drive the sync path
 * directly and assert on mock stubs; the setImmediate wrapper is exercised
 * once separately.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Route reward state and bandit state to scratch files so tests don't
// pollute the repo's data/ directory. Disable telemetry entirely for these
// unit tests — they stub the singletons rather than hitting SQLite.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'lynkr-feedback-'));
require('../src/routing/telemetry')._disableForTests();

const feedback = require('../src/routing/feedback');
const { recordOutcome, _recordOutcomeSync, KNN_POSITIVE_QUALITY, KNN_NEGATIVE_QUALITY } = feedback;

// Grab the shared singletons the feedback module already loaded so we can
// swap their methods with spies. Doing it via require() re-uses the same
// module instances feedback.js is holding references to.
const bandit = require('../src/routing/bandit').getBandit();
const knn = require('../src/routing/knn-router').getKnnRouter();
const rewardPipeline = require('../src/routing/reward-pipeline').getRewardPipeline();
const degradation = require('../src/routing/degradation');

function _stub(obj, method) {
  const original = obj[method];
  const calls = [];
  obj[method] = (...args) => { calls.push(args); return original ? undefined : undefined; };
  obj[method]._original = original;
  return { calls, restore: () => { obj[method] = original; } };
}

test('_recordOutcomeSync: no-ops on missing routingResult', () => {
  assert.doesNotThrow(() => _recordOutcomeSync({}));
  assert.doesNotThrow(() => _recordOutcomeSync({ routingResult: null }));
  assert.doesNotThrow(() => _recordOutcomeSync({ outcome: {} }));
});

test('_recordOutcomeSync: computes reward from outcome', () => {
  const spy = _stub(rewardPipeline, 'reward');
  try {
    _recordOutcomeSync({
      routingResult: { provider: 'p', model: 'm', tier: 'SIMPLE' },
      outcome: { qualityScore: 85, costUsd: 0.02, latencyMs: 500 },
    });
    assert.equal(spy.calls.length, 1);
    assert.deepEqual(spy.calls[0][0], { quality: 85, cost: 0.02, latency: 500 });
  } finally {
    spy.restore();
  }
});

test('_recordOutcomeSync: calls bandit.update when _banditContext present', () => {
  const rewardSpy = _stub(rewardPipeline, 'reward');
  // Make the reward pipeline return a fixed value so we can assert on it.
  rewardPipeline.reward = () => 72;
  const banditSpy = _stub(bandit, 'update');
  try {
    const ctx = Array(12).fill(0.5);
    _recordOutcomeSync({
      routingResult: {
        provider: 'databricks',
        model: 'claude-3-5-sonnet',
        tier: 'COMPLEX',
        _banditContext: ctx,
      },
      outcome: { qualityScore: 85, costUsd: 0.02, latencyMs: 500 },
    });
    assert.equal(banditSpy.calls.length, 1);
    const [tier, provider, model, contextArg, rewardArg] = banditSpy.calls[0];
    assert.equal(tier, 'COMPLEX');
    assert.equal(provider, 'databricks');
    assert.equal(model, 'claude-3-5-sonnet');
    assert.deepEqual(contextArg, ctx);
    assert.equal(rewardArg, 72);
  } finally {
    banditSpy.restore();
    rewardSpy.restore();
  }
});

test('_recordOutcomeSync: skips bandit.update when _banditContext is missing', () => {
  const banditSpy = _stub(bandit, 'update');
  try {
    _recordOutcomeSync({
      routingResult: { provider: 'p', model: 'm', tier: 'SIMPLE' },
      outcome: { qualityScore: 85, costUsd: 0.02, latencyMs: 500 },
    });
    assert.equal(banditSpy.calls.length, 0);
  } finally {
    banditSpy.restore();
  }
});

test('_recordOutcomeSync: skips bandit.update when reward computation failed', () => {
  const rewardSpy = _stub(rewardPipeline, 'reward');
  rewardPipeline.reward = () => { throw new Error('reward exploded'); };
  const banditSpy = _stub(bandit, 'update');
  try {
    _recordOutcomeSync({
      routingResult: {
        provider: 'p', model: 'm', tier: 'SIMPLE',
        _banditContext: Array(12).fill(0.1),
      },
      outcome: { qualityScore: 85 },
    });
    assert.equal(banditSpy.calls.length, 0, 'no update without a reward');
  } finally {
    banditSpy.restore();
    rewardSpy.restore();
  }
});

test('_recordOutcomeSync: kNN.add fires for high-quality conclusive outcomes', () => {
  const knnSpy = _stub(knn, 'add');
  try {
    const emb = new Array(768).fill(0.01);
    _recordOutcomeSync({
      routingResult: {
        provider: 'p', model: 'm', tier: 'SIMPLE',
        _queryEmbedding: emb,
        _queryText: 'hello',
      },
      outcome: { qualityScore: 90, costUsd: 0.001, latencyMs: 100 },
    });
    assert.equal(knnSpy.calls.length, 1);
    const [embArg, meta] = knnSpy.calls[0];
    assert.equal(embArg, emb);
    assert.equal(meta.quality, 90);
    assert.equal(meta.provider, 'p');
    assert.equal(meta.query, 'hello');
  } finally {
    knnSpy.restore();
  }
});

test('_recordOutcomeSync: kNN.add fires for low-quality (negative-exemplar) outcomes', () => {
  const knnSpy = _stub(knn, 'add');
  try {
    _recordOutcomeSync({
      routingResult: {
        provider: 'p', model: 'm', tier: 'SIMPLE',
        _queryEmbedding: [1, 0, 0, 0],
      },
      outcome: { qualityScore: 20 },
    });
    assert.equal(knnSpy.calls.length, 1);
    assert.equal(knnSpy.calls[0][1].quality, 20);
  } finally {
    knnSpy.restore();
  }
});

test('_recordOutcomeSync: kNN.add skipped for mid-band quality (41-69)', () => {
  const knnSpy = _stub(knn, 'add');
  try {
    for (const q of [41, 55, 69]) {
      _recordOutcomeSync({
        routingResult: {
          provider: 'p', model: 'm', tier: 'SIMPLE',
          _queryEmbedding: [1, 0, 0, 0],
        },
        outcome: { qualityScore: q },
      });
    }
    assert.equal(knnSpy.calls.length, 0);
  } finally {
    knnSpy.restore();
  }
});

test('_recordOutcomeSync: kNN.add skipped when _queryEmbedding is missing', () => {
  const knnSpy = _stub(knn, 'add');
  try {
    _recordOutcomeSync({
      routingResult: { provider: 'p', model: 'm', tier: 'SIMPLE' },
      outcome: { qualityScore: 95 },
    });
    assert.equal(knnSpy.calls.length, 0);
  } finally {
    knnSpy.restore();
  }
});

test('_recordOutcomeSync: never throws when every subsystem is broken', () => {
  const rewardSpy = _stub(rewardPipeline, 'reward');
  const banditSpy = _stub(bandit, 'update');
  const knnSpy = _stub(knn, 'add');
  rewardPipeline.reward = () => { throw new Error('reward down'); };
  bandit.update = () => { throw new Error('bandit down'); };
  knn.add = () => { throw new Error('knn down'); };
  try {
    assert.doesNotThrow(() => _recordOutcomeSync({
      routingResult: {
        provider: 'p', model: 'm', tier: 'SIMPLE',
        _banditContext: Array(12).fill(0),
        _queryEmbedding: [1, 0, 0, 0],
      },
      outcome: { qualityScore: 90, costUsd: 0.01, latencyMs: 100 },
    }));
    // Every failure was captured; the counter should be up.
    const counts = degradation.getCounts();
    assert.ok(counts.feedback && counts.feedback.count >= 1);
  } finally {
    rewardSpy.restore();
    banditSpy.restore();
    knnSpy.restore();
  }
});

test('recordOutcome: runs asynchronously (returns before the work happens)', async () => {
  let banditCalls = 0;
  const banditSpy = _stub(bandit, 'update');
  bandit.update = () => { banditCalls++; };
  try {
    recordOutcome({
      routingResult: {
        provider: 'p', model: 'm', tier: 'SIMPLE',
        _banditContext: Array(12).fill(0),
      },
      outcome: { qualityScore: 80 },
    });
    // BEFORE the microtask tick — must not have fired yet.
    assert.equal(banditCalls, 0);
    // Yield to setImmediate.
    await new Promise((r) => setImmediate(r));
    assert.equal(banditCalls, 1);
  } finally {
    banditSpy.restore();
  }
});

test('recordOutcome: swallows outer errors (never throws to caller)', () => {
  // Passing garbage that would blow up any un-guarded implementation.
  assert.doesNotThrow(() => recordOutcome(null));
  assert.doesNotThrow(() => recordOutcome({}));
  assert.doesNotThrow(() => recordOutcome({ routingResult: 42, outcome: 'nope' }));
});

test('exported thresholds match the plan (70 / 40)', () => {
  assert.equal(KNN_POSITIVE_QUALITY, 70);
  assert.equal(KNN_NEGATIVE_QUALITY, 40);
});
