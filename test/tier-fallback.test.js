/**
 * Tests for tier-aware escalate-then-demote fallback (src/routing/tier-fallback.js).
 */

process.env.DATABRICKS_API_KEY = process.env.DATABRICKS_API_KEY || "test-key";
process.env.DATABRICKS_API_BASE = process.env.DATABRICKS_API_BASE || "http://test.com";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { getFallbackChain, TIER_ORDER } = require("../src/routing/tier-fallback");

// Fake selector mapping tiers → provider:model (distinct providers per tier).
const MAP = {
  SIMPLE: { provider: "ollama", model: "minimax" },
  MEDIUM: { provider: "llamacpp", model: "qwen" },
  COMPLEX: { provider: "moonshot", model: "kimi" },
  REASONING: { provider: "azure-openai", model: "gpt-5" },
};
const selector = { selectModel: (tier) => MAP[tier] };
const allAvailable = () => true;

function chainTiers(tier, opts = {}) {
  return getFallbackChain(tier, { selector, isProviderAvailable: allAvailable, ...opts }).map(
    (c) => c.tier
  );
}

describe("tier-fallback chain (escalate-then-demote)", () => {
  it("COMPLEX → up to REASONING, then down to MEDIUM, SIMPLE", () => {
    assert.deepEqual(chainTiers("COMPLEX"), ["REASONING", "MEDIUM", "SIMPLE"]);
  });

  it("REASONING (top) → only downward", () => {
    assert.deepEqual(chainTiers("REASONING"), ["COMPLEX", "MEDIUM", "SIMPLE"]);
  });

  it("MEDIUM → up (COMPLEX, REASONING) then down (SIMPLE)", () => {
    assert.deepEqual(chainTiers("MEDIUM"), ["COMPLEX", "REASONING", "SIMPLE"]);
  });

  it("SIMPLE (floor) → only upward", () => {
    assert.deepEqual(chainTiers("SIMPLE"), ["MEDIUM", "COMPLEX", "REASONING"]);
  });

  it("marks direction up/down correctly", () => {
    const chain = getFallbackChain("COMPLEX", { selector, isProviderAvailable: allAvailable });
    assert.equal(chain.find((c) => c.tier === "REASONING").direction, "up");
    assert.equal(chain.find((c) => c.tier === "SIMPLE").direction, "down");
  });

  it("skips providers whose circuit is unavailable", () => {
    const isAvailable = (p) => p !== "azure-openai"; // REASONING down
    const chain = getFallbackChain("COMPLEX", { selector, isProviderAvailable: isAvailable });
    assert.deepEqual(chain.map((c) => c.tier), ["MEDIUM", "SIMPLE"]);
  });

  it("dedups identical provider:model across tiers", () => {
    const dupMap = {
      SIMPLE: { provider: "ollama", model: "minimax" },
      MEDIUM: { provider: "ollama", model: "minimax" }, // same as SIMPLE
      COMPLEX: { provider: "moonshot", model: "kimi" },
      REASONING: { provider: "azure-openai", model: "gpt-5" },
    };
    const chain = getFallbackChain("COMPLEX", {
      selector: { selectModel: (t) => dupMap[t] },
      isProviderAvailable: allAvailable,
    });
    // MEDIUM and SIMPLE collapse to one ollama:minimax entry.
    const ollama = chain.filter((c) => c.provider === "ollama");
    assert.equal(ollama.length, 1);
  });

  it("never re-attempts the failed tier's own provider:model", () => {
    // If REASONING maps to the same provider:model as COMPLEX, it's excluded.
    const sameMap = { ...MAP, REASONING: { provider: "moonshot", model: "kimi" } };
    const chain = getFallbackChain("COMPLEX", {
      selector: { selectModel: (t) => sameMap[t] },
      isProviderAvailable: allAvailable,
    });
    assert.ok(!chain.some((c) => c.provider === "moonshot"));
  });

  it("skips tiers that aren't configured (selector throws)", () => {
    const partial = { selectModel: (t) => {
      if (t === "REASONING") throw new Error("TIER_REASONING not configured");
      return MAP[t];
    } };
    const chain = getFallbackChain("COMPLEX", { selector: partial, isProviderAvailable: allAvailable });
    assert.deepEqual(chain.map((c) => c.tier), ["MEDIUM", "SIMPLE"]);
  });

  it("returns empty for an unknown tier", () => {
    assert.deepEqual(getFallbackChain("BOGUS", { selector, isProviderAvailable: allAvailable }), []);
  });

  it("TIER_ORDER is SIMPLE→REASONING", () => {
    assert.deepEqual(TIER_ORDER, ["SIMPLE", "MEDIUM", "COMPLEX", "REASONING"]);
  });
});
