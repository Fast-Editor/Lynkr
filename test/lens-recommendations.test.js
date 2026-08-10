const assert = require("assert");
const { describe, it, beforeEach, after } = require("node:test");
const fs = require("fs");
const os = require("os");
const path = require("path");

// Isolate the shared telemetry SQLite before anything touches it.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lynkr-lens-"));
const telemetry = require("../src/routing/telemetry");
telemetry._setDbPathForTests(path.join(tmpDir, "telemetry.db"));

const { wilsonLowerBound } = require("../src/dashboard/recommendations/wilson");
const engine = require("../src/dashboard/recommendations");

after(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch { /* best-effort */ }
});

function insertRow(over = {}) {
  const db = telemetry.getDb();
  db.prepare(
    `INSERT INTO routing_telemetry (
       request_id, session_id, timestamp, provider, model, tier, request_type,
       tool_count, tool_calls_made, input_tokens, output_tokens, cost_usd,
       quality_score, error_type, request_text, cache_read_tokens,
       cache_creation_tokens, pinned
     ) VALUES (
       @request_id, @session_id, @timestamp, @provider, @model, @tier, @request_type,
       @tool_count, @tool_calls_made, @input_tokens, @output_tokens, @cost_usd,
       @quality_score, @error_type, @request_text, @cache_read_tokens,
       @cache_creation_tokens, @pinned
     )`
  ).run({
    request_id: over.request_id ?? `r-${Math.random()}`,
    session_id: over.session_id ?? null,
    timestamp: over.timestamp ?? Date.now(),
    provider: over.provider ?? "databricks",
    model: over.model ?? "databricks-claude-haiku-4-5",
    tier: over.tier ?? "MEDIUM",
    request_type: over.request_type ?? null,
    tool_count: over.tool_count ?? 0,
    tool_calls_made: over.tool_calls_made ?? 0,
    input_tokens: over.input_tokens ?? 1000,
    output_tokens: over.output_tokens ?? 200,
    cost_usd: over.cost_usd ?? 0.01,
    quality_score: over.quality_score ?? null,
    error_type: over.error_type ?? null,
    request_text: over.request_text ?? "normal user request",
    cache_read_tokens: over.cache_read_tokens ?? null,
    cache_creation_tokens: over.cache_creation_tokens ?? null,
    pinned: over.pinned ?? 0,
  });
}

function clearRows() {
  telemetry.getDb().prepare("DELETE FROM routing_telemetry").run();
  engine._clearCacheForTests();
}

describe("wilson lower bound", () => {
  it("is conservative on small samples, tighter on large ones", () => {
    const small = wilsonLowerBound(21, 30); // 70% raw
    const large = wilsonLowerBound(700, 1000); // 70% raw
    assert.ok(small < 0.55, `small-sample bound should be well below 0.7, got ${small}`);
    assert.ok(large > 0.67, `large-sample bound should approach 0.7, got ${large}`);
    assert.strictEqual(wilsonLowerBound(0, 0), 0);
    assert.ok(wilsonLowerBound(10, 10) < 1);
  });
});

