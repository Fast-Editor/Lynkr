const assert = require("assert");
const { describe, it } = require("node:test");

// Regression coverage for the sub-agent learning loop (Reflector → Skillbook →
// live prompt re-injection via the definition loader). These pieces existed but
// were effectively dead: the Reflector read context fields the context manager
// never set, so reflection threw and nothing was ever persisted or injected.

const Reflector = require("../src/agents/reflector");
const Skillbook = require("../src/agents/skillbook");
const ContextManager = require("../src/agents/context-manager");
const AgentDefinitionLoader = require("../src/agents/definitions/loader");

function populatedContext(overrides = {}) {
  return {
    agentName: "Fix",
    taskPrompt: "fix the login bug in the auth handler",
    steps: 4,
    maxSteps: 10,
    inputTokens: 1200,
    outputTokens: 800,
    transcript: [
      { type: "tool_call", toolName: "Read", error: null, timestamp: 1 },
      { type: "tool_call", toolName: "Grep", error: "not found", timestamp: 2 },
      { type: "tool_call", toolName: "Read", error: null, timestamp: 3 },
      { type: "tool_call", toolName: "Edit", error: null, timestamp: 4 },
    ],
    ...overrides,
  };
}

describe("context manager populates the fields the Reflector consumes", () => {
  it("sets taskPrompt and an in-memory transcript on the context", () => {
    const cm = new ContextManager();
    const agentDef = { name: "Fix", systemPrompt: "sp", maxSteps: 5, model: "sonnet", allowedTools: [] };
    const ctx = cm.createSubagentContext(agentDef, "fix the crash on startup");

    assert.strictEqual(ctx.taskPrompt, "fix the crash on startup");
    assert.ok(Array.isArray(ctx.transcript), "transcript should be an array");
    assert.strictEqual(ctx.transcript.length, 0);
  });

  it("mirrors tool calls into context.transcript as they are recorded", () => {
    const cm = new ContextManager();
    const agentDef = { name: "Fix", systemPrompt: "sp", maxSteps: 5, model: "sonnet", allowedTools: [] };
    const ctx = cm.createSubagentContext(agentDef, "task");

    cm.recordToolCall(ctx, "Read", { path: "a.js" }, "contents", null);
    cm.recordToolCall(ctx, "Grep", { q: "x" }, null, new Error("boom"));

    assert.strictEqual(ctx.transcript.length, 2);
    assert.strictEqual(ctx.transcript[0].toolName, "Read");
    assert.strictEqual(ctx.transcript[0].error, null);
    assert.strictEqual(ctx.transcript[1].toolName, "Grep");
    assert.strictEqual(ctx.transcript[1].error, "boom");
  });
});

describe("Reflector extracts patterns from a populated context", () => {
  it("does not throw and returns patterns for a successful run", () => {
    const patterns = Reflector.reflect(populatedContext(), true);
    assert.ok(patterns.length > 0, "expected at least one pattern");
    assert.ok(
      patterns.some((p) => /Fix task/i.test(p.pattern)),
      "expected task type to be inferred from the prompt"
    );
  });

  it("identifies the recovery tool after the last failed tool (index-bug fix)", () => {
    const patterns = Reflector.reflect(populatedContext(), true);
    const recovery = patterns.find((p) => p.pattern === "Error recovery strategy");
    assert.ok(recovery, "expected an error-recovery pattern");
    // Read/Edit ran after the failed Grep -> a real recovery tool, not undefined.
    assert.match(recovery.action, /After Grep fails, try (Read|Edit)/);
    assert.doesNotMatch(recovery.action, /undefined/);
  });

  it("never throws when the task prompt is missing", () => {
    assert.doesNotThrow(() =>
      Reflector.reflect(populatedContext({ taskPrompt: undefined }), true)
    );
    assert.strictEqual(Reflector._inferTaskType(undefined), null);
    assert.strictEqual(Reflector._inferTaskType(""), null);
  });
});

describe("Skillbook persistence shape", () => {
  it("stores extracted patterns and formats a prompt block", () => {
    const patterns = Reflector.reflect(populatedContext(), true);
    const sb = new Skillbook("Fix");
    for (const p of patterns) sb.addSkill(p);

    assert.ok(sb.skills.size > 0);
    assert.match(sb.formatForPrompt(), /Previously Learned Skills/);
  });
});

describe("loader re-injects learned skills live and idempotently", () => {
  it("injects a skills block exactly once even when called repeatedly", () => {
    const loader = new AgentDefinitionLoader();
    const agent = loader.getAgent("Fix");
    assert.ok(agent, "built-in Fix agent should exist");

    const sb = new Skillbook("Fix");
    for (const p of Reflector.reflect(populatedContext(), true)) sb.addSkill(p);

    const before = agent.systemPrompt.length;
    loader.setSkillbook("fix", sb); // case-insensitive key resolution
    loader.setSkillbook("Fix", sb); // second call must not duplicate

    const occurrences =
      agent.systemPrompt.split("Previously Learned Skills").length - 1;
    assert.strictEqual(occurrences, 1, "skills block should appear exactly once");
    assert.ok(agent.systemPrompt.length > before, "prompt should grow with skills");
  });

  it("ignores unknown agent types without throwing", () => {
    const loader = new AgentDefinitionLoader();
    assert.doesNotThrow(() => loader.setSkillbook("does-not-exist", new Skillbook("x")));
    assert.doesNotThrow(() => loader.setSkillbook(null, null));
  });
});

describe("periodic skill pruning", () => {
  it("prunes proven-bad skills but keeps fresh ones", async () => {
    const loader = new AgentDefinitionLoader();
    const sb = new Skillbook("Fix");

    // Proven-bad: tried enough to prove it doesn't help (useCount>=3, low conf).
    sb.skills.set("bad", {
      pattern: "bad", action: "x", reasoning: "", tools: [],
      confidence: 0.1, useCount: 5, createdAt: 1, lastUsed: 1,
    });
    // Fresh: low confidence but not enough uses yet — must survive.
    sb.skills.set("fresh", {
      pattern: "fresh", action: "y", reasoning: "", tools: [],
      confidence: 0.1, useCount: 1, createdAt: 1, lastUsed: 1,
    });
    // Good: high confidence — must survive.
    sb.skills.set("good", {
      pattern: "good", action: "z", reasoning: "", tools: [],
      confidence: 0.9, useCount: 10, createdAt: 1, lastUsed: 1,
    });

    // Avoid touching disk in the test.
    sb.save = async () => true;
    loader.setSkillbook("Fix", sb);

    const pruned = await loader.pruneSkillbooks();
    assert.strictEqual(pruned, 1, "only the proven-bad skill should be pruned");
    assert.ok(!sb.skills.has("bad"));
    assert.ok(sb.skills.has("fresh"));
    assert.ok(sb.skills.has("good"));
  });

  it("start is idempotent, uses an unref'd timer, and stops cleanly", () => {
    const loader = new AgentDefinitionLoader();
    loader.startSkillPruning(60000);
    const first = loader.pruneTimer;
    assert.ok(first, "timer should be set");
    loader.startSkillPruning(60000); // idempotent
    assert.strictEqual(loader.pruneTimer, first, "should not replace the timer");

    loader.stopSkillPruning();
    assert.strictEqual(loader.pruneTimer, null);
  });

  it("treats a non-positive interval as disabled", () => {
    const loader = new AgentDefinitionLoader();
    loader.startSkillPruning(0);
    assert.strictEqual(loader.pruneTimer, null);
    loader.startSkillPruning(-5);
    assert.strictEqual(loader.pruneTimer, null);
  });
});
