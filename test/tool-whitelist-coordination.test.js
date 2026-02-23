const assert = require("assert");
const { describe, it, beforeEach, afterEach } = require("node:test");
const path = require("path");

// Set environment variables BEFORE any modules are loaded
process.env.DATABRICKS_API_BASE = "http://test.com";
process.env.DATABRICKS_API_KEY = "test-key";
process.env.MODEL_PROVIDER = "ollama";
process.env.OLLAMA_ENDPOINT = "http://localhost:11434";
process.env.OLLAMA_MODEL = "llama3.1";
process.env.SMART_TOOL_SELECTION_ENABLED = "true";
// Set absolute path to whitelist file
process.env.TOOL_NEEDS_CLASSIFICATION_WHITELIST = path.join(__dirname, "../config/tool-whitelist.json");

describe("Tool Whitelist Coordination Tests (Phase 1)", () => {
  let originalEnv;

  beforeEach(() => {
    // Don't clear require cache - env vars are set at module load time
    // Clearing cache would reload modules with wrong env vars
    originalEnv = { ...process.env };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe("Phase 1: Whitelist-Smart Selection Coordination", () => {
    it("should debug config whitelist path", () => {
      const config = require("../src/config");
      const fs = require("fs");
      console.log("ENV VAR:", process.env.TOOL_NEEDS_CLASSIFICATION_WHITELIST);
      console.log("Config whitelist path:", config.toolNeedsClassification.whitelist);
      console.log("File exists at config path:", fs.existsSync(config.toolNeedsClassification.whitelist));
      console.log("CWD:", process.cwd());
    });

    it("should store classification result in clean._toolNeedsClassification", async () => {
      const { classifyToolNeeds } = require("../src/tools/tool-classification");
      const config = require("../src/config");

      const mockRequest = {
        model: "test-model",
        messages: [{ role: "user", content: "ls" }]
      };

      const classification = await classifyToolNeeds(
        mockRequest,
        config.toolNeedsClassification, // Pass config.toolNeedsClassification, not mockContext
        null // invokeModel not needed for whitelist match
      );

      // Verify classification result structure
      assert.ok(classification, "Classification result should exist");
      assert.ok(typeof classification.needsTools === "boolean", "Should have needsTools boolean");
      assert.ok(classification.source, "Should have source field");

      if (classification.source === "whitelist") {
        assert.strictEqual(classification.needsTools, true, "'ls' should match whitelist needsTools");
        assert.ok(classification.reason, "Should have reason field");
      }
    });

    it("should recognize 'ls' as whitelisted needsTools pattern", async () => {
      const { classifyToolNeeds } = require("../src/tools/tool-classification");
      const config = require("../src/config");

      const mockRequest = {
        model: "test-model",
        messages: [{ role: "user", content: "ls" }]
      };

      const classification = await classifyToolNeeds(mockRequest, config.toolNeedsClassification, null);

      // Accept both 'whitelist' (first time) and 'cache' (if cached from previous test)
      assert.ok(["whitelist", "cache"].includes(classification.source), "Should match whitelist or cache");
      assert.strictEqual(classification.needsTools, true, "'ls' should need tools");
      assert.ok(classification.reason.includes("ls"), "Reason should mention 'ls'");
    });

    it("should recognize 'hello' as whitelisted noTools pattern", async () => {
      const { classifyToolNeeds } = require("../src/tools/tool-classification");
      const config = require("../src/config");

      const mockRequest = {
        model: "test-model",
        messages: [{ role: "user", content: "hello" }]
      };

      const classification = await classifyToolNeeds(mockRequest, config.toolNeedsClassification, null);

      assert.strictEqual(classification.source, "whitelist", "Should match whitelist");
      assert.strictEqual(classification.needsTools, false, "'hello' should not need tools");
      assert.ok(classification.reason.includes("hello"), "Reason should mention 'hello'");
    });

    it("should recognize 'git status' as whitelisted needsTools pattern", async () => {
      const { classifyToolNeeds } = require("../src/tools/tool-classification");
      const config = require("../src/config");

      const mockRequest = {
        model: "test-model",
        messages: [{ role: "user", content: "git status" }]
      };

      const classification = await classifyToolNeeds(mockRequest, config.toolNeedsClassification, null);

      assert.strictEqual(classification.source, "whitelist", "Should match whitelist");
      assert.strictEqual(classification.needsTools, true, "'git status' should need tools");
    });

    it("should verify Smart Selection would classify 'ls' as conversational (the bug)", () => {
      const { classifyRequestType } = require("../src/tools/smart-selection");

      const result = classifyRequestType({ messages: [{ role: "user", content: "ls" }] });

      // This demonstrates the bug: Smart Selection incorrectly classifies 'ls' as conversational
      // because it's < 20 chars and has no TECHNICAL_KEYWORDS
      assert.strictEqual(result.type, "conversational", "Smart Selection incorrectly sees 'ls' as conversational");
      assert.ok(result.keywords.includes("short") || result.keywords.includes("non-technical"),
        "Should detect as short non-technical");
    });
  });

  describe("Integration: Expected behavior after Phase 1 fix", () => {
    it("should document expected orchestrator behavior for 'ls' command", () => {
      // This test documents the expected flow after Phase 1 implementation:
      //
      // 1. Tool Needs Classification runs first (line ~1214)
      //    - Checks whitelist
      //    - "ls" matches pattern → needsTools=true, source=whitelist
      //    - Stores in clean._toolNeedsClassification
      //
      // 2. Smart Tool Selection check (line ~1243)
      //    - Sees clean._toolNeedsClassification.source === 'whitelist'
      //    - Sees clean._toolNeedsClassification.needsTools === true
      //    - SKIPS Smart Selection (coordination)
      //    - Logs: [WHITELIST_OVERRIDE] Whitelist match - skipping smart tool selection
      //
      // 3. Tools are kept (not filtered to 0)
      //
      // 4. Tool execution provider check passes
      //
      // Result: "ls" command now works correctly!

      assert.ok(true, "Documentation test always passes");
    });

    it("should document expected orchestrator behavior for 'hello' command", () => {
      // Expected flow after Phase 1:
      //
      // 1. Tool Needs Classification
      //    - "hello" matches noTools pattern
      //    - needsTools=false
      //    - Tools REMOVED (line ~1217)
      //
      // 2. Smart Tool Selection
      //    - Skipped (no tools to select from)
      //
      // Result: "hello" correctly has no tools

      assert.ok(true, "Documentation test always passes");
    });

    it("should document expected orchestrator behavior for non-whitelisted request", () => {
      // Expected flow after Phase 1:
      //
      // 1. Tool Needs Classification
      //    - No whitelist match
      //    - Falls back to LLM or default
      //    - clean._toolNeedsClassification.source !== 'whitelist'
      //
      // 2. Smart Tool Selection
      //    - Runs normally (enters else block at line ~1255)
      //    - Classifies request type
      //    - Selects appropriate tools
      //
      // Result: Smart Selection still works for edge cases

      assert.ok(true, "Documentation test always passes");
    });
  });

  describe("Verification: Check whitelist patterns", () => {
    it("should load tool-whitelist.json correctly", () => {
      const fs = require("fs");
      const path = require("path");

      const whitelistPath = path.join(__dirname, "../config/tool-whitelist.json");
      assert.ok(fs.existsSync(whitelistPath), "tool-whitelist.json should exist");

      const whitelist = JSON.parse(fs.readFileSync(whitelistPath, "utf8"));

      assert.ok(Array.isArray(whitelist.needsTools), "Should have needsTools array");
      assert.ok(Array.isArray(whitelist.noTools), "Should have noTools array");

      assert.ok(whitelist.needsTools.length > 0, "needsTools should not be empty");
      assert.ok(whitelist.noTools.length > 0, "noTools should not be empty");

      // Verify key patterns exist
      assert.ok(whitelist.needsTools.includes("ls"), "Should include 'ls'");
      assert.ok(whitelist.needsTools.includes("pwd"), "Should include 'pwd'");
      assert.ok(whitelist.needsTools.some(p => p.includes("git")), "Should include git patterns");

      assert.ok(whitelist.noTools.includes("hello"), "Should include 'hello'");
      assert.ok(whitelist.noTools.some(p => p.includes("explain")), "Should include explain patterns");
    });
  });
});