describe("recommendations engine", () => {
  beforeEach(clearRows);

  it("deadweight flags all-tools-no-calls sessions and prices the rent", () => {
    for (let i = 0; i < 5; i++) {
      insertRow({ session_id: "dead-1", tool_count: 12, tool_calls_made: 0 });
    }
    // Control: session that DID call tools must not appear.
    for (let i = 0; i < 5; i++) {
      insertRow({ session_id: "alive-1", tool_count: 12, tool_calls_made: 3 });
    }
    const out = engine.run({ force: true });
    const dw = out.findings.find((f) => f.id === "deadweight");
    assert.strictEqual(dw.state, "actionable");
    assert.strictEqual(dw.evidence.rows.length, 1);
    assert.strictEqual(dw.evidence.rows[0][0], "dead-1");
    // 12 tools × 150 tok × 5 reqs = 9000 est. tokens
    assert.strictEqual(dw.evidence.rows[0][3], 9000);
    assert.ok(dw.pastOverspendUsd > 0);
  });

  it("side-requests flags harness traffic above SIMPLE only", () => {
    insertRow({ request_text: "Generate a title for this conversation: how do I fix X", tier: "COMPLEX", cost_usd: 0.05 });
    insertRow({ request_text: "Generate a title for this conversation: hello", tier: "SIMPLE", cost_usd: 0.0001 });
    const out = engine.run({ force: true });
    const sr = out.findings.find((f) => f.id === "side-requests");
    assert.strictEqual(sr.state, "actionable");
    assert.strictEqual(sr.evidence.rows.length, 1);
    assert.strictEqual(sr.evidence.rows[0][0], "COMPLEX");
    assert.ok(Math.abs(sr.pastOverspendUsd - 0.05) < 1e-9);
  });

  it("cache-weakspots distinguishes not_measured from clean from weak", () => {
    let out = engine.run({ force: true });
    assert.strictEqual(out.findings.find((f) => f.id === "cache-weakspots").state, "not_measured");

    // Healthy: high hit ratio.
    for (let i = 0; i < 6; i++) {
      insertRow({ cache_read_tokens: 9000, cache_creation_tokens: 500, input_tokens: 500 });
    }
    out = engine.run({ force: true });
    assert.strictEqual(out.findings.find((f) => f.id === "cache-weakspots").state, "clean");

    // Weak: model that never hits.
    for (let i = 0; i < 6; i++) {
      insertRow({ model: "databricks-claude-opus-4-6", cache_read_tokens: 0, cache_creation_tokens: 100, input_tokens: 10000 });
    }
    out = engine.run({ force: true });
    const cw = out.findings.find((f) => f.id === "cache-weakspots");
    assert.strictEqual(cw.state, "actionable");
    assert.strictEqual(cw.evidence.rows.length, 1);
    assert.ok(cw.pastOverspendUsd > 0);
  });

  it("downsize requires the Wilson bound to clear, not the raw average", () => {
    // Upper-tier spend on request_type 'general'.
    for (let i = 0; i < 10; i++) {
      insertRow({ tier: "COMPLEX", request_type: "general", cost_usd: 0.1 });
    }
    // Lower tier: 21/30 successes — raw 70% but Wilson-lower ~0.52 → unproven.
    for (let i = 0; i < 30; i++) {
      insertRow({ tier: "MEDIUM", request_type: "general", quality_score: i < 21 ? 90 : 40, cost_usd: 0.01 });
    }
    let out = engine.run({ force: true });
    let dz = out.findings.find((f) => f.id === "downsize");
    assert.strictEqual(dz.state, "clean", "21/30 must NOT prove the lower tier");

    // Now overwhelming evidence: 170 more successes.
    for (let i = 0; i < 170; i++) {
      insertRow({ tier: "MEDIUM", request_type: "general", quality_score: 90, cost_usd: 0.01 });
    }
    out = engine.run({ force: true });
    dz = out.findings.find((f) => f.id === "downsize");
    assert.strictEqual(dz.state, "actionable");
    assert.strictEqual(dz.evidence.rows[0][0], "general");
    assert.ok(dz.pastOverspendUsd > 0);
  });

  it("totals sum only actionable usd findings and reports spend share basis", () => {
    for (let i = 0; i < 5; i++) {
      insertRow({ session_id: "dead-2", tool_count: 10, tool_calls_made: 0, cost_usd: 0.02 });
    }
    const out = engine.run({ force: true });
    assert.ok(out.totalRecoverableUsd > 0);
    assert.ok(out.spendUsd >= 0.1 - 1e-9);
    assert.ok(out.computedAt > 0);
    // Ranked by dollars descending among usd findings.
    const usd = out.findings.filter((f) => typeof f.pastOverspendUsd === "number");
    for (let i = 1; i < usd.length; i++) {
      assert.ok(usd[i - 1].pastOverspendUsd >= usd[i].pastOverspendUsd);
    }
  });

  it("memoizes results for 45s and force bypasses", () => {
    const a = engine.run({ force: true });
    insertRow({ session_id: "dead-3", tool_count: 10, tool_calls_made: 0 });
    const b = engine.run();
    assert.strictEqual(a.computedAt, b.computedAt, "cached result served");
    const c = engine.run({ force: true });
    assert.notStrictEqual(a.computedAt <= c.computedAt && a === c, true);
  });
});

