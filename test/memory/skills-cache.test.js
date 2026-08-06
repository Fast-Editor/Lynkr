const assert = require("assert");
const { describe, it, beforeEach, afterEach } = require("node:test");
const fs = require("fs");
const path = require("path");

const MODULES = [
  "../../src/config",
  "../../src/db",
  "../../src/memory/store",
  "../../src/memory/skills-cache",
];

function clearModules() {
  for (const mod of MODULES) {
    try {
      delete require.cache[require.resolve(mod)];
    } catch { /* not loaded */ }
  }
}

/** Grep-like output — same shape regardless of the matched values. */
function grepOutput(query) {
  const lines = [];
  for (let i = 0; i < 40; i++) {
    lines.push(`src/file${i}.js:${i * 10}: const ${query}_${i} = require("./dep${i}");`);
  }
  return lines.join("\n");
}

describe("Skills Cache", () => {
  let skills;
  let store;
  let testDbPath;

  beforeEach(() => {
    const timestamp = Date.now();
    const random = Math.floor(Math.random() * 1000000);
    testDbPath = path.join(__dirname, `../../data/test-skills-${timestamp}-${random}.db`);
    process.env.SESSION_DB_PATH = testDbPath;

    clearModules();
    require("../../src/db");
    store = require("../../src/memory/store");
    skills = require("../../src/memory/skills-cache");
    skills.resetCache();
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

  describe("shapeSignature()", () => {
    it("is stable for identical text", () => {
      const text = grepOutput("auth");
      assert.strictEqual(skills.shapeSignature(text), skills.shapeSignature(text));
    });

    it("matches structurally identical outputs with different values", () => {
      assert.strictEqual(
        skills.shapeSignature(grepOutput("auth")),
        skills.shapeSignature(grepOutput("database"))
      );
    });

    it("differs for structurally different outputs", () => {
      const json = JSON.stringify({ results: [1, 2, 3], status: "ok" }, null, 2);
      assert.notStrictEqual(skills.shapeSignature(grepOutput("x")), skills.shapeSignature(json));
    });

    it("handles empty input", () => {
      assert.strictEqual(skills.shapeSignature(""), "empty");
      assert.strictEqual(skills.shapeSignature(null), "empty");
    });
  });

  describe("record() / lookup()", () => {
    it("returns null for unknown signatures", () => {
      assert.strictEqual(skills.lookup("nonexistent"), null);
    });

    it("records outcomes and tracks a running average", () => {
      const sig = skills.shapeSignature(grepOutput("x"));
      skills.record(sig, "distill", 0.8);
      skills.record(sig, "distill", 0.6);

      const skill = skills.lookup(sig);
      assert.ok(skill);
      assert.strictEqual(skill.hits, 2);
      assert.ok(Math.abs(skill.avgSavings - 0.7) < 0.001);
    });

    it("persists validated skills (savings >= 0.6) to the store", async () => {
      const sig = skills.shapeSignature(grepOutput("y"));
      skills.record(sig, "distill", 0.85);

      // Persistence happens via setImmediate — let it flush
      await new Promise(resolve => setImmediate(() => setImmediate(resolve)));

      const persisted = store.getMemoriesByType("skill", 10);
      assert.strictEqual(persisted.length, 1);
      const meta = typeof persisted[0].metadata === "string"
        ? JSON.parse(persisted[0].metadata)
        : persisted[0].metadata;
      assert.strictEqual(meta.signature, sig);
      assert.strictEqual(meta.method, "distill");
    });

    it("does not persist skills below the minimum savings bar", async () => {
      const sig = skills.shapeSignature(grepOutput("z"));
      skills.record(sig, "distill", 0.3);

      await new Promise(resolve => setImmediate(() => setImmediate(resolve)));

      assert.strictEqual(store.getMemoriesByType("skill", 10).length, 0);
      // Still tracked in memory for hint purposes
      assert.ok(skills.lookup(sig));
    });
  });

  describe("getCompressionHints()", () => {
    it("returns neutral hints for unknown shapes", () => {
      const hints = skills.getCompressionHints(grepOutput("new"));
      assert.strictEqual(hints.skipDedup, false);
      assert.strictEqual(hints.maxLengthFactor, 1);
      assert.ok(hints.signature);
    });

    it("requires at least 2 observations before applying hints", () => {
      const text = grepOutput("once");
      skills.record(skills.shapeSignature(text), "passthrough", 0.0);

      const hints = skills.getCompressionHints(text);
      assert.strictEqual(hints.skipDedup, false);
    });

    it("skips dedup for shapes that repeatedly failed to compress", () => {
      const text = grepOutput("futile");
      const sig = skills.shapeSignature(text);
      skills.record(sig, "passthrough", 0.0);
      skills.record(sig, "passthrough", 0.0);

      const hints = skills.getCompressionHints(text);
      assert.strictEqual(hints.skipDedup, true);
    });

    it("tightens the budget for proven-compressible shapes", () => {
      const text = grepOutput("compressible");
      const sig = skills.shapeSignature(text);
      skills.record(sig, "distill", 0.8);
      skills.record(sig, "distill", 0.75);

      const hints = skills.getCompressionHints(text);
      assert.strictEqual(hints.maxLengthFactor, 0.8);
      assert.strictEqual(hints.skipDedup, false);
    });
  });
});
