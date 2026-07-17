/**
 * `lynkr usage` / `lynkr stats` — aggregator and receipt-data tests.
 *
 * The receipt card is a marketing surface: a wrong number in a screenshot
 * is worse than no number. These tests pin the aggregation math (totals,
 * per-tier buckets, flagship counterfactual) and the savings summary the
 * card reads, against a seeded telemetry DB.
 */

const assert = require("assert");
const { describe, it, before, after } = require("node:test");
const fs = require("fs");
const os = require("os");
const path = require("path");

function _sqliteAvailable() {
  try { require("better-sqlite3"); return true; } catch { return false; }
}

const telemetry = require("../src/routing/telemetry");

describe("usage aggregator", { skip: !_sqliteAvailable() }, () => {
  let dir;
  let aggregator;

  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "lynkr-usage-test-"));
    telemetry._resetForTests();
    telemetry._setDbPathForTests(path.join(dir, "telemetry.db"));

    const now = Date.now();
    // Field names are snake_case (the DB column names — see telemetry.record).
    // 3 SIMPLE requests on a free local model, 1 COMPLEX on a paid one.
    for (let i = 0; i < 3; i++) {
      telemetry.record({
        request_id: `r-simple-${i}`,
        timestamp: now - i * 1000,
        tier: "SIMPLE",
        provider: "ollama",
        model: "llama3.2",
        input_tokens: 1000,
        output_tokens: 500,
        cost_usd: 0,
        status_code: 200,
      });
    }
    telemetry.record({
      request_id: "r-complex-0",
      timestamp: now - 5000,
      tier: "COMPLEX",
      provider: "azure-openai",
      model: "gpt-5.2-chat",
      input_tokens: 2000,
      output_tokens: 1000,
      cost_usd: 0.05,
      status_code: 200,
    });
    telemetry.recordSavings("json_compression", 12000);
    telemetry.recordSavings("cache_hit", 800);

    // record()/recordSavings() defer their inserts via setImmediate — flush
    // the queue before any query runs, or every assertion reads an empty DB.
    await new Promise((r) => setImmediate(() => setImmediate(r)));

    // Aggregator must load AFTER the test DB path is set.
    aggregator = require("../src/usage/aggregator");
  });

  after(() => {
    telemetry._resetForTests();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("aggregates totals and per-tier buckets from telemetry rows", () => {
    const usage = aggregator.getUsage({ window: "7d" });
    assert.equal(usage.totals.requests, 4);
    assert.equal(usage.totals.totalTokens, 3 * 1500 + 3000);
    assert.ok(usage.byTier.SIMPLE, "SIMPLE bucket exists");
    assert.equal(usage.byTier.SIMPLE.requests, 3);
    assert.equal(usage.byTier.COMPLEX.requests, 1);
  });

  it("flagship counterfactual is never cheaper than actual for free-tier traffic", () => {
    const usage = aggregator.getUsage({ window: "7d" });
    // 3 requests ran at $0 on ollama — flagship-only cost must exceed actual.
    assert.ok(usage.totals.flagshipCost > usage.totals.actualCost,
      `flagship ${usage.totals.flagshipCost} should exceed actual ${usage.totals.actualCost}`);
    assert.ok(usage.totals.saved >= 0);
  });

  it("provider filter narrows the report", () => {
    const usage = aggregator.getUsage({ window: "7d", provider: "ollama" });
    assert.equal(usage.totals.requests, 3);
    assert.equal(usage.byTier.COMPLEX, undefined);
  });

  it("savings summary feeds the receipt card categories", () => {
    const s = telemetry.getSavingsSummary(Date.now() - 60_000);
    assert.equal(s.total, 12800);
    assert.equal(s.byCategory.json_compression, 12000);
    assert.equal(s.byCategory.cache_hit, 800);
  });

  it("resolveSince handles presets, Nd strings, and 'all'", () => {
    const { resolveSince } = aggregator;
    assert.equal(resolveSince("all"), null);
    const sevenD = resolveSince("7d");
    assert.ok(Math.abs(sevenD - (Date.now() - 7 * 86400_000)) < 5000);
  });
});
