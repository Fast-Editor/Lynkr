/**
 * Tests for the task-decomposition feature (src/agents/decomposition/*).
 *
 * Everything here is deterministic and offline — model calls are injected.
 */

// Must be set before requiring config-dependent modules.
process.env.TASK_DECOMPOSITION_ENABLED = "true";
process.env.AGENTS_ENABLED = "true";
process.env.DATABRICKS_API_KEY = process.env.DATABRICKS_API_KEY || "test-key";
process.env.DATABRICKS_API_BASE = process.env.DATABRICKS_API_BASE || "http://test.com";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const gate = require("../src/agents/decomposition/gate");
const planner = require("../src/agents/decomposition/planner");
const dispatcher = require("../src/agents/decomposition/dispatcher");
const synthesizer = require("../src/agents/decomposition/synthesizer");
const telemetry = require("../src/agents/decomposition/telemetry");
const config = require("../src/config");
const { runDecomposedTask } = require("../src/agents/decomposition");

// ── Phase 1: gate ───────────────────────────────────────────────────

describe("decomposition gate", () => {
  const bigAnalysis = (score, tokens) => ({
    score,
    breakdown: { tokens: { estimated: tokens } },
  });

  it("decomposes a complex, large, divisible task", () => {
    const task =
      "Add a login endpoint in auth.js, then write tests in auth.test.js, and update the README.md docs.";
    const res = gate.shouldDecompose(bigAnalysis(75, 5000), {}, { taskText: task });
    assert.equal(res.decompose, true);
    assert.equal(res.reason, "decompose_worthwhile");
  });

  it("skips low-complexity tasks", () => {
    const res = gate.shouldDecompose(bigAnalysis(20, 5000), {}, {
      taskText: "fix typo in readme and update docs",
    });
    assert.equal(res.decompose, false);
    assert.equal(res.reason, "below_complexity_threshold");
  });

  it("skips tasks too small to amortise overhead", () => {
    const res = gate.shouldDecompose(bigAnalysis(80, 500), {}, {
      taskText: "implement A and then implement B and update C.js",
    });
    assert.equal(res.decompose, false);
    assert.equal(res.reason, "too_small_to_amortise_overhead");
  });

  it("skips non-divisible tasks", () => {
    const res = gate.shouldDecompose(bigAnalysis(80, 8000), {}, {
      taskText: "explain how this system works",
    });
    assert.equal(res.decompose, false);
    assert.equal(res.reason, "not_divisible");
  });

  it("never decomposes high-risk tasks", () => {
    const task = "implement A and then implement B and update C.js";
    const res = gate.shouldDecompose(bigAnalysis(90, 9000), {}, {
      taskText: task,
      riskLevel: "high",
    });
    assert.equal(res.decompose, false);
    assert.equal(res.reason, "high_risk_skip");
  });

  it("estimateIndependentUnits counts enumerated and file signals", () => {
    assert.ok(gate.estimateIndependentUnits("1. do x\n2. do y\n3. do z") >= 3);
    assert.ok(gate.estimateIndependentUnits("update a.js and b.js and c.py") >= 3);
    assert.equal(gate.estimateIndependentUnits("a single vague sentence"), 1);
  });
});

// ── Phase 2: planner ────────────────────────────────────────────────

