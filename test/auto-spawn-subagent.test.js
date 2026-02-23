const assert = require("assert");
const { describe, it } = require("node:test");
const { mapToolsToAgentType, buildSubagentPrompt, TOOL_TO_AGENT } = require("../src/agents/tool-agent-mapper");

describe("Auto-Spawn Subagent — tool-agent-mapper", () => {

  describe("mapToolsToAgentType", () => {
    it("should return 'Explore' for read-only tools (Read, Grep, Glob)", () => {
      assert.strictEqual(mapToolsToAgentType(["Read"]), "Explore");
      assert.strictEqual(mapToolsToAgentType(["Grep"]), "Explore");
      assert.strictEqual(mapToolsToAgentType(["Glob"]), "Explore");
      assert.strictEqual(mapToolsToAgentType(["Read", "Grep", "Glob"]), "Explore");
    });

    it("should return 'general-purpose' when Edit is mentioned", () => {
      assert.strictEqual(mapToolsToAgentType(["Edit"]), "general-purpose");
    });

    it("should return 'general-purpose' when Write is mentioned", () => {
      assert.strictEqual(mapToolsToAgentType(["Write"]), "general-purpose");
    });

    it("should return 'general-purpose' when Bash is mentioned", () => {
      assert.strictEqual(mapToolsToAgentType(["Bash"]), "general-purpose");
    });

    it("should return 'general-purpose' for mixed read + write tools", () => {
      assert.strictEqual(mapToolsToAgentType(["Read", "Edit"]), "general-purpose");
      assert.strictEqual(mapToolsToAgentType(["Grep", "Bash", "Read"]), "general-purpose");
    });

    it("should handle duplicate tool names (GLM-4.7 repeats)", () => {
      assert.strictEqual(mapToolsToAgentType(["Read", "Read", "Read"]), "Explore");
      assert.strictEqual(mapToolsToAgentType(["Read", "Read", "Edit"]), "general-purpose");
    });

    it("should return 'Explore' for unknown tools (safe default)", () => {
      assert.strictEqual(mapToolsToAgentType(["UnknownTool"]), "Explore");
      assert.strictEqual(mapToolsToAgentType(["FooBar", "Read"]), "Explore");
    });

    it("should return 'Explore' for empty or invalid input", () => {
      assert.strictEqual(mapToolsToAgentType([]), "Explore");
      assert.strictEqual(mapToolsToAgentType(null), "Explore");
      assert.strictEqual(mapToolsToAgentType(undefined), "Explore");
    });

    it("should return 'Explore' for workspace_search and workspace_symbol_search", () => {
      assert.strictEqual(mapToolsToAgentType(["workspace_search"]), "Explore");
      assert.strictEqual(mapToolsToAgentType(["workspace_symbol_search"]), "Explore");
    });
  });

  describe("TOOL_TO_AGENT mapping", () => {
    it("should map all read-only tools to Explore", () => {
      assert.strictEqual(TOOL_TO_AGENT.Read, "Explore");
      assert.strictEqual(TOOL_TO_AGENT.Grep, "Explore");
      assert.strictEqual(TOOL_TO_AGENT.Glob, "Explore");
      assert.strictEqual(TOOL_TO_AGENT.workspace_search, "Explore");
      assert.strictEqual(TOOL_TO_AGENT.workspace_symbol_search, "Explore");
    });

    it("should map write/execute tools to general-purpose", () => {
      assert.strictEqual(TOOL_TO_AGENT.Edit, "general-purpose");
      assert.strictEqual(TOOL_TO_AGENT.Write, "general-purpose");
      assert.strictEqual(TOOL_TO_AGENT.Bash, "general-purpose");
    });
  });

  describe("buildSubagentPrompt", () => {
    it("should include user text in the prompt", () => {
      const prompt = buildSubagentPrompt("Show me the config file", "Invoking tool(s): Read", ["Read"]);
      assert.ok(prompt.includes("Show me the config file"), "Prompt should contain user text");
    });

    it("should include deduplicated tool list", () => {
      const prompt = buildSubagentPrompt("search code", "Invoking tool(s): Read, Read, Grep", ["Read", "Read", "Grep"]);
      // Should deduplicate: "Read, Grep" not "Read, Read, Grep"
      assert.ok(prompt.includes("Read, Grep"), "Prompt should contain deduplicated tool list");
    });

    it("should include tool names in prompt", () => {
      const prompt = buildSubagentPrompt("find files", "Invoking tool(s): Glob, Grep", ["Glob", "Grep"]);
      assert.ok(prompt.includes("Glob"), "Prompt should mention Glob");
      assert.ok(prompt.includes("Grep"), "Prompt should mention Grep");
    });

    it("should include instruction to complete the task", () => {
      const prompt = buildSubagentPrompt("test", "Invoking tool(s): Read", ["Read"]);
      assert.ok(prompt.includes("Complete this task"), "Prompt should include task completion instruction");
    });

    it("should handle empty user text gracefully", () => {
      const prompt = buildSubagentPrompt("", "Invoking tool(s): Read", ["Read"]);
      assert.ok(typeof prompt === "string", "Should return a string");
      assert.ok(prompt.length > 0, "Should not be empty");
    });
  });
});
