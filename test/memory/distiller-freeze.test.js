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

function turn(userText, assistantText) {
  return [
    { role: "user", content: userText },
    { role: "assistant", content: assistantText },
  ];
}

function conversation(turns) {
  const messages = [];
  for (let i = 0; i < turns; i++) {
    messages.push(...turn(`Question number ${i}: how do I do task ${i}?`, `Answer ${i}: here is how.`));
  }
  return messages;
}

describe("Distiller freeze (Phase 5 — cache-aware routing)", () => {
  let distiller;
  let store;
  let testDbPath;

  beforeEach(() => {
    const timestamp = Date.now();
    const random = Math.floor(Math.random() * 1000000);
    testDbPath = path.join(__dirname, `../../data/test-distiller-freeze-${timestamp}-${random}.db`);
    process.env.SESSION_DB_PATH = testDbPath;

    clearModules();
    require("../../src/db");
    store = require("../../src/memory/store");
    distiller = require("../../src/memory/distiller");
  });

  afterEach(() => {
    try {
      const db = require("../../src/db");
      if (typeof db.close === "function") db.close();
    } catch { /* already closed */ }
    clearModules();
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        fs.unlinkSync(`${testDbPath}${suffix}`);
      } catch { /* missing */ }
    }
    delete process.env.SESSION_DB_PATH;
  });

  it("serves the frozen block verbatim on the next turn", () => {
    const sessionId = "freeze-1";
    const first = distiller.distillMessages(conversation(12), { sessionId });
    assert.strictEqual(first.applied, true);
    assert.strictEqual(first.stats.fromFrozenCache, undefined);
    const frozenContent = first.messages[0].content;

    // One more turn arrives — the block must be byte-identical.
    const next = distiller.distillMessages(conversation(13), { sessionId });
    assert.strictEqual(next.applied, true);
    assert.strictEqual(next.stats.fromFrozenCache, true);
    assert.strictEqual(next.messages[0].content, frozenContent);

    // The newest turn is still present verbatim after the frozen block.
    const lastMsg = next.messages[next.messages.length - 1];
    assert.ok(String(lastMsg.content).includes("Answer 12"));
  });

  it("stays byte-identical even when persona memories change between requests", () => {
    const sessionId = "freeze-persona";
    const first = distiller.distillMessages(conversation(12), { sessionId });
    const frozenContent = first.messages[0].content;

    // A new preference memory lands mid-window. Without the freeze this
    // would rewrite the distilled block (and bust the provider cache).
    store.createMemory({
      content: "User prefers TypeScript with strict mode",
      type: "preference",
      category: "user",
      importance: 0.9,
      sessionId: null,
    });

    const next = distiller.distillMessages(conversation(13), { sessionId });
    assert.strictEqual(next.stats.fromFrozenCache, true);
    assert.strictEqual(next.messages[0].content, frozenContent);
  });

  it("re-distills after K more user turns (default 5)", () => {
    const sessionId = "freeze-refresh";
    const first = distiller.distillMessages(conversation(12), { sessionId });
    const frozenContent = first.messages[0].content;

    // 12 → 17 turns: refresh window elapsed, block must be rebuilt.
    const refreshed = distiller.distillMessages(conversation(17), { sessionId });
    assert.strictEqual(refreshed.applied, true);
    assert.strictEqual(refreshed.stats.fromFrozenCache, undefined);
    assert.notStrictEqual(refreshed.messages[0].content, frozenContent);

    // And the new block freezes in turn.
    const after = distiller.distillMessages(conversation(18), { sessionId });
    assert.strictEqual(after.stats.fromFrozenCache, true);
    assert.strictEqual(after.messages[0].content, refreshed.messages[0].content);
  });

  it("invalidates the frozen block when the covered history is rewritten", () => {
    const sessionId = "freeze-rewrite";
    distiller.distillMessages(conversation(12), { sessionId });

    // Client-side rewrite (compaction/edit): first message changes.
    const rewritten = conversation(13);
    rewritten[0] = { role: "user", content: "TOTALLY DIFFERENT OPENER" };
    const result = distiller.distillMessages(rewritten, { sessionId });
    assert.strictEqual(result.applied, true);
    assert.strictEqual(result.stats.fromFrozenCache, undefined);
  });

  it("does not freeze without a sessionId", () => {
    const first = distiller.distillMessages(conversation(12), {});
    assert.strictEqual(first.applied, true);
    const second = distiller.distillMessages(conversation(13), {});
    assert.strictEqual(second.stats.fromFrozenCache, undefined);
  });

  it("_clearFrozen drops cached blocks (test isolation)", () => {
    const sessionId = "freeze-clear";
    distiller.distillMessages(conversation(12), { sessionId });
    distiller._clearFrozen();
    const result = distiller.distillMessages(conversation(13), { sessionId });
    assert.strictEqual(result.stats.fromFrozenCache, undefined);
  });
});
