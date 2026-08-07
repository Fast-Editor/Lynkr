const assert = require("assert");
const { describe, it, beforeEach, afterEach } = require("node:test");
const fs = require("fs");
const path = require("path");

const MODULES = [
  "../../src/config",
  "../../src/db",
  "../../src/memory/store",
  "../../src/memory/extractor",
  "../../src/memory/wiki",
  "../../src/memory/skills-cache",
  "../../src/memory/distiller",
];

function clearModules() {
  for (const mod of MODULES) {
    try {
      delete require.cache[require.resolve(mod)];
    } catch { /* not loaded */ }
  }
}

/** Build a user+assistant exchange (one turn). */
function turn(userText, assistantText) {
  return [
    { role: "user", content: userText },
    { role: "assistant", content: assistantText },
  ];
}

/** Build a conversation with N user turns. */
function conversation(turns) {
  const messages = [];
  for (let i = 0; i < turns; i++) {
    messages.push(...turn(`Question number ${i}: how do I do task ${i}?`, `Answer ${i}: here is how.`));
  }
  return messages;
}

describe("Conversation Distiller", () => {
  let distiller;
  let store;
  let testDbPath;

  beforeEach(() => {
    const timestamp = Date.now();
    const random = Math.floor(Math.random() * 1000000);
    testDbPath = path.join(__dirname, `../../data/test-distiller-${timestamp}-${random}.db`);
    process.env.SESSION_DB_PATH = testDbPath;

    clearModules();
    require("../../src/db");
    store = require("../../src/memory/store");
    distiller = require("../../src/memory/distiller");
  });

  afterEach(() => {
    try {
      const db = require("../../src/db");
      if (db && typeof db.close === "function") db.close();
    } catch { /* already closed */ }

    clearModules();

    try {
      for (const file of [testDbPath, `${testDbPath}-wal`, `${testDbPath}-shm`, `${testDbPath}-journal`]) {
        if (fs.existsSync(file)) fs.unlinkSync(file);
      }
    } catch { /* ignore cleanup errors */ }
  });

  describe("needsDistillation()", () => {
    it("returns false below the turn threshold", () => {
      assert.strictEqual(distiller.needsDistillation(conversation(9)), false);
    });

    it("returns true at the turn threshold (10 turns)", () => {
      assert.strictEqual(distiller.needsDistillation(conversation(10)), true);
    });

    it("returns false for empty input", () => {
      assert.strictEqual(distiller.needsDistillation([]), false);
      assert.strictEqual(distiller.needsDistillation(null), false);
    });

    it("fires the size-based rescue trigger before the turn threshold", () => {
      // 5 turns (below the 10-turn threshold) but with a huge pasted block
      // — the scenario that overflows a 4k-context local model
      const bigBlock = "config line: value = setting\n".repeat(500); // ~14.5k chars ≈ 3.6k tokens
      const messages = [
        ...turn("Review this config:\n" + bigBlock, "Looks mostly fine."),
        ...turn("What about the timeout?", "Timeout is 65s."),
        ...turn("And the gzip settings?", "Enabled globally."),
        ...turn("Should I change keepalive?", "No, 65 is standard."),
        ...turn("What about worker processes?", "Set to auto."),
      ];
      assert.strictEqual(distiller.needsDistillation(messages), true);

      const result = distiller.distillMessages(messages);
      assert.strictEqual(result.applied, true);
      // Last 3 turns verbatim + distilled block
      assert.strictEqual(result.messages.length, 7);
      assert.ok(result.messages[0].content.startsWith("[Distilled context"));
    });

    it("does not fire the size trigger when turns fit in the keep window", () => {
      const bigBlock = "config line: value = setting\n".repeat(500);
      // Only 3 turns — everything is in the keep window, nothing to distill
      const messages = [
        ...turn("Review this:\n" + bigBlock, "OK."),
        ...turn("Question two?", "Answer two."),
        ...turn("Question three?", "Answer three."),
      ];
      assert.strictEqual(distiller.needsDistillation(messages), false);
    });

    it("does not fire the size trigger on small conversations", () => {
      assert.strictEqual(distiller.needsDistillation(conversation(5)), false);
    });

    it("does not count tool_result-only user messages as turns", () => {
      const messages = [];
      for (let i = 0; i < 6; i++) {
        messages.push({ role: "user", content: `Question ${i}` });
        messages.push({
          role: "assistant",
          content: [{ type: "tool_use", id: `t${i}`, name: "Bash", input: {} }],
        });
        messages.push({
          role: "user",
          content: [{ type: "tool_result", tool_use_id: `t${i}`, content: "output" }],
        });
        messages.push({ role: "assistant", content: `Answer ${i}` });
      }
      // 6 real turns but 12 user-role messages — must not distill
      assert.strictEqual(distiller.needsDistillation(messages), false);
    });
  });

  describe("distillMessages()", () => {
    it("returns unchanged messages when below threshold", () => {
      const messages = conversation(5);
      const result = distiller.distillMessages(messages);
      assert.strictEqual(result.applied, false);
      assert.strictEqual(result.messages, messages);
    });

    it("keeps the last 3 user turns verbatim and prepends one distilled block", () => {
      const messages = conversation(12);
      const result = distiller.distillMessages(messages);

      assert.strictEqual(result.applied, true);
      // 3 turns × 2 messages + 1 distilled block
      assert.strictEqual(result.messages.length, 7);
      assert.ok(result.messages[0].content.startsWith("[Distilled context"));
      // Recent turns preserved exactly
      assert.strictEqual(result.messages[1].content, "Question number 9: how do I do task 9?");
      assert.strictEqual(result.messages[6].content, "Answer 11: here is how.");
    });

    it("summarizes dropped requests in the distilled block", () => {
      const result = distiller.distillMessages(conversation(12));
      assert.ok(result.messages[0].content.includes("Requests"));
      assert.ok(result.messages[0].content.includes("Question number"));
    });

    it("never splits a tool_use / tool_result pair", () => {
      const messages = [];
      for (let i = 0; i < 12; i++) {
        messages.push({ role: "user", content: `Question ${i}` });
        messages.push({
          role: "assistant",
          content: [
            { type: "text", text: `Working on ${i}` },
            { type: "tool_use", id: `t${i}`, name: "Read", input: { file: "a.js" } },
          ],
        });
        messages.push({
          role: "user",
          content: [{ type: "tool_result", tool_use_id: `t${i}`, content: `result ${i}` }],
        });
        messages.push({ role: "assistant", content: `Done with ${i}` });
      }

      const result = distiller.distillMessages(messages);
      assert.strictEqual(result.applied, true);

      // Every tool_result in the kept window must have its tool_use present
      const kept = result.messages;
      const toolUseIds = new Set();
      for (const msg of kept) {
        if (!Array.isArray(msg.content)) continue;
        for (const block of msg.content) {
          if (block.type === "tool_use") toolUseIds.add(block.id);
          if (block.type === "tool_result") {
            assert.ok(
              toolUseIds.has(block.tool_use_id),
              `tool_result ${block.tool_use_id} orphaned from its tool_use`
            );
          }
        }
      }
    });

    it("reports meaningful savings on long conversations", () => {
      const result = distiller.distillMessages(conversation(20));
      assert.strictEqual(result.applied, true);
      assert.ok(parseFloat(result.stats.savingsPct) > 50, `expected >50% savings, got ${result.stats.savingsPct}%`);
    });

    it("includes stored user preferences as persona (L3)", () => {
      store.createMemory({
        content: "User prefers TypeScript with strict mode",
        type: "preference",
        category: "user",
        importance: 0.9,
        sessionId: null,
      });

      const result = distiller.distillMessages(conversation(12), { sessionId: null });
      assert.ok(result.messages[0].content.includes("User profile:"));
      assert.ok(result.messages[0].content.includes("TypeScript"));
    });

    it("counts tool usage in the scenario (L2)", () => {
      const messages = [];
      for (let i = 0; i < 12; i++) {
        messages.push({ role: "user", content: `Question ${i}` });
        messages.push({
          role: "assistant",
          content: [
            { type: "text", text: `Answer ${i}` },
            { type: "tool_use", id: `t${i}`, name: "Bash", input: {} },
          ],
        });
        messages.push({
          role: "user",
          content: [{ type: "tool_result", tool_use_id: `t${i}`, content: "ok" }],
        });
        messages.push({ role: "assistant", content: `Done ${i}` });
      }

      const result = distiller.distillMessages(messages);
      assert.ok(result.messages[0].content.includes("Tools used:"));
      assert.ok(result.messages[0].content.includes("Bash"));
    });
  });
});
