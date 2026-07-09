const assert = require("assert");
const { describe, it, beforeEach } = require("node:test");

const degradation = require("../src/routing/degradation");

describe("degradation registry", () => {
  beforeEach(() => degradation._clear());

  it("records and counts events per component", () => {
    degradation.record("risk", new Error("boom"));
    degradation.record("risk", new Error("boom 2"));
    const counts = degradation.getCounts();
    assert.strictEqual(counts.risk.count, 2);
    assert.strictEqual(counts.risk.lastError, "boom 2");
    assert.ok(counts.risk.lastAt > 0);
  });

  it("accepts string errors, Error objects, and undefined", () => {
    degradation.record("bandit", "string message");
    degradation.record("bandit", { message: "obj message" });
    degradation.record("bandit", undefined);
    const counts = degradation.getCounts();
    assert.strictEqual(counts.bandit.count, 3);
    assert.strictEqual(counts.bandit.lastError, "unknown");
  });

  it("keeps per-component counters independent", () => {
    degradation.record("knn", new Error("a"));
    degradation.record("agentic", new Error("b"));
    degradation.record("agentic", new Error("c"));
    const counts = degradation.getCounts();
    assert.strictEqual(counts.knn.count, 1);
    assert.strictEqual(counts.agentic.count, 2);
  });

  it("ignores empty component names", () => {
    degradation.record("", new Error("x"));
    degradation.record(null, new Error("y"));
    assert.deepStrictEqual(degradation.getCounts(), {});
  });

  it("accepts unknown component names but still counts them", () => {
    degradation.record("mystery-component", new Error("z"));
    const counts = degradation.getCounts();
    assert.strictEqual(counts["mystery-component"].count, 1);
  });
});
