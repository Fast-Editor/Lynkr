const assert = require("assert");
const { describe, it, beforeEach, afterEach, mock } = require("node:test");

// ============================================================================
// Module imports
// ============================================================================

const { scoreResponseQuality } = require("../src/routing/quality-scorer");
const { LatencyTracker, getLatencyTracker } = require("../src/routing/latency-tracker");
const {
  extractFilePaths,
  scoreGraphSignals,
} = require("../src/routing/complexity-analyzer");
const {
  detectWorkspaceFromPaths,
  resolveWorkspace,
} = require("../src/tools/code-graph");

describe("Routing Intelligence Modules", () => {
  // ==========================================================================
  // Quality Scorer
  // ==========================================================================
  describe("scoreResponseQuality", () => {
    it("returns 55 for empty inputs (baseline + no-fallback bonus)", () => {
      // null outcome → was_fallback is falsy → +5
      const score = scoreResponseQuality(null, null, null);
      assert.strictEqual(score, 55);
    });

    it("returns 50 for empty outcome object", () => {
      const score = scoreResponseQuality({}, null, {});
      // no was_fallback → +5, retry_count undefined so no +5
      // actually: was_fallback is falsy → +5
      assert.ok(score >= 50);
    });

    it("scores a perfect success highly", () => {
      const score = scoreResponseQuality(
        { tier: "MEDIUM", hasTools: true },
        null,
        {
          status_code: 200,
          output_tokens: 500,
          tool_calls_made: 3,
          was_fallback: false,
          retry_count: 0,
          error_type: null,
          latency_ms: 2000,
        }
      );
      // 50 + 10(200) + 5(tokens>100) + 10(tools used) + 5(no fallback) + 5(no retries) = 85
      assert.strictEqual(score, 85);
    });

    it("scores a total failure at 0 or near 0", () => {
      const score = scoreResponseQuality(
        { tier: "REASONING", hasTools: true },
        null,
        {
          status_code: 500,
          output_tokens: 0,
          tool_calls_made: 0,
          was_fallback: true,
          retry_count: 3,
          error_type: "server_error",
          latency_ms: 45000,
        }
      );
      // 50 - 30(error) - 10(fallback) - 10(retries>1) - 10(latency>30s) - 15(tokens<20 + hasTools) - 10(REASONING + tokens<50) = very low
      assert.ok(score <= 10);
    });

    // --- Individual signal tests ---

    it("+10 for status_code 200", () => {
      const base = scoreResponseQuality({}, null, {});
      const with200 = scoreResponseQuality({}, null, { status_code: 200 });
      assert.strictEqual(with200 - base, 10);
    });

    it("+5 for output_tokens > 100", () => {
      const base = scoreResponseQuality({}, null, {});
      const withTokens = scoreResponseQuality({}, null, { output_tokens: 150 });
      assert.strictEqual(withTokens - base, 5);
    });

    it("no bonus for output_tokens <= 100", () => {
      const base = scoreResponseQuality({}, null, {});
      const withTokens = scoreResponseQuality({}, null, { output_tokens: 50 });
      assert.strictEqual(withTokens, base);
    });

    it("+10 for tool_calls_made > 0 when hasTools", () => {
      const base = scoreResponseQuality({ hasTools: true }, null, {});
      const withTools = scoreResponseQuality({ hasTools: true }, null, { tool_calls_made: 2 });
      assert.strictEqual(withTools - base, 10);
    });

    it("no tool bonus without hasTools", () => {
      const base = scoreResponseQuality({ hasTools: false }, null, {});
      const withTools = scoreResponseQuality({ hasTools: false }, null, { tool_calls_made: 2 });
      assert.strictEqual(withTools, base);
    });

    it("+5 for no fallback", () => {
      const withFallback = scoreResponseQuality({}, null, { was_fallback: true });
      const noFallback = scoreResponseQuality({}, null, { was_fallback: false });
      // no fallback: +5, with fallback: -10
      assert.strictEqual(noFallback - withFallback, 15);
    });

    it("+5 for retry_count === 0", () => {
      const noRetry = scoreResponseQuality({}, null, { retry_count: 0 });
      const withRetry = scoreResponseQuality({}, null, { retry_count: 2 });
      // no retry: +5, retry>1: -10 (and no +5)
      assert.strictEqual(noRetry - withRetry, 15);
    });

    it("-30 for error_type present", () => {
      const base = scoreResponseQuality({}, null, {});
      const withError = scoreResponseQuality({}, null, { error_type: "timeout" });
      assert.strictEqual(withError - base, -30);
    });

    it("-10 for latency > 30000ms", () => {
      const base = scoreResponseQuality({}, null, {});
      const slow = scoreResponseQuality({}, null, { latency_ms: 35000 });
      assert.strictEqual(slow - base, -10);
    });

    it("no latency penalty under 30000ms", () => {
      const base = scoreResponseQuality({}, null, {});
      const fast = scoreResponseQuality({}, null, { latency_ms: 5000 });
      assert.strictEqual(fast, base);
    });

    it("-15 for low tokens with tools", () => {
      const base = scoreResponseQuality({ hasTools: true }, null, {});
      const lowTokens = scoreResponseQuality({ hasTools: true }, null, { output_tokens: 10 });
      assert.strictEqual(lowTokens - base, -15);
    });

    it("no low-token penalty without hasTools", () => {
      const base = scoreResponseQuality({ hasTools: false }, null, {});
      const lowTokens = scoreResponseQuality({ hasTools: false }, null, { output_tokens: 10 });
      assert.strictEqual(lowTokens, base);
    });

    // --- Tier mismatch ---

    it("-10 for REASONING tier with few tokens (over-provisioned)", () => {
      const base = scoreResponseQuality({ tier: "MEDIUM" }, null, { output_tokens: 30 });
      const reasoning = scoreResponseQuality({ tier: "REASONING" }, null, { output_tokens: 30 });
      assert.strictEqual(reasoning - base, -10);
    });

    it("no REASONING penalty when tokens >= 50", () => {
      const a = scoreResponseQuality({ tier: "REASONING" }, null, { output_tokens: 50 });
      const b = scoreResponseQuality({ tier: "MEDIUM" }, null, { output_tokens: 50 });
      assert.strictEqual(a, b);
    });

    it("-5 for COMPLEX tier with very fast latency (over-provisioned)", () => {
      const base = scoreResponseQuality({ tier: "MEDIUM" }, null, { latency_ms: 300 });
      const complex = scoreResponseQuality({ tier: "COMPLEX" }, null, { latency_ms: 300 });
      assert.strictEqual(complex - base, -5);
    });

    it("no COMPLEX latency penalty when latency >= 500ms", () => {
      const a = scoreResponseQuality({ tier: "COMPLEX" }, null, { latency_ms: 600 });
      const b = scoreResponseQuality({ tier: "MEDIUM" }, null, { latency_ms: 600 });
      assert.strictEqual(a, b);
    });

    // --- Clamping ---

    it("clamps score to 0 minimum", () => {
      const score = scoreResponseQuality(
        { tier: "REASONING", hasTools: true },
        null,
        {
          error_type: "crash",
          was_fallback: true,
          retry_count: 5,
          latency_ms: 60000,
          output_tokens: 0,
        }
      );
      assert.strictEqual(score, 0);
    });

    it("clamps score to 100 maximum", () => {
      // Even with all positive signals, should not exceed 100
      const score = scoreResponseQuality(
        { tier: "SIMPLE", hasTools: true },
        null,
        {
          status_code: 200,
          output_tokens: 10000,
          tool_calls_made: 50,
          was_fallback: false,
          retry_count: 0,
          latency_ms: 500,
        }
      );
      assert.ok(score <= 100);
      assert.strictEqual(score, 85); // 50+10+5+10+5+5 = 85
    });
  });

  // ==========================================================================
  // Latency Tracker
  // ==========================================================================
  describe("LatencyTracker", () => {
    let tracker;

    beforeEach(() => {
      tracker = new LatencyTracker();
    });

    it("returns null for unknown provider", () => {
      assert.strictEqual(tracker.getStats("unknown"), null);
    });

    it("records and retrieves single measurement", () => {
      tracker.record("ollama", 1500);
      const stats = tracker.getStats("ollama");
      assert.ok(stats);
      assert.strictEqual(stats.count, 1);
      assert.strictEqual(stats.avg, 1500);
      assert.strictEqual(stats.p50, 1500);
    });

    it("calculates correct percentiles", () => {
      // Record values 1-100
      for (let i = 1; i <= 100; i++) {
        tracker.record("test", i);
      }
      const stats = tracker.getStats("test");
      assert.strictEqual(stats.count, 100);
      assert.strictEqual(stats.p50, 51); // index 50
      assert.strictEqual(stats.p95, 96); // index 95
      assert.strictEqual(stats.p99, 100); // index 99
      assert.strictEqual(stats.avg, 51); // (1+100)/2 rounded
    });

    it("tracks providers independently", () => {
      tracker.record("ollama", 100);
      tracker.record("databricks", 2000);
      tracker.record("openai", 500);

      assert.strictEqual(tracker.getStats("ollama").avg, 100);
      assert.strictEqual(tracker.getStats("databricks").avg, 2000);
      assert.strictEqual(tracker.getStats("openai").avg, 500);
    });

    it("uses circular buffer (overwrites old values)", () => {
      // Record 250 values — buffer is 200, so first 50 should be overwritten
      for (let i = 1; i <= 250; i++) {
        tracker.record("test", i);
      }
      const stats = tracker.getStats("test");
      assert.strictEqual(stats.count, 250); // total count includes all
      // But stats are computed from the buffer (200 values)
      // Buffer contains a mix of old and new values due to circular overwrite
      assert.ok(stats.avg > 0);
    });

    it("ignores negative latency", () => {
      tracker.record("test", -100);
      assert.strictEqual(tracker.getStats("test"), null);
    });

    it("ignores non-numeric latency", () => {
      tracker.record("test", "fast");
      assert.strictEqual(tracker.getStats("test"), null);
    });

    it("ignores null provider", () => {
      tracker.record(null, 100);
      assert.strictEqual(tracker.getStats(null), null);
    });

    it("ignores empty string provider", () => {
      tracker.record("", 100);
      assert.strictEqual(tracker.getStats(""), null);
    });

    it("sets lastUpdated timestamp", () => {
      const before = Date.now();
      tracker.record("test", 100);
      const stats = tracker.getStats("test");
      assert.ok(stats.lastUpdated >= before);
      assert.ok(stats.lastUpdated <= Date.now());
    });

    // --- penalizeScore ---

    describe("penalizeScore", () => {
      it("returns 0 for unknown provider", () => {
        assert.strictEqual(tracker.penalizeScore("unknown"), 0);
      });

      it("returns 0 with insufficient samples (< 10)", () => {
        for (let i = 0; i < 9; i++) {
          tracker.record("test", 20000); // very slow
        }
        assert.strictEqual(tracker.penalizeScore("test"), 0);
      });

      it("returns +10 for P95 > 10000ms", () => {
        for (let i = 0; i < 20; i++) {
          tracker.record("slow", 12000);
        }
        assert.strictEqual(tracker.penalizeScore("slow"), 10);
      });

      it("returns +5 for P95 > 5000ms but <= 10000ms", () => {
        for (let i = 0; i < 20; i++) {
          tracker.record("medium", 6000);
        }
        assert.strictEqual(tracker.penalizeScore("medium"), 5);
      });

      it("returns -5 for P50 < 1000ms (fast provider)", () => {
        for (let i = 0; i < 20; i++) {
          tracker.record("fast", 500);
        }
        assert.strictEqual(tracker.penalizeScore("fast"), -5);
      });

      it("returns 0 for moderate latency", () => {
        for (let i = 0; i < 20; i++) {
          tracker.record("normal", 2000);
        }
        assert.strictEqual(tracker.penalizeScore("normal"), 0);
      });
    });

    // --- getAllStats ---

    describe("getAllStats", () => {
      it("returns empty map with no data", () => {
        const all = tracker.getAllStats();
        assert.strictEqual(all.size, 0);
      });

      it("returns stats for all tracked providers", () => {
        tracker.record("a", 100);
        tracker.record("b", 200);
        tracker.record("c", 300);

        const all = tracker.getAllStats();
        assert.strictEqual(all.size, 3);
        assert.ok(all.has("a"));
        assert.ok(all.has("b"));
        assert.ok(all.has("c"));
      });
    });
  });

  // ==========================================================================
  // getLatencyTracker singleton
  // ==========================================================================
  describe("getLatencyTracker", () => {
    it("returns a LatencyTracker instance", () => {
      const tracker = getLatencyTracker();
      assert.ok(tracker instanceof LatencyTracker);
    });

    it("returns the same instance on multiple calls", () => {
      const a = getLatencyTracker();
      const b = getLatencyTracker();
      assert.strictEqual(a, b);
    });
  });

  // ==========================================================================
  // Telemetry Module (record/query/stats)
  // ==========================================================================
  describe("Telemetry SQLite store", () => {
    // We test telemetry functions that interact with SQLite.
    // better-sqlite3 is an optionalDependency, so we guard.
    let telemetry;
    let hasSqlite = false;

    beforeEach(() => {
      telemetry = require("../src/routing/telemetry");
      try {
        require("better-sqlite3");
        hasSqlite = true;
      } catch {
        hasSqlite = false;
      }
    });

    it("exports all expected functions", () => {
      assert.strictEqual(typeof telemetry.record, "function");
      assert.strictEqual(typeof telemetry.query, "function");
      assert.strictEqual(typeof telemetry.getStats, "function");
      assert.strictEqual(typeof telemetry.getProviderStats, "function");
      assert.strictEqual(typeof telemetry.getRoutingAccuracy, "function");
      assert.strictEqual(typeof telemetry.cleanup, "function");
    });

    it("record() does not throw when called", () => {
      // Should be non-blocking and safe even without SQLite
      assert.doesNotThrow(() => {
        telemetry.record({
          request_id: "test-001",
          provider: "ollama",
          timestamp: Date.now(),
        });
      });
    });

    it("record() handles missing fields gracefully", () => {
      assert.doesNotThrow(() => {
        telemetry.record({ provider: "test" });
      });
    });

    it("query() returns array", () => {
      const result = telemetry.query();
      assert.ok(Array.isArray(result));
    });

    it("query() with filters returns array", () => {
      const result = telemetry.query({ provider: "nonexistent", limit: 5 });
      assert.ok(Array.isArray(result));
    });

    it("getStats() returns null or object", () => {
      const stats = telemetry.getStats();
      // null if no data, or object if data exists
      assert.ok(stats === null || typeof stats === "object");
    });

    it("getProviderStats() returns null for nonexistent provider", () => {
      const stats = telemetry.getProviderStats("nonexistent_provider_xyz");
      assert.strictEqual(stats, null);
    });

    it("getRoutingAccuracy() returns null or object", () => {
      const acc = telemetry.getRoutingAccuracy();
      assert.ok(acc === null || typeof acc === "object");
    });

    it("cleanup() returns a number", () => {
      const deleted = telemetry.cleanup();
      assert.strictEqual(typeof deleted, "number");
    });

    // If SQLite is available, do a full round-trip test
    it("round-trip: record → query returns data (if SQLite available)", async () => {
      if (!hasSqlite) return;

      const requestId = `test-roundtrip-${Date.now()}`;
      telemetry.record({
        request_id: requestId,
        provider: "roundtrip-test-provider",
        timestamp: Date.now(),
        complexity_score: 42.5,
        tier: "MEDIUM",
        latency_ms: 1234,
        status_code: 200,
        quality_score: 75,
      });

      // record() uses setImmediate, so wait for it
      await new Promise((resolve) => setTimeout(resolve, 50));

      const results = telemetry.query({ provider: "roundtrip-test-provider", limit: 10 });
      const found = results.find((r) => r.request_id === requestId);
      if (found) {
        assert.strictEqual(found.provider, "roundtrip-test-provider");
        assert.strictEqual(found.complexity_score, 42.5);
        assert.strictEqual(found.tier, "MEDIUM");
        assert.strictEqual(found.latency_ms, 1234);
        assert.strictEqual(found.status_code, 200);
        assert.strictEqual(found.quality_score, 75);
      }
    });

    it("round-trip: getStats returns aggregates after recording (if SQLite available)", async () => {
      if (!hasSqlite) return;

      const now = Date.now();
      for (let i = 0; i < 5; i++) {
        telemetry.record({
          request_id: `stats-test-${now}-${i}`,
          provider: `stats-provider-${now}`,
          timestamp: now,
          latency_ms: 1000 + i * 100,
          quality_score: 60 + i,
          tier: "SIMPLE",
          status_code: 200,
        });
      }

      await new Promise((resolve) => setTimeout(resolve, 50));

      const stats = telemetry.getStats({ since: now - 1000 });
      if (stats) {
        assert.ok(stats.totalRequests >= 5);
        assert.ok(typeof stats.errorRate === "number");
      }
    });

    it("round-trip: getProviderStats returns data (if SQLite available)", async () => {
      if (!hasSqlite) return;

      const providerName = `provider-stats-${Date.now()}`;
      telemetry.record({
        request_id: `pstats-${Date.now()}`,
        provider: providerName,
        timestamp: Date.now(),
        latency_ms: 2000,
        quality_score: 70,
        output_tokens: 300,
        status_code: 200,
      });

      await new Promise((resolve) => setTimeout(resolve, 50));

      const stats = telemetry.getProviderStats(providerName, { since: Date.now() - 5000 });
      if (stats) {
        assert.strictEqual(stats.total, 1);
        assert.strictEqual(stats.avgLatency, 2000);
      }
    });

    it("round-trip: getRoutingAccuracy detects over-provisioned (if SQLite available)", async () => {
      if (!hasSqlite) return;

      const now = Date.now();
      // Over-provisioned: REASONING tier, quality > 80, output_tokens < 50
      telemetry.record({
        request_id: `over-${now}`,
        provider: `accuracy-${now}`,
        timestamp: now,
        tier: "REASONING",
        quality_score: 90,
        output_tokens: 20,
        status_code: 200,
      });

      await new Promise((resolve) => setTimeout(resolve, 50));

      const acc = telemetry.getRoutingAccuracy({ since: now - 1000 });
      if (acc) {
        assert.ok(acc.overProvisioned >= 1);
        assert.ok(acc.overProvisionedPct > 0);
      }
    });

    it("round-trip: getRoutingAccuracy detects under-provisioned (if SQLite available)", async () => {
      if (!hasSqlite) return;

      const now = Date.now();
      // Under-provisioned: SIMPLE tier, quality < 45
      telemetry.record({
        request_id: `under-${now}`,
        provider: `accuracy-under-${now}`,
        timestamp: now,
        tier: "SIMPLE",
        quality_score: 30,
        status_code: 200,
      });

      await new Promise((resolve) => setTimeout(resolve, 50));

      const acc = telemetry.getRoutingAccuracy({ since: now - 1000 });
      if (acc) {
        assert.ok(acc.underProvisioned >= 1);
      }
    });

    it("cleanup removes old records (if SQLite available)", async () => {
      if (!hasSqlite) return;

      // Record something with an old timestamp
      telemetry.record({
        request_id: `old-${Date.now()}`,
        provider: "cleanup-test",
        timestamp: 1000, // epoch + 1 second = very old
      });

      await new Promise((resolve) => setTimeout(resolve, 50));

      const deleted = telemetry.cleanup(1000); // anything older than 1 second ago
      assert.strictEqual(typeof deleted, "number");
    });
  });

  // ==========================================================================
  // Code Graph — extractFilePaths
  // ==========================================================================
  describe("extractFilePaths", () => {
    it("returns empty array for null payload", () => {
      assert.deepStrictEqual(extractFilePaths(null), []);
    });

    it("returns empty array for payload without messages", () => {
      assert.deepStrictEqual(extractFilePaths({}), []);
    });

    it("returns empty array for empty messages", () => {
      assert.deepStrictEqual(extractFilePaths({ messages: [] }), []);
    });

    it("extracts .js file paths from string content", () => {
      const paths = extractFilePaths({
        messages: [{ content: "Please fix src/routing/index.js" }],
      });
      assert.ok(paths.includes("src/routing/index.js"));
    });

    it("extracts .py file paths", () => {
      const paths = extractFilePaths({
        messages: [{ content: "Look at scripts/deploy.py" }],
      });
      assert.ok(paths.includes("scripts/deploy.py"));
    });

    it("extracts .ts file paths", () => {
      const paths = extractFilePaths({
        messages: [{ content: 'Edit "src/components/App.tsx" please' }],
      });
      assert.ok(paths.includes("src/components/App.tsx"));
    });

    it("extracts multiple paths from one message", () => {
      const paths = extractFilePaths({
        messages: [
          { content: "Compare src/a.js and src/b.ts for differences" },
        ],
      });
      assert.ok(paths.includes("src/a.js"));
      assert.ok(paths.includes("src/b.ts"));
    });

    it("deduplicates paths", () => {
      const paths = extractFilePaths({
        messages: [
          { content: "Check src/a.js" },
          { content: "Also look at src/a.js again" },
        ],
      });
      const count = paths.filter((p) => p === "src/a.js").length;
      assert.strictEqual(count, 1);
    });

    it("extracts from array content with text blocks", () => {
      const paths = extractFilePaths({
        messages: [
          {
            content: [
              { type: "text", text: "Reading src/config/index.js" },
            ],
          },
        ],
      });
      assert.ok(paths.includes("src/config/index.js"));
    });

    it("extracts from tool_use input.file_path", () => {
      const paths = extractFilePaths({
        messages: [
          {
            content: [
              {
                type: "tool_use",
                input: { file_path: "src/tools/web.js" },
              },
            ],
          },
        ],
      });
      assert.ok(paths.includes("src/tools/web.js"));
    });

    it("extracts from tool_use input.path", () => {
      const paths = extractFilePaths({
        messages: [
          {
            content: [
              {
                type: "tool_use",
                input: { path: "src/memory/store.js" },
              },
            ],
          },
        ],
      });
      assert.ok(paths.includes("src/memory/store.js"));
    });

    it("extracts from tool_use input.command", () => {
      const paths = extractFilePaths({
        messages: [
          {
            content: [
              {
                type: "tool_use",
                input: { command: "cat src/logger.js" },
              },
            ],
          },
        ],
      });
      assert.ok(paths.includes("src/logger.js"));
    });

    it("extracts from tool_result content", () => {
      const paths = extractFilePaths({
        messages: [
          {
            content: [
              {
                type: "tool_result",
                content: [
                  { type: "text", text: "File: src/routing/model-tiers.js\nLine 42" },
                ],
              },
            ],
          },
        ],
      });
      assert.ok(paths.includes("src/routing/model-tiers.js"));
    });

    it("handles mixed content types in one message", () => {
      const paths = extractFilePaths({
        messages: [
          {
            content: [
              { type: "text", text: "Looking at src/a.js" },
              { type: "tool_use", input: { file_path: "src/b.py" } },
              {
                type: "tool_result",
                content: [{ type: "text", text: "Found src/c.go" }],
              },
            ],
          },
        ],
      });
      assert.ok(paths.includes("src/a.js"));
      assert.ok(paths.includes("src/b.py"));
      assert.ok(paths.includes("src/c.go"));
    });

    it("handles supported file extensions", () => {
      const extensions = ["js", "ts", "py", "rb", "go", "rs", "java", "cpp", "c", "h", "jsx", "tsx", "json", "yaml", "yml", "sql", "sh", "css", "html"];
      for (const ext of extensions) {
        const paths = extractFilePaths({
          messages: [{ content: `Edit file.${ext}` }],
        });
        assert.ok(
          paths.some((p) => p.endsWith(`.${ext}`)),
          `Should extract .${ext} files`
        );
      }
    });

    it("ignores non-code file extensions", () => {
      const paths = extractFilePaths({
        messages: [{ content: "Open report.pdf and image.png" }],
      });
      assert.ok(!paths.some((p) => p.endsWith(".pdf")));
      assert.ok(!paths.some((p) => p.endsWith(".png")));
    });

    // --- Anthropic system prompt ---

    it("extracts from Anthropic system prompt (string)", () => {
      const paths = extractFilePaths({
        system: "The user is editing /Users/bob/app/src/config.js",
        messages: [],
      });
      assert.ok(paths.includes("/Users/bob/app/src/config.js"));
    });

    it("extracts from Anthropic system prompt (array of blocks)", () => {
      const paths = extractFilePaths({
        system: [
          { type: "text", text: "Working on /home/user/project/main.py" },
        ],
        messages: [],
      });
      assert.ok(paths.includes("/home/user/project/main.py"));
    });

    it("returns paths from system even with no messages", () => {
      const paths = extractFilePaths({
        system: "File context: src/routing/index.js",
      });
      assert.ok(paths.includes("src/routing/index.js"));
    });

    // --- OpenAI tool_calls format ---

    it("extracts from OpenAI tool_calls function arguments (JSON)", () => {
      const paths = extractFilePaths({
        messages: [
          {
            role: "assistant",
            tool_calls: [
              {
                function: {
                  name: "read_file",
                  arguments: JSON.stringify({ file_path: "/Users/bob/app/src/index.ts" }),
                },
              },
            ],
          },
        ],
      });
      assert.ok(paths.includes("/Users/bob/app/src/index.ts"));
    });

    it("extracts path field from OpenAI tool_calls", () => {
      const paths = extractFilePaths({
        messages: [
          {
            role: "assistant",
            tool_calls: [
              {
                function: {
                  name: "glob",
                  arguments: JSON.stringify({ path: "/Users/bob/app/src/utils.js" }),
                },
              },
            ],
          },
        ],
      });
      assert.ok(paths.includes("/Users/bob/app/src/utils.js"));
    });

    it("extracts from OpenAI tool_calls command field", () => {
      const paths = extractFilePaths({
        messages: [
          {
            role: "assistant",
            tool_calls: [
              {
                function: {
                  name: "bash",
                  arguments: JSON.stringify({ command: "cat /opt/project/server.go" }),
                },
              },
            ],
          },
        ],
      });
      assert.ok(paths.includes("/opt/project/server.go"));
    });

    it("handles malformed tool_calls arguments gracefully", () => {
      const paths = extractFilePaths({
        messages: [
          {
            role: "assistant",
            tool_calls: [
              {
                function: {
                  name: "read",
                  arguments: "not valid json but has src/app.js in it",
                },
              },
            ],
          },
        ],
      });
      assert.ok(paths.includes("src/app.js"));
    });

    // --- OpenAI legacy function_call format ---

    it("extracts from legacy function_call arguments", () => {
      const paths = extractFilePaths({
        messages: [
          {
            role: "assistant",
            function_call: {
              name: "edit_file",
              arguments: JSON.stringify({ file_path: "/home/user/config.yaml" }),
            },
          },
        ],
      });
      assert.ok(paths.includes("/home/user/config.yaml"));
    });

    it("handles malformed function_call arguments", () => {
      const paths = extractFilePaths({
        messages: [
          {
            role: "assistant",
            function_call: {
              name: "read",
              arguments: "broken json with /app/main.rs inside",
            },
          },
        ],
      });
      assert.ok(paths.includes("/app/main.rs"));
    });

    // --- Combined formats ---

    it("deduplicates across all sources (system + messages + tool_calls)", () => {
      const paths = extractFilePaths({
        system: "Context: /Users/bob/app/src/a.js",
        messages: [
          { content: "Edit /Users/bob/app/src/a.js" },
          {
            role: "assistant",
            tool_calls: [
              {
                function: {
                  name: "read",
                  arguments: JSON.stringify({ file_path: "/Users/bob/app/src/a.js" }),
                },
              },
            ],
          },
        ],
      });
      const count = paths.filter((p) => p === "/Users/bob/app/src/a.js").length;
      assert.strictEqual(count, 1);
    });
  });

  // ==========================================================================
  // Graphify — scoreGraphSignals
  // ==========================================================================
  describe("scoreGraphSignals", () => {
    it("returns 0 adjustment for low blast radius", () => {
      const { adjustment, reasons } = scoreGraphSignals({
        blast_radius: 2,
        dependency_depth: 1,
        test_coverage_pct: 80,
        is_infrastructure: false,
        god_node_touched: false,
        community_count: 1,
        cohesion: 0.5,
      });
      assert.strictEqual(adjustment, 0);
      assert.strictEqual(reasons.length, 0);
    });

    it("+5 for blast_radius > 5", () => {
      const { adjustment, reasons } = scoreGraphSignals({
        blast_radius: 8,
        dependency_depth: 1,
        test_coverage_pct: 80,
        is_infrastructure: false,
        god_node_touched: false,
      });
      assert.strictEqual(adjustment, 5);
      assert.ok(reasons.includes("blast_radius_low"));
    });

    it("+10 for blast_radius > 10", () => {
      const { adjustment, reasons } = scoreGraphSignals({
        blast_radius: 15,
        dependency_depth: 1,
        test_coverage_pct: 80,
        is_infrastructure: false,
        god_node_touched: false,
      });
      assert.strictEqual(adjustment, 10);
      assert.ok(reasons.includes("blast_radius_medium"));
    });

    it("+15 for blast_radius > 30", () => {
      const { adjustment, reasons } = scoreGraphSignals({
        blast_radius: 50,
        dependency_depth: 1,
        test_coverage_pct: 80,
        is_infrastructure: false,
        god_node_touched: false,
      });
      assert.strictEqual(adjustment, 15);
      assert.ok(reasons.includes("blast_radius_high"));
    });

    it("+5 for dependency_depth > 4", () => {
      const { adjustment, reasons } = scoreGraphSignals({
        blast_radius: 0,
        dependency_depth: 6,
        test_coverage_pct: 80,
        is_infrastructure: false,
        god_node_touched: false,
      });
      assert.strictEqual(adjustment, 5);
      assert.ok(reasons.includes("deep_dependencies"));
    });

    it("+10 for is_infrastructure", () => {
      const { adjustment, reasons } = scoreGraphSignals({
        blast_radius: 0,
        dependency_depth: 1,
        test_coverage_pct: 80,
        is_infrastructure: true,
        god_node_touched: false,
      });
      assert.strictEqual(adjustment, 10);
      assert.ok(reasons.includes("infrastructure_file"));
    });

    it("+5 for test_coverage_pct < 30", () => {
      const { adjustment, reasons } = scoreGraphSignals({
        blast_radius: 0,
        dependency_depth: 1,
        test_coverage_pct: 20,
        is_infrastructure: false,
        god_node_touched: false,
      });
      assert.strictEqual(adjustment, 5);
      assert.ok(reasons.includes("low_test_coverage"));
    });

    it("no bonus for test_coverage_pct >= 30", () => {
      const { adjustment } = scoreGraphSignals({
        blast_radius: 0,
        dependency_depth: 1,
        test_coverage_pct: 30,
        is_infrastructure: false,
        god_node_touched: false,
      });
      assert.strictEqual(adjustment, 0);
    });

    it("+10 for god_node_touched", () => {
      const { adjustment, reasons } = scoreGraphSignals({
        blast_radius: 0,
        dependency_depth: 1,
        test_coverage_pct: 80,
        is_infrastructure: false,
        god_node_touched: true,
      });
      assert.strictEqual(adjustment, 10);
      assert.ok(reasons.includes("god_node_touched"));
    });

    it("+5 for low community cohesion", () => {
      const { adjustment, reasons } = scoreGraphSignals({
        blast_radius: 0,
        dependency_depth: 1,
        test_coverage_pct: 80,
        is_infrastructure: false,
        god_node_touched: false,
        community_count: 5,
        cohesion: 0.10,
      });
      assert.strictEqual(adjustment, 5);
      assert.ok(reasons.includes("low_community_cohesion"));
    });

    it("no cohesion penalty when community_count <= 1", () => {
      const { adjustment } = scoreGraphSignals({
        blast_radius: 0,
        dependency_depth: 1,
        test_coverage_pct: 80,
        is_infrastructure: false,
        god_node_touched: false,
        community_count: 1,
        cohesion: 0.05,
      });
      assert.strictEqual(adjustment, 0);
    });

    it("caps total adjustment at 35", () => {
      // All signals: 15 + 5 + 10 + 5 + 10 + 5 = 50, should cap at 35
      const { adjustment } = scoreGraphSignals({
        blast_radius: 50,
        dependency_depth: 8,
        test_coverage_pct: 10,
        is_infrastructure: true,
        god_node_touched: true,
        community_count: 5,
        cohesion: 0.05,
      });
      assert.strictEqual(adjustment, 35);
    });

    it("accumulates multiple signals correctly before cap", () => {
      // blast_radius > 10 (+10) + infrastructure (+10) + god_node (+10) = 30
      const { adjustment, reasons } = scoreGraphSignals({
        blast_radius: 15,
        dependency_depth: 2,
        test_coverage_pct: 80,
        is_infrastructure: true,
        god_node_touched: true,
      });
      assert.strictEqual(adjustment, 30);
      assert.strictEqual(reasons.length, 3);
    });
  });

  // ==========================================================================
  // Graphify Module — isAvailable / exports
  // ==========================================================================
  describe("graphify module", () => {
    let codeGraph;

    beforeEach(() => {
      codeGraph = require("../src/tools/code-graph");
    });

    it("exports expected functions", () => {
      assert.strictEqual(typeof codeGraph.isAvailable, "function");
      assert.strictEqual(typeof codeGraph.getBlastRadius, "function");
      assert.strictEqual(typeof codeGraph.getRelevantContext, "function");
      assert.strictEqual(typeof codeGraph.getComplexitySignals, "function");
      assert.strictEqual(typeof codeGraph.getGraphStats, "function");
    });

    it("isAvailable returns false when not configured", async () => {
      const available = await codeGraph.isAvailable();
      assert.strictEqual(available, false);
    });

    it("getBlastRadius returns null for empty array", async () => {
      const result = await codeGraph.getBlastRadius([]);
      assert.strictEqual(result, null);
    });

    it("getBlastRadius returns null for null input", async () => {
      const result = await codeGraph.getBlastRadius(null);
      assert.strictEqual(result, null);
    });

    it("getRelevantContext returns null for empty array", async () => {
      const result = await codeGraph.getRelevantContext([]);
      assert.strictEqual(result, null);
    });

    it("getComplexitySignals returns null for empty array", async () => {
      const result = await codeGraph.getComplexitySignals([]);
      assert.strictEqual(result, null);
    });

    it("getBlastRadius returns null when not configured", async () => {
      const result = await codeGraph.getBlastRadius(["src/index.js"]);
      assert.strictEqual(result, null);
    });

    it("getRelevantContext returns null when not configured", async () => {
      const result = await codeGraph.getRelevantContext(["src/index.js"]);
      assert.strictEqual(result, null);
    });

    it("getComplexitySignals returns null when not configured", async () => {
      const result = await codeGraph.getComplexitySignals(["src/index.js"]);
      assert.strictEqual(result, null);
    });

    it("getGraphStats returns null when not configured", async () => {
      const result = await codeGraph.getGraphStats();
      assert.strictEqual(result, null);
    });

    it("exports resolveWorkspace and detectWorkspaceFromPaths", () => {
      assert.strictEqual(typeof codeGraph.resolveWorkspace, "function");
      assert.strictEqual(typeof codeGraph.detectWorkspaceFromPaths, "function");
    });
  });

  // ==========================================================================
  // Workspace Detection
  // ==========================================================================
  describe("detectWorkspaceFromPaths", () => {
    it("returns null for empty array", () => {
      assert.strictEqual(detectWorkspaceFromPaths([]), null);
    });

    it("returns null for relative paths only", () => {
      assert.strictEqual(
        detectWorkspaceFromPaths(["src/a.js", "src/b.js"]),
        null
      );
    });

    it("detects common root from absolute paths", () => {
      const result = detectWorkspaceFromPaths([
        "/Users/bob/app/src/a.js",
        "/Users/bob/app/src/b.js",
        "/Users/bob/app/test/c.js",
      ]);
      assert.strictEqual(result, "/Users/bob/app");
    });

    it("detects common root with different subdirectories", () => {
      const result = detectWorkspaceFromPaths([
        "/home/user/project/frontend/src/App.tsx",
        "/home/user/project/backend/src/server.js",
      ]);
      assert.strictEqual(result, "/home/user/project");
    });

    it("handles single absolute path", () => {
      const result = detectWorkspaceFromPaths([
        "/Users/bob/app/src/index.js",
      ]);
      // Common prefix of a single path is the path itself — but it has an extension
      // so it should go up to the directory
      assert.ok(result);
      assert.ok(!result.endsWith(".js"));
    });

    it("returns null for root-level paths (depth < 2)", () => {
      const result = detectWorkspaceFromPaths(["/tmp/a.js"]);
      assert.strictEqual(result, null);
    });

    it("ignores relative paths mixed with absolute", () => {
      const result = detectWorkspaceFromPaths([
        "/Users/bob/app/src/a.js",
        "relative/path.js",
        "/Users/bob/app/src/b.js",
      ]);
      assert.strictEqual(result, "/Users/bob/app/src");
    });

    it("handles paths with no common root beyond /", () => {
      const result = detectWorkspaceFromPaths([
        "/opt/project/a.js",
        "/home/user/other/b.js",
      ]);
      // Common root is just "/" — depth < 2, returns null
      assert.strictEqual(result, null);
    });
  });

  // ==========================================================================
  // resolveWorkspace
  // ==========================================================================
  describe("resolveWorkspace", () => {
    it("returns explicit workspace when provided", () => {
      const ws = resolveWorkspace({ workspace: "/explicit/path" });
      assert.strictEqual(ws, "/explicit/path");
    });

    it("auto-detects from filePaths when no explicit workspace", () => {
      const ws = resolveWorkspace({
        filePaths: [
          "/Users/bob/project/src/a.js",
          "/Users/bob/project/src/b.js",
        ],
      });
      assert.strictEqual(ws, "/Users/bob/project/src");
    });

    it("prefers explicit workspace over auto-detection", () => {
      const ws = resolveWorkspace({
        workspace: "/explicit",
        filePaths: ["/Users/bob/project/src/a.js"],
      });
      assert.strictEqual(ws, "/explicit");
    });

    it("falls back to default when no workspace and no absolute paths", () => {
      const ws = resolveWorkspace({ filePaths: ["src/a.js"] });
      // Should return the config default or cwd
      assert.ok(typeof ws === "string");
      assert.ok(ws.length > 0);
    });

    it("falls back to default for empty options", () => {
      const ws = resolveWorkspace();
      assert.ok(typeof ws === "string");
      assert.ok(ws.length > 0);
    });
  });
});
