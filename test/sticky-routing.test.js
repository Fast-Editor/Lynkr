/**
 * WS1 — sticky-session routing integration tests.
 *
 * Exercises `checkSessionPin`, `writeSessionPin`, and the economic-downgrade
 * guard against a temp SQLite so the tests never touch .lynkr/telemetry.db.
 */

const assert = require("assert");
const { describe, it, beforeEach, after } = require("node:test");
const fs = require("fs");
const os = require("os");
const path = require("path");

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lynkr-sticky-"));
require("../src/routing/telemetry")._setDbPathForTests(path.join(tmpDir, "telemetry.db"));

const routing = require("../src/routing");
const affinity = require("../src/routing/session-affinity");

describe("checkSessionPin: bypass paths", () => {
  beforeEach(() => affinity._clearAll());
  after(() => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ } });

  it("returns reason=bypass when payload has no sessionId", () => {
    const result = routing.checkSessionPin({ messages: [{ role: "user", content: "hi" }] });
    assert.strictEqual(result.serve, false);
    assert.strictEqual(result.reason, "bypass");
  });

  it("returns reason=bypass when options.forceProvider is set", () => {
    affinity.setPin("s1", { provider: "moonshot", model: "m1", tier: "SIMPLE" }, {});
    const result = routing.checkSessionPin(
      { _sessionId: "s1", messages: [{ role: "user", content: "hi" }] },
      { forceProvider: "openai" }
    );
    assert.strictEqual(result.serve, false);
    assert.strictEqual(result.reason, "bypass");
  });

  it("returns reason=bypass when LYNKR_STICKY_SESSIONS=false", () => {
    process.env.LYNKR_STICKY_SESSIONS = "false";
    affinity.setPin("s1", { provider: "moonshot", model: "m1", tier: "SIMPLE" }, {});
    const result = routing.checkSessionPin({
      _sessionId: "s1",
      messages: [{ role: "user", content: "hi" }],
    });
    assert.strictEqual(result.serve, false);
    assert.strictEqual(result.reason, "bypass");
    delete process.env.LYNKR_STICKY_SESSIONS;
  });
});

describe("checkSessionPin: no pin", () => {
  beforeEach(() => affinity._clearAll());

  it("returns reason=no_pin when session is fresh", () => {
    const result = routing.checkSessionPin({
      _sessionId: "fresh-session",
      messages: [{ role: "user", content: "hello" }],
    });
    assert.strictEqual(result.serve, false);
    assert.strictEqual(result.reason, "no_pin");
    assert.strictEqual(result.sessionId, "fresh-session");
  });
});

