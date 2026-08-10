const assert = require("assert");
const { describe, it, beforeEach, afterEach } = require("node:test");
const fs = require("fs");
const path = require("path");

const MODULES = [
  "../../src/config",
  "../../src/db",
  "../../src/memory/store",
  "../../src/memory/wiki",
];

function clearModules() {
  for (const mod of MODULES) {
    try {
      delete require.cache[require.resolve(mod)];
    } catch { /* not loaded */ }
  }
}

/** Generate a large distinctive text block (> 500 tokens ≈ 2000 chars). */
function largeBlock(seed) {
  const lines = [];
  for (let i = 0; i < 60; i++) {
    lines.push(`${seed} configuration line ${i}: value_${seed}_${i} = setting-${i}`);
  }
  return lines.join("\n");
}

describe("Wiki Registry", () => {
  let wiki;
  let testDbPath;

  beforeEach(() => {
    const timestamp = Date.now();
    const random = Math.floor(Math.random() * 1000000);
    testDbPath = path.join(__dirname, `../../data/test-wiki-${timestamp}-${random}.db`);
    process.env.SESSION_DB_PATH = testDbPath;

    clearModules();
    require("../../src/db");
    wiki = require("../../src/memory/wiki");
    wiki.resetCache();
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

  describe("registerOrDereference()", () => {
    it("ignores blocks below the size threshold", () => {
      assert.strictEqual(wiki.registerOrDereference("short text"), null);
      assert.strictEqual(wiki.registerOrDereference(""), null);
      assert.strictEqual(wiki.registerOrDereference(null), null);
    });

    it("registers a new large block and returns null the first time", () => {
      assert.strictEqual(wiki.registerOrDereference(largeBlock("alpha")), null);
    });

    it("returns a compact reference for a near-identical repeat", () => {
      const block = largeBlock("beta");
      wiki.registerOrDereference(block);

      // Same block with a couple of changed lines — still >= 85% similar
      const repeat = block.replace("line 0:", "line 0 (edited):");
      const result = wiki.registerOrDereference(repeat);

      assert.ok(result, "expected a wiki reference for repeated content");
      assert.ok(result.ref.startsWith("[wiki:"));
      assert.ok(result.saved > repeat.length * 0.9, "reference should be far smaller than original");
    });

    it("does not match dissimilar blocks", () => {
      wiki.registerOrDereference(largeBlock("gamma"));
      assert.strictEqual(wiki.registerOrDereference(largeBlock("delta")), null);
    });

    it("persists entries across cache resets (cross-session dedup)", () => {
      const block = largeBlock("epsilon");
      wiki.registerOrDereference(block);

      wiki.resetCache(); // simulate a new session reloading from SQLite

      const result = wiki.registerOrDereference(block);
      assert.ok(result, "expected persisted entry to be found after reload");
    });
  });

  describe("dereferenceMessages()", () => {
    it("replaces repeated large blocks inside old history", () => {
      const block = largeBlock("zeta");
      wiki.registerOrDereference(block);

      const messages = [
        { role: "user", content: "small message" },
        { role: "user", content: block },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "t1", content: block }],
        },
      ];

      const { messages: processed, stats } = wiki.dereferenceMessages(messages);

      assert.strictEqual(stats.dereferenced, 2);
      assert.ok(stats.charsSaved > 0);
      assert.strictEqual(processed[0].content, "small message");
      assert.ok(processed[1].content.startsWith("[wiki:"));
      assert.ok(processed[2].content[0].content.startsWith("[wiki:"));
    });

    it("registers unseen large blocks for future dedup", () => {
      const messages = [{ role: "user", content: largeBlock("eta") }];
      const { stats } = wiki.dereferenceMessages(messages);
      assert.strictEqual(stats.registered, 1);
      assert.strictEqual(stats.dereferenced, 0);
    });

    it("handles empty input", () => {
      const { messages, stats } = wiki.dereferenceMessages([]);
      assert.deepStrictEqual(messages, []);
      assert.strictEqual(stats.dereferenced, 0);
    });
  });
});
