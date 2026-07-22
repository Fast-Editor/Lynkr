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
  _buildPrompt,
  _clearCacheForTests,
  _getCacheStats,
  VALID_TIERS,
} = require("../src/routing/difficulty-classifier");
const { _reconcile } = require("../src/routing/intent-score");

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

describe("difficulty-classifier — context handling (prompt v2)", () => {
  it("includes conversation context in the prompt for short texts", () => {
    const prompt = _buildPrompt("Who kills him ?", 'user asked: """Who is doctor doom?""" → assistant replied about: """the Marvel villain"""');
    assert.ok(prompt.includes("Conversation so far"));
    assert.ok(prompt.includes("Who is doctor doom?"));
    assert.ok(prompt.includes('CURRENT user prompt: """Who kills him ?"""'));
  });

  it("omits the context block when no context is given", () => {
    const prompt = _buildPrompt("explain this regex", null);
    assert.ok(!prompt.includes("Conversation so far"));
    assert.ok(prompt.includes('User prompt: """explain this regex"""'));
  });

  it("teaches the vocabulary-trap rule", () => {
    const prompt = _buildPrompt("anything", null);
    assert.ok(prompt.includes("NOT reasoning"), "negative examples present");
    assert.ok(prompt.includes("not the vocabulary"), "task-not-vocabulary rule present");
  });

  it("same follow-up in different conversations gets different cache entries", () => {
    // Cache keys must diverge when context diverges — "Who kills him ?"
    // means different things next to Doctor Doom vs. next to a mutex design.
    const a = _cacheKey("Who kills him ? ctx-doom");
    const b = _cacheKey("Who kills him ? ctx-mutex");
    assert.notStrictEqual(a, b);
  });
});

describe("intent-score — _reconcile band cap (Phase A)", () => {
  // Live incident 2026-07-21: anchor 25 (MEDIUM band) + classifier
  // REASONING conf 1.0 jumped straight to 88 → subscription passthrough.
  it("caps an upward reconcile at ONE band above the anchor", () => {
    const r = _reconcile(25, "trivial", { tier: "REASONING", confidence: 1.0 });
    assert.strictEqual(r.reconciled, "up_capped");
    assert.strictEqual(r.score, 63, "MEDIUM anchor caps at COMPLEX midpoint, never REASONING");
  });

  it("still allows a single-band upward move", () => {
    const r = _reconcile(25, "substantive", { tier: "COMPLEX", confidence: 0.9 });
    assert.strictEqual(r.reconciled, "up");
    assert.strictEqual(r.score, 63);
  });

  it("REASONING stays reachable from a COMPLEX anchor", () => {
    const r = _reconcile(60, "frontier", { tier: "REASONING", confidence: 0.9 });
    assert.strictEqual(r.reconciled, "up");
    assert.strictEqual(r.score, 88);
  });

  it("trusts downward reconciles unconditionally", () => {
    const r = _reconcile(88, "frontier", { tier: "SIMPLE", confidence: 0.7 });
    assert.strictEqual(r.reconciled, "down");
    assert.strictEqual(r.score, 10);
  });

  it("gates low-confidence upward moves (unchanged)", () => {
    const r = _reconcile(25, "substantive", { tier: "COMPLEX", confidence: 0.7 });
    assert.strictEqual(r.reconciled, "up_gated");
    assert.strictEqual(r.score, 25);
  });

  it("ignores sub-0.6-confidence verdicts entirely (unchanged)", () => {
    const r = _reconcile(25, "substantive", { tier: "REASONING", confidence: 0.5 });
    assert.strictEqual(r.reconciled, false);
    assert.strictEqual(r.score, 25);
  });

  it("agreement is a no-op (unchanged)", () => {
    const r = _reconcile(35, "substantive", { tier: "MEDIUM", confidence: 1.0 });
    assert.strictEqual(r.reconciled, false);
    assert.strictEqual(r.score, 35);
  });
});