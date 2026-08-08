const assert = require("assert");
const { describe, it, after } = require("node:test");
const fs = require("fs");
const os = require("os");
const path = require("path");

// Isolate the shared telemetry SQLite before anything touches it.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lynkr-switch-cost-"));
const telemetry = require("../src/routing/telemetry");
telemetry._setDbPathForTests(path.join(tmpDir, "telemetry.db"));

const { evaluateSwitch } = require("../src/routing/cache-switch-cost");

after(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch { /* best-effort */ }
});

// Deterministic economics resolver — Anthropic-style Aug 2026 prices
// (opus $5/$25, sonnet $3/$15, haiku $1/$5; explicit cache 0.1x read,
// 1.25x write, 5-min TTL).
const ECON = {
  opus: { inputPerM: 5, outputPerM: 25, cacheReadPerM: 0.5, cacheWritePerM: 6.25, ttlMs: 300000, mechanism: "explicit" },
  sonnet: { inputPerM: 3, outputPerM: 15, cacheReadPerM: 0.3, cacheWritePerM: 3.75, ttlMs: 300000, mechanism: "explicit" },
  haiku: { inputPerM: 1, outputPerM: 5, cacheReadPerM: 0.1, cacheWritePerM: 1.25, ttlMs: 300000, mechanism: "explicit" },
  local: { inputPerM: 0, outputPerM: 0, cacheReadPerM: 0, cacheWritePerM: 0, ttlMs: 300000, mechanism: "local" },
};
const deps = { resolveCacheEconomics: (_provider, model) => ECON[model] };

function warmState(tokens, model = "opus") {
  return {
    warmPrefixTokens: tokens,
    provider: "databricks",
    model,
    lastRequestAt: Date.now(),
    ttlMs: 300000,
    cold: false,
  };
}

describe("cache-switch-cost: gate short-circuits", () => {
  it("allows when there is no cache state to protect", () => {
    const r = evaluateSwitch({
      cacheState: null,
      current: { provider: "databricks", model: "opus" },
      target: { provider: "databricks", model: "haiku" },
      deps,
    });
    assert.strictEqual(r.switchAllowed, true);
    assert.strictEqual(r.reason, "no_cache_state");
  });

  it("allows when the prefix is already cold (Phase 2 TTL clock)", () => {
    const state = { ...warmState(200000), cold: true };
    const r = evaluateSwitch({
      cacheState: state,
      current: { provider: "databricks", model: "opus" },
      target: { provider: "databricks", model: "haiku" },
      deps,
    });
    assert.strictEqual(r.switchAllowed, true);
    assert.strictEqual(r.reason, "cache_cold");
  });

  it("treats state recorded for a different model as stale", () => {
    const r = evaluateSwitch({
      cacheState: warmState(200000, "sonnet"),
      current: { provider: "databricks", model: "opus" },
      target: { provider: "databricks", model: "haiku" },
      deps,
    });
    assert.strictEqual(r.switchAllowed, true);
    assert.strictEqual(r.reason, "stale_cache_state");
  });

  it("no-ops on same provider+model", () => {
    const r = evaluateSwitch({
      cacheState: warmState(200000),
      current: { provider: "databricks", model: "opus" },
      target: { provider: "databricks", model: "opus" },
      deps,
    });
    assert.strictEqual(r.reason, "same_model");
  });
});

describe("cache-switch-cost: break-even math (plan's worked example)", () => {
  // 100k warm prefix on Opus, ~2k new input + 800 output per turn.
  const cacheState = warmState(100000);
  const current = { provider: "databricks", model: "opus" };

  it("Opus→Haiku breaks even in ~2 turns and clears the default horizon", () => {
    const r = evaluateSwitch({
      cacheState,
      current,
      target: { provider: "databricks", model: "haiku" },
      newTokensPerTurn: 2000,
      outputTokensPerTurn: 800,
      deps,
    });
    // stay=(100k*0.5+2k*5+0.8k*25)/1M=$0.08; once=102k*1.25/1M=$0.1275;
    // switch=(100k*0.1+2k*1+0.8k*5)/1M=$0.016; be=0.1275/0.064≈2.0
    assert.ok(r.breakEvenTurns > 1.5 && r.breakEvenTurns < 2.5, `be=${r.breakEvenTurns}`);
    assert.strictEqual(r.switchAllowed, true);
    assert.strictEqual(r.reason, "break_even_cleared");
  });

  it("Opus→Sonnet needs ~12 turns and is blocked at the conservative default", () => {
    const r = evaluateSwitch({
      cacheState,
      current,
      target: { provider: "databricks", model: "sonnet" },
      newTokensPerTurn: 2000,
      outputTokensPerTurn: 800,
      deps,
    });
    // once=102k*3.75/1M=$0.3825; savings=$0.08-$0.048=$0.032; be≈11.95
    assert.ok(r.breakEvenTurns > 10 && r.breakEvenTurns < 14, `be=${r.breakEvenTurns}`);
    assert.strictEqual(r.switchAllowed, false);
    assert.strictEqual(r.reason, "break_even_blocked");
  });

  it("Opus→Sonnet clears once the session is expected to run long enough", () => {
    const r = evaluateSwitch({
      cacheState,
      current,
      target: { provider: "databricks", model: "sonnet" },
      newTokensPerTurn: 2000,
      outputTokensPerTurn: 800,
      expectedRemainingTurns: 30,
      deps,
    });
    assert.strictEqual(r.switchAllowed, true);
    assert.strictEqual(r.reason, "break_even_cleared");
  });

  it("switching to a pricier model is never profitable (escalations bypass the gate)", () => {
    const r = evaluateSwitch({
      cacheState: warmState(100000, "haiku"),
      current: { provider: "databricks", model: "haiku" },
      target: { provider: "databricks", model: "opus" },
      deps,
    });
    assert.strictEqual(r.switchAllowed, false);
    assert.strictEqual(r.reason, "never_profitable");
    assert.strictEqual(r.breakEvenTurns, Infinity);
  });

  it("exposes the dollar receipt fields for Phase 6", () => {
    const r = evaluateSwitch({
      cacheState,
      current,
      target: { provider: "databricks", model: "haiku" },
      newTokensPerTurn: 2000,
      outputTokensPerTurn: 800,
      deps,
    });
    assert.ok(Math.abs(r.stayPerTurnUsd - 0.08) < 1e-9);
    assert.ok(Math.abs(r.switchOnceUsd - 0.1275) < 1e-9);
    assert.ok(Math.abs(r.switchPerTurnUsd - 0.016) < 1e-9);
    assert.ok(Math.abs(r.projectedStaySavingsUsd - 0.064) < 1e-9);
  });
});

