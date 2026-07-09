const assert = require("assert");
const { describe, it, before, after } = require("node:test");
const fs = require("fs");
const os = require("os");
const path = require("path");

// Route telemetry at a temp SQLite file so the run never touches the real
// .lynkr/telemetry.db. Must be set before the telemetry module initialises
// its lazy DB handle (i.e., before the first record() call).
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lynkr-telemetry-cols-"));
const dbPath = path.join(tmpDir, "telemetry.db");

// eslint-disable-next-line import/first
const telemetry = require("../src/routing/telemetry");
telemetry._setDbPathForTests(dbPath);

describe("routing telemetry: WS0 columns", () => {
  after(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch { /* best-effort cleanup */ }
  });

  it("persists base_tier / escalation_source / propensity / candidates / pinned / switch_reason", async () => {
    telemetry.record({
      request_id: "req-1",
      session_id: "sess-1",
      timestamp: 1_700_000_000_000,
      provider: "azure-openai",
      model: "gpt-4o-mini",
      tier: "COMPLEX",
      routing_method: "tier_config+context_escalated",
      base_tier: "SIMPLE",
      escalation_source: "context",
      propensity: 0.42,
      candidates: [
        { provider: "azure-openai", model: "gpt-4o-mini" },
        { provider: "databricks", model: "claude-3-5-sonnet" },
      ],
      pinned: true,
      switch_reason: "guard_escalation",
    });

    // record() runs via setImmediate; wait a tick.
    await new Promise((r) => setImmediate(r));

    const rows = telemetry.query({ limit: 10 });
    assert.strictEqual(rows.length, 1, "expected exactly one telemetry row");
    const row = rows[0];
    assert.strictEqual(row.request_id, "req-1");
    assert.strictEqual(row.base_tier, "SIMPLE");
    assert.strictEqual(row.escalation_source, "context");
    assert.strictEqual(row.propensity, 0.42);
    assert.strictEqual(row.pinned, 1);
    assert.strictEqual(row.switch_reason, "guard_escalation");
    const candidates = JSON.parse(row.candidates);
    assert.strictEqual(candidates.length, 2);
    assert.strictEqual(candidates[0].provider, "azure-openai");
  });

  it("defaults new columns to null / 0 when not provided", async () => {
    telemetry.record({
      request_id: "req-2",
      provider: "ollama",
    });
    await new Promise((r) => setImmediate(r));

    const rows = telemetry.query({ limit: 10 }).filter((r) => r.request_id === "req-2");
    assert.strictEqual(rows.length, 1);
    const row = rows[0];
    assert.strictEqual(row.base_tier, null);
    assert.strictEqual(row.escalation_source, null);
    assert.strictEqual(row.propensity, null);
    assert.strictEqual(row.candidates, null);
    assert.strictEqual(row.pinned, 0);
    assert.strictEqual(row.switch_reason, null);
  });

  it("accepts candidates already serialised as JSON", async () => {
    telemetry.record({
      request_id: "req-3",
      provider: "openrouter",
      candidates: '[{"provider":"openrouter","model":"foo"}]',
    });
    await new Promise((r) => setImmediate(r));

    const row = telemetry.query({ limit: 10 }).find((r) => r.request_id === "req-3");
    assert.ok(row, "row for req-3 should exist");
    assert.deepStrictEqual(JSON.parse(row.candidates), [{ provider: "openrouter", model: "foo" }]);
  });
});