describe("decomposition planner", () => {
  const fakeInvoke = (jsonText) => async () => ({
    json: { content: [{ type: "text", text: jsonText }], usage: { input_tokens: 10, output_tokens: 20 } },
  });

  it("parses and validates a well-formed plan", async () => {
    const json = JSON.stringify({
      strategy: "split by file",
      subtasks: [
        { id: "s1", agentType: "Explore", prompt: "find the auth code", dependsOn: [] },
        { id: "s2", agentType: "Fix", prompt: "patch it", dependsOn: ["s1"] },
      ],
    });
    const plan = await planner.generatePlan({ task: "x", invoke: fakeInvoke(json) });
    assert.ok(plan);
    assert.equal(plan.subtasks.length, 2);
    assert.equal(plan.subtasks[1].dependsOn[0], "s1");
    assert.equal(plan.usage.outputTokens, 20);
  });

  it("extracts JSON from prose + fences", () => {
    const text = "Sure!\n```json\n{\"strategy\":\"s\",\"subtasks\":[{\"id\":\"s1\",\"prompt\":\"p\"}]}\n```\nDone.";
    const obj = planner.extractJsonObject(text);
    assert.equal(obj.subtasks[0].id, "s1");
  });

  it("returns null on dangling dependency", () => {
    const bad = { subtasks: [{ id: "s1", prompt: "p", dependsOn: ["nope"] }] };
    assert.equal(planner.validatePlan(bad, 6), null);
  });

  it("returns null on duplicate ids", () => {
    const bad = {
      subtasks: [
        { id: "s1", prompt: "a" },
        { id: "s1", prompt: "b" },
      ],
    };
    assert.equal(planner.validatePlan(bad, 6), null);
  });

  it("coerces unknown agent types to general-purpose", () => {
    const ok = { subtasks: [{ id: "s1", agentType: "Wizard", prompt: "p", dependsOn: [] }] };
    const plan = planner.validatePlan(ok, 6);
    assert.equal(plan.subtasks[0].agentType, "general-purpose");
  });

  it("detects cycles", () => {
    const cyclic = [
      { id: "a", prompt: "a", dependsOn: ["b"] },
      { id: "b", prompt: "b", dependsOn: ["a"] },
    ];
    assert.equal(planner.hasCycle(cyclic), true);
  });

  it("returns null when model output is not JSON", async () => {
    const plan = await planner.generatePlan({ task: "x", invoke: fakeInvoke("no json here") });
    assert.equal(plan, null);
  });
});

// ── Phase 3: dispatcher ─────────────────────────────────────────────

describe("decomposition dispatcher", () => {
  it("orders subtasks into dependency levels", () => {
    const subtasks = [
      { id: "s1", dependsOn: [] },
      { id: "s2", dependsOn: ["s1"] },
      { id: "s3", dependsOn: ["s1"] },
      { id: "s4", dependsOn: ["s2", "s3"] },
    ];
    const levels = dispatcher.topologicalLevels(subtasks);
    assert.deepEqual(levels[0], ["s1"]);
    assert.deepEqual(levels[1].sort(), ["s2", "s3"]);
    assert.deepEqual(levels[2], ["s4"]);
  });

  it("runs levels in order and forwards dependency results as context", async () => {
    const calls = [];
    const spawnParallel = async (agentTypes, prompts, opts) => {
      calls.push({ agentTypes, prompts, mainContext: opts.mainContext });
      return prompts.map((p) => ({
        success: true,
        result: `done:${p}`,
        stats: { inputTokens: 5, outputTokens: 3 },
      }));
    };

    const plan = {
      subtasks: [
        { id: "s1", agentType: "Explore", prompt: "explore", dependsOn: [] },
        { id: "s2", agentType: "Fix", prompt: "fix", dependsOn: ["s1"] },
      ],
    };

    const out = await dispatcher.dispatchPlan(plan, { spawnParallel });
    assert.equal(out.results.length, 2);
    assert.equal(out.results[0].success, true);
    assert.equal(out.stats.subagents, 2);

    // s2 ran after s1 and received s1's result as injected context.
    const s2Call = calls.find((c) => c.prompts[0] === "fix");
    assert.ok(s2Call.mainContext);
    assert.match(s2Call.mainContext.relevant_context, /done:explore/);
  });

  it("buildContextForSubtask returns null for independent subtasks", () => {
    const ctx = dispatcher.buildContextForSubtask({ dependsOn: [] }, new Map());
    assert.equal(ctx, null);
  });
});

// ── Phase 4: synthesizer ────────────────────────────────────────────

