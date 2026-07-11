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
      messages: [
        { role: "user", content: "first ask" },
        { role: "assistant", content: "done" },
        { role: "user", content: "same session, new process" },
      ],
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
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello!" },
        { role: "user", content: "now review this function for bugs" },
      ],
    };
    routing.writeSessionPin("s1",
      { provider: "openai", model: "gpt-4o-mini", tier: "SIMPLE" },
      payload);
    const pin = affinity.getPin("s1");
    assert.ok(pin);
    assert.strictEqual(pin.provider, "openai");
    assert.strictEqual(pin.messageCount, 3);
  });

  it("opener-only sessions (≤2 messages) never pin — identical openers share fingerprints", () => {
    routing.writeSessionPin("s-opener",
      { provider: "moonshot", model: "kimi-k2.6", tier: "COMPLEX", score: 100 },
      { _sessionId: "s-opener", messages: [{ role: "user", content: "Hi" }] });
    assert.strictEqual(affinity.getPin("s-opener"), null);
  });

  it("no-ops when sessionId or provider is missing", () => {
    routing.writeSessionPin(null, { provider: "openai" }, { messages: [] });
    routing.writeSessionPin("s1", { provider: null }, { messages: [] });
    // Neither call should have written a pin.
    assert.strictEqual(affinity.getPin("s1"), null);
  });
});

describe("2026-07-09 live incident — trigger asks trapped by pins", () => {
  const CC_TOOLS = ["Read","Write","Edit","Bash","Glob","Grep","WebSearch","WebFetch","TodoWrite","Task","NotebookEdit","NotebookRead","KillShell","TaskOutput"]
    .map((n) => ({ name: n, description: n, input_schema: { type: "object", properties: {} } }));

  it("drift: autonomous typed ask escapes the pin via the agentic trigger", async () => {
    const r = await routing.checkPinScoreDrift(
      { tier: "MEDIUM" },
      {
        tools: CC_TOOLS,
        messages: [{ role: "user", content:
          "Work autonomously: run the test suite, fix each failure one by one, rerun after every fix, and keep iterating until green" }],
      },
    );
    assert.strictEqual(r.drift, true);
    assert.strictEqual(r.forced, "agentic_autonomous");
  });

  it("drift: plain substantive ask still uses score-vs-ceiling (no agentic false positive)", async () => {
    const r = await routing.checkPinScoreDrift(
      { tier: "MEDIUM" },
      { messages: [{ role: "user", content: "give me a plan to refactor this code" }] },
    );
    assert.strictEqual(r.forced, undefined);
  });

  it("pin: force-cloud text embedded in a tool exchange serves the frame but drops the pin", () => {
    affinity.setPin("s-embed", { provider: "ollama", model: "minimax-m2.5:cloud", tier: "MEDIUM", score: 44 }, {});
    const payload = {
      _sessionId: "s-embed",
      tools: CC_TOOLS,
      messages: [
        { role: "user", content: "earlier turn" },
        { role: "assistant", content: [{ type: "text", text: "reading" }, { type: "tool_use", id: "t1", name: "Read", input: {} }] },
        { role: "user", content: [
          { type: "tool_result", tool_use_id: "t1", content: "file contents here" },
          { type: "text", text: "Do an architecture review of the orchestrator" },
        ] },
      ],
    };
    const r = routing.checkSessionPin(payload);
    assert.strictEqual(r.serve, true, "mid-exchange frame must still serve (tool id linkage)");
    assert.strictEqual(r.reason, "tool_history_pin_dropped");
    assert.strictEqual(affinity.getPin("s-embed"), null, "pin must not survive the exchange");
  });

  it("pin: plain tool_result frames keep serving and keep the pin", () => {
    affinity.setPin("s-plain", { provider: "ollama", model: "minimax-m2.5:cloud", tier: "MEDIUM", score: 44 }, {});
    const payload = {
      _sessionId: "s-plain",
      tools: CC_TOOLS,
      messages: [
        { role: "user", content: "earlier turn" },
        { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Read", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "just output" }] },
      ],
    };
    const r = routing.checkSessionPin(payload);
    assert.strictEqual(r.serve, true);
    assert.strictEqual(r.reason, "tool_history");
    assert.ok(affinity.getPin("s-plain"), "pin stays for plain tool frames");
  });
});

describe("2026-07-09 22:15 — fingerprint collision must not masquerade as compaction", () => {
  it("a bare opener against a long-conversation pin is new_conversation, not compaction", () => {
    const pin = { provider: "azure-anthropic", tier: "REASONING", messageCount: 40 };
    const r = affinity.shouldRepin(pin, { messages: [{ role: "user", content: "Hi" }] });
    assert.strictEqual(r.repin, true);
    assert.strictEqual(r.reason, "new_conversation");
  });

  it("a genuinely compacted conversation still reports compaction", () => {
    const pin = { provider: "moonshot", tier: "COMPLEX", messageCount: 40 };
    const msgs = Array.from({ length: 12 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `m${i}` }));
    const r = affinity.shouldRepin(pin, { messages: msgs });
    assert.strictEqual(r.reason, "compaction");
  });

  it("short pin + short conversation stays pinned (no false new_conversation)", () => {
    const pin = { provider: "ollama", tier: "SIMPLE", messageCount: 3 };
    const r = affinity.shouldRepin(pin, { messages: [{ role: "user", content: "yo" }] });
    assert.strictEqual(r.repin, false);
  });
});

describe("2026-07-10 00:18 — opener conversations never consume pins", () => {
  it("a 1-2 message conversation full-routes even when a colliding pin exists", () => {
    affinity.setPin("s-hi-collide",
      { provider: "moonshot", model: "kimi-k2.6", tier: "COMPLEX", score: 100 },
      { messageCount: 4 });
    const r = routing.checkSessionPin({
      _sessionId: "s-hi-collide",
      tools: [{ name: "Read" }],
      messages: [{ role: "user", content: "Hi" }],
    });
    assert.strictEqual(r.serve, false);
    assert.strictEqual(r.reason, "opener_conversation");
  });

  it("3+ message conversations still serve their pin normally", () => {
    affinity.setPin("s-real",
      { provider: "moonshot", model: "kimi-k2.6", tier: "COMPLEX", score: 100 },
      { messageCount: 3 });
    const r = routing.checkSessionPin({
      _sessionId: "s-real",
      tools: [{ name: "Read" }],
      messages: [
        { role: "user", content: "Hi" },
        { role: "assistant", content: "hello" },
        { role: "user", content: "review the retry helper for races" },
      ],
    });
    assert.strictEqual(r.serve, true);
  });

  it("pin refreshes never shrink the recorded messageCount", () => {
    affinity.setPin("s-mono",
      { provider: "moonshot", model: "kimi-k2.6", tier: "COMPLEX", score: 100 },
      { messageCount: 49 });
    // A 5-message frame serves the pin (guards pass) and refreshes it.
    const r = routing.checkSessionPin({
      _sessionId: "s-mono",
      tools: [{ name: "Read" }],
      messages: [
        { role: "user", content: "Hi" },
        { role: "assistant", content: "hello" },
        { role: "user", content: "do the review" },
        { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Read", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "…" }] },
      ],
    });
    assert.strictEqual(r.serve, true);
    assert.strictEqual(affinity.getPin("s-mono").messageCount, 49, "refresh must not ratchet down");
  });
});
