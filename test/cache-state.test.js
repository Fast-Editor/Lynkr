const assert = require("assert");
const { describe, it, beforeEach, after } = require("node:test");
const fs = require("fs");
const os = require("os");
const path = require("path");

// Redirect the shared telemetry SQLite (which affinity-store piggybacks on)
// at a temp file so tests never write to .lynkr/telemetry.db.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lynkr-cache-state-"));
const telemetry = require("../src/routing/telemetry");
telemetry._setDbPathForTests(path.join(tmpDir, "telemetry.db"));

const affinity = require("../src/routing/session-affinity");
const store = require("../src/routing/affinity-store");
const { resolveCacheEconomics, getProviderCacheDefaults } = require("../src/routing/cache-economics");

after(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch { /* best-effort */ }
});

describe("cache-economics: provider fallback table", () => {
  it("Anthropic-hosted providers are explicit with 1.25x writes and 5-min TTL", () => {
    for (const p of ["azure-anthropic", "bedrock", "databricks"]) {
      const d = getProviderCacheDefaults(p);
      assert.strictEqual(d.mechanism, "explicit", p);
      assert.strictEqual(d.writeMult, 1.25, p);
      assert.strictEqual(d.readMult, 0.1, p);
      assert.strictEqual(d.ttlMs, 5 * 60 * 1000, p);
    }
  });

  it("OpenAI-style providers cache automatically with free writes", () => {
    for (const p of ["openai", "azure-openai"]) {
      const d = getProviderCacheDefaults(p);
      assert.strictEqual(d.mechanism, "automatic", p);
      assert.strictEqual(d.writeMult, 0, p);
    }
  });

  it("local providers have zero-dollar cache economics", () => {
    for (const p of ["ollama", "llamacpp", "lmstudio"]) {
      const d = getProviderCacheDefaults(p);
      assert.strictEqual(d.mechanism, "local", p);
      const econ = resolveCacheEconomics(p, "some-local-model");
      assert.strictEqual(econ.cacheReadPerM, 0, p);
      assert.strictEqual(econ.cacheWritePerM, 0, p);
    }
  });

  it("unknown provider gets the generic automatic default", () => {
    const d = getProviderCacheDefaults("no-such-provider");
    assert.strictEqual(d.mechanism, "automatic");
    assert.strictEqual(d.writeMult, 0);
  });

  it("multipliers apply to the model's input price for unknown-cache models", () => {
    // A name no registry source knows resolves to DEFAULT_COST (input=1.0)
    // with unknown:true — multipliers then produce read=0.1, write=1.25.
    const econ = resolveCacheEconomics("azure-anthropic", "zz-nonexistent-model-for-tests");
    assert.strictEqual(econ.mechanism, "explicit");
    assert.ok(Math.abs(econ.cacheReadPerM - econ.inputPerM * 0.1) < 1e-9);
    assert.ok(Math.abs(econ.cacheWritePerM - econ.inputPerM * 1.25) < 1e-9);
    assert.strictEqual(econ.unknownPricing, true);
  });
});

describe("affinity-store: cache_state persistence", () => {
  beforeEach(() => {
    affinity._clearAll();
  });

  it("roundtrips cache state on an existing pin row", () => {
    affinity.setPin("s1", { provider: "databricks", model: "m1", tier: "MEDIUM" });
    store.saveCacheState("s1", {
      warmPrefixTokens: 1234,
      provider: "databricks",
      model: "m1",
      lastRequestAt: Date.now(),
      ttlMs: 300000,
    });
    const state = store.loadCacheState("s1");
    assert.strictEqual(state.warmPrefixTokens, 1234);
    assert.strictEqual(state.provider, "databricks");
    // Pin fields untouched
    const pin = affinity.getPin("s1");
    assert.strictEqual(pin.tier, "MEDIUM");
  });

  it("creates a minimal row when the session has no pin yet", () => {
    store.saveCacheState("s2", {
      warmPrefixTokens: 50,
      provider: "openai",
      model: "gpt-x",
      lastRequestAt: Date.now(),
      ttlMs: 600000,
    });
    assert.strictEqual(store.loadCacheState("s2").warmPrefixTokens, 50);
  });

  it("pin upsert does not clobber cache_state", () => {
    affinity.setPin("s3", { provider: "databricks", model: "m1" });
    store.saveCacheState("s3", {
      warmPrefixTokens: 999,
      provider: "databricks",
      model: "m1",
      lastRequestAt: Date.now(),
      ttlMs: 300000,
    });
    // Re-pin (e.g. compaction refresh) — cache state must survive.
    affinity.setPin("s3", { provider: "databricks", model: "m1", tier: "COMPLEX" });
    assert.strictEqual(store.loadCacheState("s3").warmPrefixTokens, 999);
  });

  it("returns null for missing or unknown sessions", () => {
    assert.strictEqual(store.loadCacheState("nope"), null);
    assert.strictEqual(store.loadCacheState(null), null);
  });
});

describe("session-affinity: recordCacheUsage / getCacheState", () => {
  beforeEach(() => {
    affinity._clearAll();
  });

  it("records warm prefix as read + creation tokens", () => {
    affinity.recordCacheUsage("c1", {
      provider: "azure-anthropic",
      model: "claude-x",
      cacheReadTokens: 90000,
      cacheCreationTokens: 10000,
    });
    const state = affinity.getCacheState("c1");
    assert.strictEqual(state.warmPrefixTokens, 100000);
    assert.strictEqual(state.provider, "azure-anthropic");
    assert.strictEqual(state.ttlMs, 5 * 60 * 1000);
    assert.strictEqual(state.cold, false);
  });

  it("stays absent when the provider reports no cache signal", () => {
    affinity.recordCacheUsage("c2", {
      provider: "ollama",
      model: "llama3",
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    });
    assert.strictEqual(affinity.getCacheState("c2"), null);
  });

  it("a zero-signal response does not wipe existing state", () => {
    affinity.recordCacheUsage("c3", {
      provider: "databricks", model: "m1", cacheReadTokens: 500, cacheCreationTokens: 0,
    });
    affinity.recordCacheUsage("c3", {
      provider: "databricks", model: "m1", cacheReadTokens: 0, cacheCreationTokens: 0,
    });
    assert.strictEqual(affinity.getCacheState("c3").warmPrefixTokens, 500);
  });

  it("overwrites unconditionally on a model switch (caches are model-scoped)", () => {
    affinity.recordCacheUsage("c4", {
      provider: "databricks", model: "opus", cacheReadTokens: 100000, cacheCreationTokens: 0,
    });
    affinity.recordCacheUsage("c4", {
      provider: "databricks", model: "haiku", cacheReadTokens: 0, cacheCreationTokens: 2000,
    });
    const state = affinity.getCacheState("c4");
    assert.strictEqual(state.model, "haiku");
    assert.strictEqual(state.warmPrefixTokens, 2000);
  });

  it("marks state cold once TTL has elapsed without a refresh", () => {
    store.saveCacheState("c5", {
      warmPrefixTokens: 1000,
      provider: "databricks",
      model: "m1",
      lastRequestAt: Date.now() - 10 * 60 * 1000, // 10 min ago
      ttlMs: 5 * 60 * 1000,
    });
    assert.strictEqual(affinity.getCacheState("c5").cold, true);
  });

  it("handles missing sessionId/provider gracefully", () => {
    affinity.recordCacheUsage(null, { provider: "databricks", cacheReadTokens: 5 });
    affinity.recordCacheUsage("c6", { cacheReadTokens: 5 });
    assert.strictEqual(affinity.getCacheState("c6"), null);
  });
});