describe("decomposition synthesizer", () => {
  it("synthesizes via the model", async () => {
    const invoke = async () => ({
      json: { content: [{ type: "text", text: "final answer" }], usage: {} },
    });
    const out = await synthesizer.synthesize({
      task: "t",
      subtaskResults: [{ id: "s1", agentType: "Fix", success: true, result: "r1" }],
      invoke,
    });
    assert.equal(out.text, "final answer");
    assert.equal(out.fallback, false);
  });

  it("falls back to concatenation when synthesis throws", async () => {
    const invoke = async () => {
      throw new Error("boom");
    };
    const out = await synthesizer.synthesize({
      task: "t",
      subtaskResults: [{ id: "s1", agentType: "Fix", success: true, result: "r1" }],
      invoke,
    });
    assert.equal(out.fallback, true);
    assert.match(out.text, /r1/);
  });

  it("reports failure when all subtasks failed", async () => {
    const out = await synthesizer.synthesize({
      task: "t",
      subtaskResults: [{ id: "s1", agentType: "Fix", success: false, error: "x" }],
    });
    assert.equal(out.fallback, true);
  });
});

// ── Phase 6: telemetry ──────────────────────────────────────────────

describe("decomposition telemetry", () => {
  it("computes net savings (positive = cheaper)", () => {
    const s = telemetry.estimateSavings({
      monolithicTokens: 10000,
      planUsage: { inputTokens: 100, outputTokens: 200 },
      dispatchStats: { inputTokens: 1000, outputTokens: 500 },
      synthUsage: { inputTokens: 300, outputTokens: 400 },
    });
    assert.equal(s.decomposedTokens, 2500);
    assert.equal(s.savedTokens, 7500);
  });
});

// ── Orchestration ───────────────────────────────────────────────────

describe("runDecomposedTask orchestration", () => {
  const inject = {
    analyze: async () => ({ score: 80, breakdown: { tokens: { estimated: 8000 } } }),
    generatePlan: async () => ({
      strategy: "split",
      subtasks: [
        { id: "s1", agentType: "Explore", prompt: "p1", dependsOn: [] },
        { id: "s2", agentType: "Fix", prompt: "p2", dependsOn: ["s1"] },
      ],
      usage: { inputTokens: 50, outputTokens: 60 },
    }),
    dispatchPlan: async () => ({
      results: [
        { id: "s1", agentType: "Explore", success: true, result: "found it" },
        { id: "s2", agentType: "Fix", success: true, result: "fixed it" },
      ],
      levels: [["s1"], ["s2"]],
      stats: { subagents: 2, inputTokens: 200, outputTokens: 100 },
    }),
    synthesize: async () => ({ text: "all done, fixed it correctly", fallback: false, usage: { inputTokens: 80, outputTokens: 40 } }),
  };

  it("decomposes a qualifying task end-to-end", async () => {
    const task = "implement A in a.js and then test it in a.test.js and document it in README.md";
    const res = await runDecomposedTask(task, { _inject: inject });
    assert.equal(res.decomposed, true);
    assert.match(res.result, /fixed it/);
    assert.equal(res.plan.subtasks.length, 2);
    assert.ok(typeof res.quality.confidence === "number");
    assert.ok(res.savings.savedTokens !== undefined);
  });

  it("skips via the real gate for trivial tasks", async () => {
    const res = await runDecomposedTask("say hello", {
      _inject: { ...inject, analyze: async () => ({ score: 10, breakdown: { tokens: { estimated: 100 } } }) },
    });
    assert.equal(res.decomposed, false);
    assert.equal(res.reason, "below_complexity_threshold");
  });

  it("respects shadow mode (logs but does not decompose)", async () => {
    const original = config.taskDecomposition.shadow;
    config.taskDecomposition.shadow = true;
    try {
      const task = "implement A in a.js and then test it in a.test.js and document README.md";
      const res = await runDecomposedTask(task, { _inject: inject });
      assert.equal(res.decomposed, false);
      assert.equal(res.reason, "shadow_mode");
      assert.ok(res.gate);
    } finally {
      config.taskDecomposition.shadow = original;
    }
  });

  it("returns disabled when feature flag is off", async () => {
    const original = config.taskDecomposition.enabled;
    config.taskDecomposition.enabled = false;
    try {
      const res = await runDecomposedTask("anything", { _inject: inject });
      assert.equal(res.decomposed, false);
      assert.equal(res.reason, "disabled");
    } finally {
      config.taskDecomposition.enabled = original;
    }
  });
});
