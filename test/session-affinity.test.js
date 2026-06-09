const assert = require("assert");
const { describe, it, beforeEach } = require("node:test");

const affinity = require("../src/routing/session-affinity");

describe("session-affinity: payloadHasToolHistory", () => {
  it("is false for a plain text conversation", () => {
    const payload = { messages: [{ role: "user", content: "explain this repo" }] };
    assert.strictEqual(affinity.payloadHasToolHistory(payload), false);
  });

  it("is true when an assistant tool_use is present", () => {
    const payload = {
      messages: [
        { role: "user", content: "read the file" },
        { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Read", input: {} }] },
      ],
    };
    assert.strictEqual(affinity.payloadHasToolHistory(payload), true);
  });

  it("is true when a user tool_result is present", () => {
    const payload = {
      messages: [
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
      ],
    };
    assert.strictEqual(affinity.payloadHasToolHistory(payload), true);
  });

  it("handles missing/!array messages safely", () => {
    assert.strictEqual(affinity.payloadHasToolHistory({}), false);
    assert.strictEqual(affinity.payloadHasToolHistory(null), false);
    assert.strictEqual(affinity.payloadHasToolHistory({ messages: "x" }), false);
  });
});

describe("session-affinity: pin lifecycle", () => {
  beforeEach(() => affinity._clear());

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
