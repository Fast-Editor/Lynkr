/**
 * Integration tests for the auto-spawn subagent pipeline.
 *
 * The orchestrator's "Invoking tool(s):" block is too coupled to mock end-to-end,
 * so these tests exercise the same logic flow the orchestrator uses:
 *   detection regex → mapToolsToAgentType → buildSubagentPrompt → spawnAgent → inject result
 *
 * This validates the integration between the components without requiring the full
 * orchestrator machinery (which would need ~15 mocks for invokeModel, sessions, etc.)
 */

const assert = require("assert");
const { describe, it } = require("node:test");
const { mapToolsToAgentType, buildSubagentPrompt } = require("../src/agents/tool-agent-mapper");

// ── Helpers ──────────────────────────────────────────────────────────────────

/** The exact regex used in the orchestrator (src/orchestrator/index.js) */
const INVOKING_TOOL_PATTERN = /^Invoking tool\(s\):\s*(.+)/im;

/**
 * Parse the "Invoking tool(s):" line exactly as the orchestrator does:
 *   strip XML/GLM-leaked tags, split by comma, trim, filter empties.
 */
function parseInvokingToolText(rawText) {
  const match = rawText?.trim().match(INVOKING_TOOL_PATTERN);
  if (!match) return null;
  return match[1]
    .replace(/<\/?\w+[^>]*>/g, "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
}

/**
 * Simulate the orchestrator's auto-spawn block.
 * Returns an object describing what happened (spawned, nudged, or skipped).
 */
async function runAutoSpawnBlock({
  rawTextContent,
  messages,
  agentsEnabled = true,
  autoSpawn = true,
  autoSpawnAttempts = 0,
  maxAutoSpawnAttempts = 2,
  invokeTextRetries = 0,
  maxInvokeTextRetries = 3,
  spawnAgentFn,
}) {
  const invokingToolMatch = rawTextContent?.trim().match(INVOKING_TOOL_PATTERN);
  if (!invokingToolMatch) return { action: "no_match" };

  const mentionedToolsRaw = invokingToolMatch[1]
    .replace(/<\/?\w+[^>]*>/g, "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);

  // ── Auto-spawn branch ──
  if (agentsEnabled && autoSpawn !== false && autoSpawnAttempts < maxAutoSpawnAttempts) {
    autoSpawnAttempts++;
    const agentType = mapToolsToAgentType(mentionedToolsRaw);
    const userText = (() => {
      for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (m?.role !== "user") continue;
        if (typeof m.content === "string") return m.content.trim();
        if (Array.isArray(m.content)) return m.content.map((b) => b.text || "").join("\n").trim();
      }
      return "";
    })();
    const prompt = buildSubagentPrompt(userText, rawTextContent, mentionedToolsRaw);

    try {
      const result = await spawnAgentFn(agentType, prompt, {});
      if (result.success) {
        messages.push({ role: "assistant", content: rawTextContent });
        messages.push({ role: "user", content: `[Subagent ${agentType} completed]\n${result.result}` });
        return { action: "spawned", agentType, prompt, autoSpawnAttempts, messages };
      }
      // spawn returned failure — fall through to nudge
    } catch (_err) {
      // spawn threw — fall through to nudge
    }
  }

  // ── Nudge-retry fallback ──
  if (invokeTextRetries < maxInvokeTextRetries) {
    invokeTextRetries++;
    messages.push({ role: "assistant", content: rawTextContent });
    messages.push({
      role: "user",
      content:
        `You responded with tool invocation text instead of using actual tool calls (attempt ${invokeTextRetries}/${maxInvokeTextRetries}). ` +
        "Please use the tool_call format, not text. Call the tools now with the correct parameters.",
    });
    return { action: "nudged", invokeTextRetries, messages };
  }

  return { action: "exhausted" };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("Auto-Spawn Integration — detection regex", () => {
  it("should match plain 'Invoking tool(s):' text", () => {
    const tools = parseInvokingToolText("Invoking tool(s): Read, Grep");
    assert.deepStrictEqual(tools, ["Read", "Grep"]);
  });

  it("should match mid-string (model adds preamble)", () => {
    const tools = parseInvokingToolText("I need to look at the file.\nInvoking tool(s): Read");
    assert.deepStrictEqual(tools, ["Read"]);
  });

  it("should strip GLM-leaked XML tags from tool names", () => {
    const tools = parseInvokingToolText("Invoking tool(s): Grep</arg_value>, Glob</think>");
    assert.deepStrictEqual(tools, ["Grep", "Glob"]);
  });

  it("should return null for unrelated text", () => {
    assert.strictEqual(parseInvokingToolText("I will help you."), null);
    assert.strictEqual(parseInvokingToolText(""), null);
    assert.strictEqual(parseInvokingToolText(null), null);
  });

  it("should handle repeated tool names (GLM-4.7 pattern)", () => {
    const tools = parseInvokingToolText("Invoking tool(s): Read, Read, Read");
    assert.deepStrictEqual(tools, ["Read", "Read", "Read"]);
  });
});

describe("Auto-Spawn Integration — full pipeline", () => {
  it("should call spawnAgent with Explore for read-only tools", async () => {
    let spawnedType, spawnedPrompt;
    const spawnAgentFn = async (type, prompt) => {
      spawnedType = type;
      spawnedPrompt = prompt;
      return { success: true, result: "EXPLORATION COMPLETE: found config.js" };
    };

    const messages = [{ role: "user", content: "Where is the config file?" }];
    const result = await runAutoSpawnBlock({
      rawTextContent: "Invoking tool(s): Read, Grep",
      messages,
      spawnAgentFn,
    });

    assert.strictEqual(result.action, "spawned");
    assert.strictEqual(spawnedType, "Explore");
    assert.ok(spawnedPrompt.includes("Where is the config file?"), "Prompt should include user text");
    assert.ok(spawnedPrompt.includes("Read"), "Prompt should mention Read");
    assert.ok(spawnedPrompt.includes("Grep"), "Prompt should mention Grep");
  });

  it("should call spawnAgent with general-purpose for write tools", async () => {
    let spawnedType;
    const spawnAgentFn = async (type) => {
      spawnedType = type;
      return { success: true, result: "TASK COMPLETE: edited the file" };
    };

    const messages = [{ role: "user", content: "Update the config" }];
    const result = await runAutoSpawnBlock({
      rawTextContent: "Invoking tool(s): Read, Edit",
      messages,
      spawnAgentFn,
    });

    assert.strictEqual(result.action, "spawned");
    assert.strictEqual(spawnedType, "general-purpose");
  });

  it("should inject assistant + user messages after successful spawn", async () => {
    const spawnAgentFn = async () => ({ success: true, result: "Found: src/config/index.js" });
    const messages = [{ role: "user", content: "Find config" }];
    const rawText = "Invoking tool(s): Read";

    const result = await runAutoSpawnBlock({ rawTextContent: rawText, messages, spawnAgentFn });

    assert.strictEqual(result.action, "spawned");
    // messages: original user + injected assistant + injected user
    assert.strictEqual(messages.length, 3);
    assert.strictEqual(messages[1].role, "assistant");
    assert.strictEqual(messages[1].content, rawText);
    assert.strictEqual(messages[2].role, "user");
    assert.ok(messages[2].content.includes("[Subagent Explore completed]"));
    assert.ok(messages[2].content.includes("Found: src/config/index.js"));
  });
});

describe("Auto-Spawn Integration — fallback to nudge", () => {
  it("should nudge when spawnAgent returns failure", async () => {
    const spawnAgentFn = async () => ({ success: false, error: "agent timed out" });
    const messages = [{ role: "user", content: "Search for files" }];

    const result = await runAutoSpawnBlock({
      rawTextContent: "Invoking tool(s): Glob",
      messages,
      spawnAgentFn,
    });

    assert.strictEqual(result.action, "nudged");
    assert.strictEqual(result.invokeTextRetries, 1);
    // messages: original user + injected assistant + nudge user
    assert.strictEqual(messages.length, 3);
    assert.ok(messages[2].content.includes("tool_call format"), "Nudge should mention tool_call format");
  });

  it("should nudge when spawnAgent throws", async () => {
    const spawnAgentFn = async () => { throw new Error("network error"); };
    const messages = [{ role: "user", content: "Search for files" }];

    const result = await runAutoSpawnBlock({
      rawTextContent: "Invoking tool(s): Read",
      messages,
      spawnAgentFn,
    });

    assert.strictEqual(result.action, "nudged");
  });

  it("should nudge when agents are disabled (agentsEnabled=false)", async () => {
    let spawnCalled = false;
    const spawnAgentFn = async () => { spawnCalled = true; return { success: true, result: "x" }; };
    const messages = [{ role: "user", content: "test" }];

    const result = await runAutoSpawnBlock({
      rawTextContent: "Invoking tool(s): Read",
      messages,
      agentsEnabled: false,
      spawnAgentFn,
    });

    assert.strictEqual(result.action, "nudged");
    assert.strictEqual(spawnCalled, false, "spawnAgent should NOT be called when disabled");
  });

  it("should nudge when autoSpawn config is false", async () => {
    let spawnCalled = false;
    const spawnAgentFn = async () => { spawnCalled = true; return { success: true, result: "x" }; };
    const messages = [{ role: "user", content: "test" }];

    const result = await runAutoSpawnBlock({
      rawTextContent: "Invoking tool(s): Read",
      messages,
      agentsEnabled: true,
      autoSpawn: false,
      spawnAgentFn,
    });

    assert.strictEqual(result.action, "nudged");
    assert.strictEqual(spawnCalled, false, "spawnAgent should NOT be called when autoSpawn=false");
  });
});

describe("Auto-Spawn Integration — attempt limits", () => {
  it("should not spawn when autoSpawnAttempts >= MAX_AUTO_SPAWN_ATTEMPTS", async () => {
    let spawnCalled = false;
    const spawnAgentFn = async () => { spawnCalled = true; return { success: true, result: "x" }; };
    const messages = [{ role: "user", content: "test" }];

    const result = await runAutoSpawnBlock({
      rawTextContent: "Invoking tool(s): Read",
      messages,
      autoSpawnAttempts: 2,       // already at cap
      maxAutoSpawnAttempts: 2,
      spawnAgentFn,
    });

    assert.ok(result.action !== "spawned", "Should not spawn when at attempt cap");
    assert.strictEqual(spawnCalled, false, "spawnAgent should not be called");
  });

  it("should nudge when spawn attempts exhausted but nudge retries remain", async () => {
    const spawnAgentFn = async () => ({ success: false, error: "fail" });
    const messages = [{ role: "user", content: "test" }];

    const result = await runAutoSpawnBlock({
      rawTextContent: "Invoking tool(s): Read",
      messages,
      autoSpawnAttempts: 2,       // spawn cap reached
      maxAutoSpawnAttempts: 2,
      invokeTextRetries: 0,
      maxInvokeTextRetries: 3,
      spawnAgentFn,
    });

    assert.strictEqual(result.action, "nudged");
  });

  it("should return exhausted when both spawn and nudge retries are maxed", async () => {
    const spawnAgentFn = async () => ({ success: false, error: "fail" });
    const messages = [{ role: "user", content: "test" }];

    const result = await runAutoSpawnBlock({
      rawTextContent: "Invoking tool(s): Read",
      messages,
      autoSpawnAttempts: 2,
      maxAutoSpawnAttempts: 2,
      invokeTextRetries: 3,
      maxInvokeTextRetries: 3,
      spawnAgentFn,
    });

    assert.strictEqual(result.action, "exhausted", "Should be exhausted when all retries used up");
  });

  it("autoSpawnAttempts increments correctly across sequential calls", async () => {
    let callCount = 0;
    const spawnAgentFn = async () => { callCount++; return { success: false, error: "fail" }; };

    // Simulate 2 sequential loop iterations (each time spawn fails → nudge)
    for (let attempt = 0; attempt < 2; attempt++) {
      const messages = [{ role: "user", content: "test" }];
      await runAutoSpawnBlock({
        rawTextContent: "Invoking tool(s): Read",
        messages,
        autoSpawnAttempts: attempt,
        maxAutoSpawnAttempts: 2,
        spawnAgentFn,
      });
    }

    // Attempt 0 → spawn called (becomes 1, fails → nudge)
    // Attempt 1 → spawn called (becomes 2, fails → nudge)
    assert.strictEqual(callCount, 2, "spawnAgent should be called once per attempt below cap");
  });
});
