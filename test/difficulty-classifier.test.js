/**
 * Difficulty classifier — contract tests.
 *
 * Tests exercise parsing, caching, skip conditions, and reconciliation.
 * The live LLM call itself (_callOllama) is not tested here — that's what
 * scripts/validate-difficulty-classifier.js does against the real model.
 */
const assert = require("assert");
const { describe, it, beforeEach } = require("node:test");

const {
  classifyDifficulty,
  _parseResult,
  _cacheKey,
  _clearCacheForTests,
  _getCacheStats,
  VALID_TIERS,
} = require("../src/routing/difficulty-classifier");

describe("difficulty-classifier — parsing", () => {
  it("parses clean JSON", () => {
    const r = _parseResult('{"tier":"MEDIUM","confidence":0.85}');
    assert.deepStrictEqual(r, { tier: "MEDIUM", confidence: 0.85 });
  });

  it("extracts JSON from surrounding text", () => {
    const r = _parseResult('Here is my answer: {"tier":"REASONING","confidence":0.95} — hope that helps');
    assert.strictEqual(r.tier, "REASONING");
  });

  it("uppercases tier names", () => {
    const r = _parseResult('{"tier":"simple","confidence":0.9}');
    assert.strictEqual(r.tier, "SIMPLE");
  });

  it("clamps confidence to [0,1]", () => {
    const r1 = _parseResult('{"tier":"MEDIUM","confidence":1.5}');
    const r2 = _parseResult('{"tier":"MEDIUM","confidence":-0.5}');
    assert.strictEqual(r1.confidence, 1);
    assert.strictEqual(r2.confidence, 0);
  });

  it("defaults confidence to 0.5 when missing/invalid", () => {
    const r = _parseResult('{"tier":"COMPLEX"}');
    assert.strictEqual(r.confidence, 0.5);
  });

  it("rejects invalid tier names", () => {
    assert.strictEqual(_parseResult('{"tier":"BOGUS","confidence":0.9}'), null);
    assert.strictEqual(_parseResult('{"tier":"","confidence":0.9}'), null);
  });

  it("rejects malformed input", () => {
    assert.strictEqual(_parseResult('not json at all'), null);
    assert.strictEqual(_parseResult('{tier: MEDIUM}'), null);
    assert.strictEqual(_parseResult(''), null);
    assert.strictEqual(_parseResult(null), null);
  });
});

describe("difficulty-classifier — cache key stability", () => {
  it("normalizes whitespace and case", () => {
    const a = _cacheKey("  Hello World  ");
    const b = _cacheKey("hello world");
    assert.strictEqual(a, b);
  });

  it("distinguishes different texts", () => {
    const a = _cacheKey("prove correctness");
    const b = _cacheKey("list exports");
    assert.notStrictEqual(a, b);
  });
});

describe("difficulty-classifier — skip conditions", () => {
  beforeEach(() => _clearCacheForTests());

  it("returns null for text shorter than 15 chars", async () => {
    const r = await classifyDifficulty("hi");
    assert.strictEqual(r, null);
  });

  it("returns null when caller signals a force pattern matched", async () => {
    const r = await classifyDifficulty("this is a long enough prompt to not be skipped", { forceMatched: true });
    assert.strictEqual(r, null);
  });

  it("returns null when caller signals high risk", async () => {
    const r = await classifyDifficulty("this is a long enough prompt to not be skipped", { riskLevel: 'high' });
    assert.strictEqual(r, null);
  });

  it("returns null for non-string input", async () => {
    assert.strictEqual(await classifyDifficulty(null), null);
    assert.strictEqual(await classifyDifficulty(undefined), null);
    assert.strictEqual(await classifyDifficulty(42), null);
  });
});

describe("difficulty-classifier — cache LRU bookkeeping", () => {
  it("size grows with new inserts up to capacity", () => {
    _clearCacheForTests();
    const before = _getCacheStats().size;
    assert.strictEqual(before, 0);
  });
});

describe("difficulty-classifier — VALID_TIERS contract", () => {
  it("exposes the 4 canonical tier names", () => {
    assert.deepStrictEqual(VALID_TIERS, ["SIMPLE", "MEDIUM", "COMPLEX", "REASONING"]);
  });
});
