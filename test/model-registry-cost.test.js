const assert = require("assert");
const { describe, it } = require("node:test");

const { getModelRegistrySync } = require("../src/routing/model-registry");

const reg = getModelRegistrySync();

describe("model-registry cost resolution ladder", () => {
  it("resolves a known model exactly", () => {
    const c = reg.getCost("gpt-5.2-chat");
    assert.strictEqual(c.unknown, undefined);
    assert.ok(c.input > 0 && c.output > 0);
  });

  it("strips a provider prefix to resolve", () => {
    const c = reg.getCost("databricks-claude-sonnet-4-5");
    assert.ok(!c.unknown);
    assert.ok(c.input > 0);
  });

  it("matches a dated/suffixed name via longest-prefix", () => {
    const base = reg.getCost("gpt-5.2-chat");
    const suffixed = reg.getCost("gpt-5.2-chat-2026");
    assert.ok(!suffixed.unknown);
    assert.strictEqual(suffixed.input, base.input);
    assert.strictEqual(suffixed.matchedAs, "gpt-5.2-chat");
  });

  it("returns unknown (not a fabricated price) for a garbage name", () => {
    const c = reg.getCost("totally-made-up-model-xyz");
    assert.strictEqual(c.unknown, true);
    assert.strictEqual(c.resolution, undefined);
  });

  it("does not false-match a too-short name", () => {
    assert.strictEqual(reg.getCost("xx").unknown, true);
  });

  it("treats empty/missing model as unknown", () => {
    assert.strictEqual(reg.getCost("").unknown, true);
    assert.strictEqual(reg.getCost(null).unknown, true);
  });

  it("never does a bidirectional substring match (the old fuzzy hazard)", () => {
    // A name that contains a real key as a *substring* but not as a prefix must
    // NOT resolve to that key.
    const c = reg.getCost("my-custom-gpt-5.2-chat-wrapper");
    assert.strictEqual(c.unknown, true);
  });
});

describe("WS8.1 — stale-cache background refresh", () => {
  const { ModelRegistry } = require("../src/routing/model-registry");

  function stubbed(lastFetch) {
    const r = new ModelRegistry();
    r.loaded = true;
    r.lastFetch = lastFetch;
    r.fetchCalls = 0;
    r._fetchAll = async () => { r.fetchCalls++; r.lastFetch = Date.now(); };
    return r;
  }

  it("initialize() on an already-loaded stale instance still refreshes (the dead-code regression)", async () => {
    const r = stubbed(0); // stale since epoch
    await r.initialize();
    assert.strictEqual(r.fetchCalls, 1);
  });

  it("does not refresh when the cache is within TTL", () => {
    const r = stubbed(Date.now());
    r._refreshIfStale();
    assert.strictEqual(r.fetchCalls, 0);
  });

  it("coalesces concurrent refresh attempts onto one fetch", async () => {
    const r = stubbed(0);
    let release;
    r._fetchAll = () => { r.fetchCalls++; return new Promise(res => { release = res; }); };
    r._refreshIfStale();
    r._refreshIfStale();
    r._refreshIfStale();
    release();
    await Promise.resolve();
    assert.strictEqual(r.fetchCalls, 1);
  });

  it("backs off after a failed refresh instead of retrying every call", async () => {
    const r = stubbed(0);
    r._fetchAll = async () => { r.fetchCalls++; throw new Error("network down"); };
    r._refreshIfStale();
    await new Promise(res => setImmediate(res)); // let the rejection settle
    r._refreshIfStale(); // within backoff window — must not fetch again
    assert.strictEqual(r.fetchCalls, 1);
  });
});
