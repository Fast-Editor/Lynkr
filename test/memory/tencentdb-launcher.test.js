const assert = require("assert");
const { describe, it, beforeEach, afterEach } = require("node:test");

const MODULES = [
  "../../src/config",
  "../../src/memory/tencentdb-launcher",
];

function clearModules() {
  for (const mod of MODULES) {
    try {
      delete require.cache[require.resolve(mod)];
    } catch { /* not loaded */ }
  }
}

describe("TencentDB Memory Launcher", () => {
  let savedEnv;

  beforeEach(() => {
    savedEnv = {
      TENCENTDB_MEMORY_ENABLED: process.env.TENCENTDB_MEMORY_ENABLED,
      TENCENTDB_MEMORY_DOCKER_ENABLED: process.env.TENCENTDB_MEMORY_DOCKER_ENABLED,
      TENCENTDB_MEMORY_LLM_BASE_URL: process.env.TENCENTDB_MEMORY_LLM_BASE_URL,
      TENCENTDB_MEMORY_LLM_MODEL: process.env.TENCENTDB_MEMORY_LLM_MODEL,
    };
    clearModules();
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    clearModules();
  });

  describe("config defaults", () => {
    it("is disabled by default", () => {
      delete process.env.TENCENTDB_MEMORY_ENABLED;
      const config = require("../../src/config");
      assert.strictEqual(config.tencentdbMemory.enabled, false);
    });

    it("enables via TENCENTDB_MEMORY_ENABLED=true", () => {
      process.env.TENCENTDB_MEMORY_ENABLED = "true";
      const config = require("../../src/config");
      assert.strictEqual(config.tencentdbMemory.enabled, true);
      assert.strictEqual(config.tencentdbMemory.docker.enabled, true);
    });

    it("defaults the memory LLM to Lynkr's own endpoint", () => {
      delete process.env.TENCENTDB_MEMORY_LLM_BASE_URL;
      const config = require("../../src/config");
      const { llm } = config.tencentdbMemory;
      assert.ok(llm.baseUrl.includes("host.docker.internal"));
      assert.ok(llm.baseUrl.endsWith("/v1"));
      assert.strictEqual(llm.model, "auto");
      assert.strictEqual(llm.protocol, "openai");
    });

    it("uses the upstream container names so external scripts are detected", () => {
      const config = require("../../src/config");
      assert.strictEqual(config.tencentdbMemory.docker.core.containerName, "tdai-memory-core");
      assert.strictEqual(config.tencentdbMemory.docker.hub.containerName, "tdai-memory-hub");
      assert.strictEqual(config.tencentdbMemory.docker.network, "tdai-memory-stack");
    });
  });

  describe("ensureRunning() gating", () => {
    it("skips when disabled", async () => {
      delete process.env.TENCENTDB_MEMORY_ENABLED;
      const launcher = require("../../src/memory/tencentdb-launcher");
      const result = await launcher.ensureRunning();
      assert.strictEqual(result.started, false);
      assert.strictEqual(result.reason, "disabled");
    });

    it("skips when docker management is disabled", async () => {
      process.env.TENCENTDB_MEMORY_ENABLED = "true";
      process.env.TENCENTDB_MEMORY_DOCKER_ENABLED = "false";
      const launcher = require("../../src/memory/tencentdb-launcher");
      const result = await launcher.ensureRunning();
      assert.strictEqual(result.started, false);
      assert.strictEqual(result.reason, "docker_disabled");
    });
  });

  describe("buildCoreConfigYaml()", () => {
    it("embeds the configured LLM settings", () => {
      process.env.TENCENTDB_MEMORY_LLM_BASE_URL = "https://api.example.com/v1";
      process.env.TENCENTDB_MEMORY_LLM_MODEL = "test-model";
      const launcher = require("../../src/memory/tencentdb-launcher");
      const yaml = launcher.buildCoreConfigYaml();

      assert.ok(yaml.includes('baseUrl: "https://api.example.com/v1"'));
      assert.ok(yaml.includes('model: "test-model"'));
      assert.ok(yaml.includes("deployMode: standalone"));
      assert.ok(yaml.includes("storeBackend: sqlite"));
    });

    it("defaults promptMode to code", () => {
      const launcher = require("../../src/memory/tencentdb-launcher");
      assert.ok(launcher.buildCoreConfigYaml().includes("promptMode: code"));
    });
  });

  describe("generateUserKey()", () => {
    it("produces the sk-mem-<32 alphanumeric> format", () => {
      const launcher = require("../../src/memory/tencentdb-launcher");
      const key = launcher.generateUserKey();
      assert.match(key, /^sk-mem-[A-Za-z0-9]{32}$/);
    });

    it("produces unique keys", () => {
      const launcher = require("../../src/memory/tencentdb-launcher");
      assert.notStrictEqual(launcher.generateUserKey(), launcher.generateUserKey());
    });
  });

  describe("maskKey()", () => {
    it("masks the middle of a key", () => {
      const launcher = require("../../src/memory/tencentdb-launcher");
      const masked = launcher.maskKey("sk-mem-abcdefghijklmnopqrstuvwxyz123456");
      assert.strictEqual(masked, "sk-mem-abcd****3456");
      assert.ok(!masked.includes("efghijkl"));
    });

    it("fully masks short or missing keys", () => {
      const launcher = require("../../src/memory/tencentdb-launcher");
      assert.strictEqual(launcher.maskKey("short"), "****");
      assert.strictEqual(launcher.maskKey(null), "****");
    });
  });
});
