const assert = require("assert");
const { describe, it } = require("node:test");

// The unit runner injects DATABRICKS_API_KEY/BASE inline (npm run test:unit),
// and the registry's logger transitively requires src/config which throws
// without them. Same inline harness as the repo's other bare node --test
// suites (dispatch-registry, context-window-header), so this file can be run
// directly by the independent verifier with a plain argv array.
process.env.DATABRICKS_API_KEY = process.env.DATABRICKS_API_KEY || "test-key";
process.env.DATABRICKS_API_BASE = process.env.DATABRICKS_API_BASE || "http://test.com";
process.env.LOG_FILE_ENABLED = process.env.LOG_FILE_ENABLED || "false";

const { ModelRegistry } = require("../src/routing/model-registry");

// Deterministic small pricing fixture (tracked) — the production cache
// (data/model-prices-cache.json) is gitignored and absent in a fresh
// verification checkout, and getModelRegistrySync loads it synchronously.
// The fixture is written in the RAW per-token LiteLLM / models.dev wire
// format that _processLiteLLM/_processModelsDev actually consume, so the
// test exercises the same builders a cache load uses without depending on
// the ~4 MB production file. Values mirror the live LiteLLM entries for
// gpt-5.2 / gpt-5.2-chat (input 1.75 / output 14 / context 128000, i.e.
// per-token 0.00000175 / 0.000014).
const PRICING_FIXTURE = {
  litellm: {
    "gpt-5.2-chat": {
      input_cost_per_token: 0.00000175,
      output_cost_per_token: 0.000014,
      cache_read_input_token_cost: 0.000000175,
      max_input_tokens: 128000,
      max_output_tokens: 16384,
      supports_function_calling: true,
      supports_vision: true,
    },
    "gpt-5.2": {
      input_cost_per_token: 0.00000175,
      output_cost_per_token: 0.000014,
      cache_read_input_token_cost: 0.000000175,
      max_input_tokens: 128000,
      max_output_tokens: 4096,
      supports_function_calling: true,
      supports_vision: false,
    },
  },
  modelsDev: {
    gpt: {
      models: {
        "5.2": {
          cost: { input: 1.75, output: 14, cache_read: 0.175 },
          context: 128000,
          output: 4096,
          tool_call: true,
          reasoning: true,
          input: ["text"],
        },
      },
    },
  },
};

/** Build a fresh, fully-populated registry from the tracked fixture. */
function buildFixtureRegistry() {
  const r = new ModelRegistry();
  r.litellmPrices = r._processLiteLLM(PRICING_FIXTURE.litellm);
  r.modelsDevPrices = r._processModelsDev(PRICING_FIXTURE.modelsDev);
  r._buildIndex();
  r.loaded = true;
  return r;
}

// Module-level fixture registry for the cost-ladder suite (no data/ dir
// needed). The WS8.1 stale-cache suite below builds its own stubbed
// instances, so the fixture is only shared by the resolution-ladder tests.
const reg = buildFixtureRegistry();

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