describe("cache-switch-cost: local models (latency, not dollars)", () => {
  it("holds a large warm local prefix", () => {
    const r = evaluateSwitch({
      cacheState: { ...warmState(50000, "local"), provider: "ollama" },
      current: { provider: "ollama", model: "local" },
      target: { provider: "lmstudio", model: "local" },
      deps: { resolveCacheEconomics: () => ECON.local },
    });
    assert.strictEqual(r.switchAllowed, false);
    assert.strictEqual(r.reason, "local_prefill_hold");
  });

  it("lets a small local prefix go — prefill is cheap", () => {
    const r = evaluateSwitch({
      cacheState: { ...warmState(4000, "local"), provider: "ollama" },
      current: { provider: "ollama", model: "local" },
      target: { provider: "lmstudio", model: "local" },
      deps: { resolveCacheEconomics: () => ECON.local },
    });
    assert.strictEqual(r.switchAllowed, true);
    assert.strictEqual(r.reason, "local_prefix_small");
  });
});

describe("telemetry: cache_decision receipt + getCacheEconomics (Phase 6)", () => {
  it("persists cache_decision via record() and aggregates dollars saved", async () => {
    telemetry.record({
      request_id: "cd-1",
      provider: "databricks",
      cache_decision: {
        decision: "hold",
        reason: "break_even_blocked",
        warmPrefixTokens: 100000,
        breakEvenTurns: 11.95,
        projectedSwitchCostUsd: 0.3825,
        projectedStaySavingsUsd: 0.032,
        expectedRemainingTurns: 10,
      },
    });
    telemetry.record({
      request_id: "cd-2",
      provider: "databricks",
      cache_decision: {
        decision: "switch",
        reason: "break_even_cleared",
        warmPrefixTokens: 100000,
        breakEvenTurns: 1.99,
        projectedSwitchCostUsd: 0.1275,
        projectedStaySavingsUsd: 0.064,
        expectedRemainingTurns: 10,
      },
    });
    // record() writes on setImmediate — let the queue drain.
    await new Promise((resolve) => setImmediate(() => setImmediate(resolve)));

    const econ = telemetry.getCacheEconomics();
    assert.strictEqual(econ.decisions, 2);
    assert.strictEqual(econ.holds, 1);
    assert.strictEqual(econ.switches, 1);
    // hold: 0.3825 - 0.032*10 = 0.0625; switch: 0.064*10 - 0.1275 = 0.5125
    assert.ok(Math.abs(econ.dollarsSavedByHolds - 0.0625) < 1e-9);
    assert.ok(Math.abs(econ.dollarsSavedBySwitches - 0.5125) < 1e-9);
    assert.ok(Math.abs(econ.totalDollarsSaved - 0.575) < 1e-9);
    assert.strictEqual(econ.byReason.break_even_blocked, 1);
    assert.strictEqual(econ.byReason.break_even_cleared, 1);
  });
});

describe("telemetry: getExpectedRemainingTurns", () => {
  it("returns null on sparse data, conditional median with enough sessions", () => {
    assert.strictEqual(telemetry.getExpectedRemainingTurns(0), null);

    const db = telemetry.getDb();
    const insert = db.prepare(
      `INSERT INTO routing_telemetry (request_id, session_id, timestamp, provider, message_count)
       VALUES (?, ?, ?, 'databricks', ?)`
    );
    // 25 sessions whose conversations reach 11..35 messages.
    for (let i = 0; i < 25; i++) {
      insert.run(`r${i}`, `sess-${i}`, Date.now(), 11 + i);
    }

    const remaining = telemetry.getExpectedRemainingTurns(10);
    // Lengths 11..35 → remaining-past-10 = 1..25, median = 13.
    assert.strictEqual(remaining, 13);
  });
});
