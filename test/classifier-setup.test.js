/**
 * Contract tests for classifier-setup.js.
 *
 * These tests don't require ollama — they exercise the module surface and
 * the failure paths. Live ollama behavior is covered by manual live-probe
 * verification (see documentation/routing.md).
 */
const assert = require("assert");
const { describe, it } = require("node:test");

const {
  detectOllama,
  isModelPulled,
  installInstructions,
  ensureClassifierReady,
} = require("../src/routing/classifier-setup");

describe("classifier-setup — install instructions", () => {
  it("returns a non-empty message referencing ollama.com", () => {
    const msg = installInstructions();
    assert.ok(msg.length > 30);
    assert.match(msg, /ollama/i);
    assert.match(msg, /lynkr init/i);
  });

  it("is platform-specific but always includes a URL or command", () => {
    const msg = installInstructions();
    assert.match(msg, /brew install|curl.*install\.sh|ollama\.com\/download/i);
  });
});

describe("classifier-setup — detectOllama", () => {
  it("returns an object with installed: boolean", async () => {
    const r = await detectOllama();
    assert.strictEqual(typeof r.installed, "boolean");
    if (r.installed) assert.strictEqual(typeof r.version, "string");
  });
});

describe("classifier-setup — ensureClassifierReady (boot mode)", () => {
  it("returns a result object with ready/ollama/model fields", async () => {
    // Boot mode never blocks or throws; result reflects what's on this box.
    const r = await ensureClassifierReady({
      mode: 'boot',
      log: () => {},
      warn: () => {},
    });
    assert.strictEqual(typeof r.ready, "boolean");
    assert.strictEqual(typeof r.ollama, "boolean");
    assert.strictEqual(typeof r.model, "boolean");
    if (!r.ready) {
      assert.ok(['ollama_missing', 'model_missing', 'pull_declined', 'pull_failed', 'non_ollama_provider'].includes(r.reason),
        `unexpected reason: ${r.reason}`);
    }
  });

  it("boot mode never throws, even when everything is missing", async () => {
    // Call directly — should resolve, never reject.
    await assert.doesNotReject(ensureClassifierReady({ mode: 'boot', log: () => {}, warn: () => {} }));
  });
});