describe("telemetry lens queries", () => {
  beforeEach(clearRows);

  it("getMeasuredCacheSavings prices actual reads and sorts weakest first", () => {
    for (let i = 0; i < 3; i++) {
      insertRow({ model: "databricks-claude-haiku-4-5", cache_read_tokens: 100000, cache_creation_tokens: 0, input_tokens: 1000 });
    }
    const m = telemetry.getMeasuredCacheSavings();
    assert.strictEqual(m.rowsMeasured, 3);
    // haiku: input $1/M, cacheRead ~$0.1/M → 300k reads save ≈$0.27 (registry
    // data may differ from the fallback multiplier at the 4th decimal)
    assert.ok(Math.abs(m.measuredSavedUsd - 0.27) < 5e-3, `got ${m.measuredSavedUsd}`);
    assert.ok(m.perModel[0].hitRatio > 0.9);
  });

  it("getSessionDetail aggregates per-model mix and context series", () => {
    const t0 = Date.now() - 10000;
    for (let i = 0; i < 4; i++) {
      insertRow({ session_id: "sess-detail", timestamp: t0 + i * 1000, input_tokens: 1000 * (i + 1), cost_usd: 0.01 });
    }
    const d = telemetry.getSessionDetail("sess-detail");
    assert.strictEqual(d.requests, 4);
    assert.strictEqual(d.models.length, 1);
    assert.strictEqual(d.contextSeries.length, 4);
    assert.strictEqual(d.contextSeries[3].inputTokens, 4000);
    assert.strictEqual(telemetry.getSessionDetail("nope"), null);
  });

  it("getAnalytics pivots with whitelisted dims and suppresses thin deltas", () => {
    for (let i = 0; i < 12; i++) {
      insertRow({ provider: i % 2 ? "ollama" : "databricks", tier: i % 2 ? "SIMPLE" : "COMPLEX", cost_usd: 0.01 });
    }
    const a = telemetry.getAnalytics({ metric: "requests", by: "provider" });
    assert.strictEqual(a.metric, "requests");
    assert.strictEqual(a.rows.length, 2);
    assert.strictEqual(a.kpis.requests, 12);
    assert.strictEqual(a.kpiDeltas, null, "prior window is empty → deltas suppressed");

    // Injection-shaped params fall back to whitelisted defaults.
    const b = telemetry.getAnalytics({ metric: "spend; DROP TABLE", by: "1=1" });
    assert.strictEqual(b.metric, "spend");
    assert.strictEqual(b.by, "provider");

    const c = telemetry.getAnalytics({ metric: "spend", by: "tier", stack: "provider" });
    assert.ok(c.rows.every((r) => "stack" in r));
  });
});

describe("lens api handlers", () => {
  beforeEach(clearRows);

  function call(handler, { params = {}, query = {} } = {}) {
    let status = 200; let body = null;
    const res = {
      status(s) { status = s; return this; },
      json(b) { body = b; },
    };
    handler({ params, query }, res);
    return { status, body };
  }

  it("recommendations endpoint returns the engine artifact", () => {
    const api = require("../src/dashboard/api");
    const { status, body } = call(api.recommendations, { query: { force: "true" } });
    assert.strictEqual(status, 200);
    assert.ok(Array.isArray(body.findings));
    assert.strictEqual(body.findings.length, 4);
  });

  it("sessionDetail 404s unknown sessions", () => {
    const api = require("../src/dashboard/api");
    assert.strictEqual(call(api.sessionDetail, { params: { id: "missing" } }).status, 404);
    insertRow({ session_id: "s-api" });
    assert.strictEqual(call(api.sessionDetail, { params: { id: "s-api" } }).status, 200);
  });

  it("statusline returns last-request snapshot and cache share", () => {
    insertRow({ tier: "MEDIUM", provider: "ollama", model: "m3", cache_read_tokens: 900, cache_creation_tokens: 0, input_tokens: 100 });
    const api = require("../src/dashboard/api");
    const { status, body } = call(api.statusline);
    assert.strictEqual(status, 200);
    assert.strictEqual(body.last.provider, "ollama");
    assert.strictEqual(body.cacheReadPct, 90);
  });

  it("analytics endpoint clamps days and rejects nothing (whitelist fallback)", () => {
    insertRow({});
    const api = require("../src/dashboard/api");
    const { status, body } = call(api.analytics, { query: { metric: "tokens", by: "model", days: "9999" } });
    assert.strictEqual(status, 200);
    assert.strictEqual(body.metric, "tokens");
  });
});
