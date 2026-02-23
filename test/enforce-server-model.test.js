const assert = require("assert");
const { describe, it, beforeEach, afterEach } = require("node:test");

describe("ENFORCE_SERVER_MODEL Tests", () => {
  let originalEnv;

  beforeEach(() => {
    delete require.cache[require.resolve("../src/config")];
    originalEnv = { ...process.env };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe("Configuration", () => {
    it("should default to false when not set", () => {
      delete process.env.ENFORCE_SERVER_MODEL;
      const config = require("../src/config");

      assert.strictEqual(config.modelProvider.enforceServerModel, false);
    });

    it("should be true when set to 'true'", () => {
      process.env.ENFORCE_SERVER_MODEL = "true";
      delete require.cache[require.resolve("../src/config")];
      const config = require("../src/config");

      assert.strictEqual(config.modelProvider.enforceServerModel, true);
    });

    it("should be false when set to 'false'", () => {
      process.env.ENFORCE_SERVER_MODEL = "false";
      delete require.cache[require.resolve("../src/config")];
      const config = require("../src/config");

      assert.strictEqual(config.modelProvider.enforceServerModel, false);
    });

    it("should be false for any other value", () => {
      process.env.ENFORCE_SERVER_MODEL = "yes";
      delete require.cache[require.resolve("../src/config")];
      const config = require("../src/config");

      assert.strictEqual(config.modelProvider.enforceServerModel, false);
    });
  });

  describe("Model Selection Behavior", () => {
    it("should use MODEL_DEFAULT when ENFORCE_SERVER_MODEL is true", () => {
      process.env.MODEL_PROVIDER = "openrouter";
      process.env.MODEL_DEFAULT = "qwen/qwen3-coder-next";
      process.env.ENFORCE_SERVER_MODEL = "true";
      delete require.cache[require.resolve("../src/config")];
      const config = require("../src/config");

      assert.strictEqual(config.modelProvider.defaultModel, "qwen/qwen3-coder-next");
      assert.strictEqual(config.modelProvider.enforceServerModel, true);
    });

    it("should respect client model when ENFORCE_SERVER_MODEL is false", () => {
      process.env.MODEL_PROVIDER = "openrouter";
      process.env.MODEL_DEFAULT = "qwen/qwen3-coder-next";
      process.env.ENFORCE_SERVER_MODEL = "false";
      delete require.cache[require.resolve("../src/config")];
      const config = require("../src/config");

      assert.strictEqual(config.modelProvider.defaultModel, "qwen/qwen3-coder-next");
      assert.strictEqual(config.modelProvider.enforceServerModel, false);
    });
  });
});