describe("checkSessionPin: pin serve", () => {
  beforeEach(() => affinity._clearAll());

  it("serves the pin on a plain follow-up turn (guards passed, no compaction)", () => {
    affinity.setPin("s1",
      { provider: "openai", model: "gpt-4o-mini", tier: "SIMPLE" },
      { messageCount: 2, promptTokensEst: 500 });
    const result = routing.checkSessionPin({
      _sessionId: "s1",
      messages: [
        { role: "user", content: "first" },
        { role: "assistant", content: "reply" },
        { role: "user", content: "follow up" },
      ],
    });
    assert.strictEqual(result.serve, true);
    assert.strictEqual(result.reason, "guards_passed");
    assert.strictEqual(result.pin.provider, "openai");
  });

  it("serves the pin unconditionally when tool history is present", () => {
    affinity.setPin("s2",
      { provider: "moonshot", model: null, tier: "COMPLEX" },
      { messageCount: 2 });
    const result = routing.checkSessionPin({
      _sessionId: "s2",
      messages: [
        { role: "user", content: [{ type: "text", text: "read file.js" }] },
        { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Read", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
      ],
    });
    assert.strictEqual(result.serve, true);
    assert.strictEqual(result.reason, "tool_history");
  });

  it("survives a memory-only reset via the SQLite pin store", () => {
    affinity.setPin("s3",
      { provider: "openai", model: "gpt-4o-mini", tier: "SIMPLE" },
      { messageCount: 2, promptTokensEst: 500 });
    // Simulate a process restart: wipe memory, keep the store.
    affinity._clear();
    const result = routing.checkSessionPin({
      _sessionId: "s3",
      messages: [{ role: "user", content: "same session, new process" }],
    });
    assert.strictEqual(result.serve, true, "pin should be recovered from the store");
    assert.strictEqual(result.pin.provider, "openai");
  });
});

describe("checkSessionPin: compaction re-route", () => {
  beforeEach(() => affinity._clearAll());

  it("falls through to fresh routing when message count shrank", () => {
    affinity.setPin("s1",
      { provider: "openai", model: "gpt-4o-mini", tier: "SIMPLE" },
      { messageCount: 10, promptTokensEst: 500 });
    const result = routing.checkSessionPin({
      _sessionId: "s1",
      messages: Array.from({ length: 3 }, () => ({ role: "user", content: "x" })),
    });
    assert.strictEqual(result.serve, false);
    assert.strictEqual(result.reason, "compaction");
  });
});

describe("_economicDowngradeAllowed", () => {
  const { economicDowngradeAllowed } = routing._internals;
  const cheapModel = "gpt-4o-mini";
  const richModel = "gpt-4o";

  // sanity: make sure the two models really are distinct in cost.
  it("has a real cost gap between the fixtures", () => {
    const optimizer = routing.getCostOptimizer();
    const cheap = optimizer.estimateCost(cheapModel, 1000);
    const rich = optimizer.estimateCost(richModel, 1000);
    assert.ok(cheap?.totalEstimate > 0);
    assert.ok(rich?.totalEstimate > 0);
    assert.ok(cheap.totalEstimate < rich.totalEstimate * 0.75,
      "test fixtures require gpt-4o-mini to be ≥25% cheaper than gpt-4o");
  });

  it("allows the downgrade at small prompt sizes (5k tokens)", () => {
    assert.strictEqual(economicDowngradeAllowed(5_000, richModel, cheapModel), true);
  });

  it("suppresses the downgrade at large prompt sizes (50k tokens)", () => {
    assert.strictEqual(economicDowngradeAllowed(50_000, richModel, cheapModel), false);
  });

  it("respects LYNKR_SWITCH_MAX_PROMPT_TOKENS override", () => {
    process.env.LYNKR_SWITCH_MAX_PROMPT_TOKENS = "3000";
    try {
      assert.strictEqual(economicDowngradeAllowed(5_000, richModel, cheapModel), false);
    } finally {
      delete process.env.LYNKR_SWITCH_MAX_PROMPT_TOKENS;
    }
  });

  it("returns true (i.e. lets the switch through) when models are identical", () => {
    assert.strictEqual(economicDowngradeAllowed(5_000, richModel, richModel), true);
  });

  it("fails open when the fresh model isn't cost-catalogued", () => {
    // Unknown models return null cost estimates; guard should not block them.
    assert.strictEqual(economicDowngradeAllowed(5_000, richModel, "some-unknown-model"), true);
  });
});

describe("writeSessionPin", () => {
  beforeEach(() => affinity._clearAll());

  it("persists the fresh decision so the next turn can reuse it", () => {
    const payload = {
      _sessionId: "s1",
      messages: [{ role: "user", content: "hi" }],
    };
    routing.writeSessionPin("s1",
      { provider: "openai", model: "gpt-4o-mini", tier: "SIMPLE" },
      payload);
    const pin = affinity.getPin("s1");
    assert.ok(pin);
    assert.strictEqual(pin.provider, "openai");
    assert.strictEqual(pin.messageCount, 1);
  });

  it("no-ops when sessionId or provider is missing", () => {
    routing.writeSessionPin(null, { provider: "openai" }, { messages: [] });
    routing.writeSessionPin("s1", { provider: null }, { messages: [] });
    // Neither call should have written a pin.
    assert.strictEqual(affinity.getPin("s1"), null);
  });
});
