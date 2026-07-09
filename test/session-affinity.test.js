const assert = require("assert");
const { describe, it, beforeEach, after } = require("node:test");
const fs = require("fs");
const os = require("os");
const path = require("path");

// Redirect the shared telemetry SQLite (which affinity-store piggybacks on)
// at a temp file so tests never write to .lynkr/telemetry.db.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lynkr-session-affinity-"));
const telemetry = require("../src/routing/telemetry");
telemetry._setDbPathForTests(path.join(tmpDir, "telemetry.db"));

const affinity = require("../src/routing/session-affinity");

describe("session-affinity: payloadHasToolHistory (mid-exchange only)", () => {
  it("is false for a plain text conversation", () => {
    const payload = { messages: [{ role: "user", content: "explain this repo" }] };
    assert.strictEqual(affinity.payloadHasToolHistory(payload), false);
  });

  it("is true when the LAST message is a dangling assistant tool_use", () => {
    const payload = {
      messages: [
        { role: "user", content: "read the file" },
        { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Read", input: {} }] },
      ],
    };
    assert.strictEqual(affinity.payloadHasToolHistory(payload), true);
  });

  it("is true when the LAST message submits tool_results", () => {
    const payload = {
      messages: [
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
      ],
    };
    assert.strictEqual(affinity.payloadHasToolHistory(payload), true);
  });

  it("is FALSE for a fresh typed message after completed tool exchanges", () => {
    // Regression (2026-07-07): completed tool history earlier in the
    // conversation must NOT weld the session to its pin — a fresh typed
    // user message is a safe switch point, and treating it as
    // mid-exchange silently disabled the guards + drift check for the
    // rest of any session that ever used a tool.
    const payload = {
      messages: [
        { role: "user", content: "read the repo" },
        { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Read", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "file contents" }] },
        { role: "assistant", content: "Here is the summary." },
        { role: "user", content: "now analyze every module for circular dependencies" },
      ],
    };
    assert.strictEqual(affinity.payloadHasToolHistory(payload), false);
  });

  it("handles missing/!array messages safely", () => {
    assert.strictEqual(affinity.payloadHasToolHistory({}), false);
    assert.strictEqual(affinity.payloadHasToolHistory(null), false);
    assert.strictEqual(affinity.payloadHasToolHistory({ messages: "x" }), false);
    assert.strictEqual(affinity.payloadHasToolHistory({ messages: [] }), false);
  });
});

describe("session-affinity: pin lifecycle", () => {
  beforeEach(() => affinity._clearAll());
  after(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it("returns null when nothing is pinned", () => {
    assert.strictEqual(affinity.getPinned("s1"), null);
  });

  it("round-trips a pinned decision", () => {
    affinity.setPinned("s1", { provider: "moonshot", model: "moonshot-v1-auto", tier: "COMPLEX" });
    const got = affinity.getPinned("s1");
    assert.strictEqual(got.provider, "moonshot");
    assert.strictEqual(got.model, "moonshot-v1-auto");
    assert.strictEqual(got.tier, "COMPLEX");
  });

  it("ignores empty session id or provider", () => {
    affinity.setPinned("", { provider: "ollama" });
    affinity.setPinned("s2", { provider: undefined });
    assert.strictEqual(affinity.getPinned("s2"), null);
  });

  it("keeps the latest provider for a session", () => {
    affinity.setPinned("s1", { provider: "ollama" });
    affinity.setPinned("s1", { provider: "azure-openai" });
    assert.strictEqual(affinity.getPinned("s1").provider, "azure-openai");
  });
});

describe("session-affinity: WS1 getPin/setPin", () => {
  beforeEach(() => affinity._clearAll());

  it("persists messageCount and promptTokensEst", () => {
    affinity.setPin("s1",
      { provider: "azure-openai", model: "gpt-4o-mini", tier: "SIMPLE" },
      { messageCount: 4, promptTokensEst: 1234 });
    const got = affinity.getPin("s1");
    assert.strictEqual(got.messageCount, 4);
    assert.strictEqual(got.promptTokensEst, 1234);
  });

  it("read-through recovers a pin from SQLite when memory is cleared", () => {
    affinity.setPin("s1",
      { provider: "moonshot", model: "moonshot-v1-auto", tier: "COMPLEX" },
      { messageCount: 2, promptTokensEst: 500 });
    // Simulate process restart: wipe memory only, keep the sqlite row.
    affinity._clear();
    const got = affinity.getPin("s1");
    assert.ok(got, "pin should survive an in-memory reset via the store");
    assert.strictEqual(got.provider, "moonshot");
    assert.strictEqual(got.tier, "COMPLEX");
    assert.strictEqual(got.messageCount, 2);
  });

  it("returns null once TTL elapses", async () => {
    process.env.LYNKR_STICKY_TTL_MS = "50";
    affinity.setPin("s2", { provider: "ollama", model: null, tier: "SIMPLE" }, {});
    // Wipe memory so getPin has to hit the store (which does its own TTL check).
    affinity._clear();
    await new Promise((r) => setTimeout(r, 80));
    assert.strictEqual(affinity.getPin("s2"), null);
    delete process.env.LYNKR_STICKY_TTL_MS;
  });
});

describe("session-affinity: shouldRepin (compaction detection)", () => {
  it("does not repin when message count grows", () => {
    const pin = { messageCount: 6 };
    const payload = { messages: [{}, {}, {}, {}, {}, {}, {}, {}] };
    assert.deepStrictEqual(affinity.shouldRepin(pin, payload), { repin: false, reason: null });
  });

  it("does not repin when messageCount shrinks by 1 (noise)", () => {
    const pin = { messageCount: 6 };
    const payload = { messages: [{}, {}, {}, {}, {}] };
    assert.deepStrictEqual(affinity.shouldRepin(pin, payload), { repin: false, reason: null });
  });

  it("repins when messageCount shrinks by 3+ (compaction)", () => {
    const pin = { messageCount: 10 };
    const payload = { messages: [{}, {}, {}, {}, {}, {}, {}] };
    assert.deepStrictEqual(affinity.shouldRepin(pin, payload), { repin: true, reason: "compaction" });
  });

  it("returns repin=true when no pin is provided", () => {
    assert.deepStrictEqual(affinity.shouldRepin(null, { messages: [] }), { repin: true, reason: "no_pin" });
  });
});
