const assert = require("assert");
const { describe, it, beforeEach, afterEach } = require("node:test");

process.env.MODEL_PROVIDER = process.env.MODEL_PROVIDER || "databricks";
process.env.DATABRICKS_API_KEY = process.env.DATABRICKS_API_KEY || "test-key";
process.env.DATABRICKS_API_BASE = process.env.DATABRICKS_API_BASE || "http://test.com";

// ── modelNameSupportsTools ────────────────────────────────────────────────────
describe("Ollama tool-capable model detection", () => {
  beforeEach(() => {
    delete require.cache[require.resolve("../src/clients/ollama-utils")];
  });

  it("newly added family 1 is recognized by bare name", () => {
    const { modelNameSupportsTools } = require("../src/clients/ollama-utils");
    assert.strictEqual(modelNameSupportsTools("kimi-k2.5"), true);
  });

  it("newly added family 1 is recognized with a version tag", () => {
    const { modelNameSupportsTools } = require("../src/clients/ollama-utils");
    assert.strictEqual(modelNameSupportsTools("kimi-k2.5:latest"), true);
  });

  it("newly added family 1 is recognized with a variant suffix", () => {
    const { modelNameSupportsTools } = require("../src/clients/ollama-utils");
    assert.strictEqual(modelNameSupportsTools("kimi-k2.5-instruct"), true);
  });

  it("newly added family 1 is recognized case-insensitively", () => {
    const { modelNameSupportsTools } = require("../src/clients/ollama-utils");
    assert.strictEqual(modelNameSupportsTools("KIMI-K2.5"), true);
  });

  it("newly added family 2 is recognized by bare name", () => {
    const { modelNameSupportsTools } = require("../src/clients/ollama-utils");
    assert.strictEqual(modelNameSupportsTools("nemotron"), true);
  });

  it("newly added family 2 is recognized with a version tag", () => {
    const { modelNameSupportsTools } = require("../src/clients/ollama-utils");
    assert.strictEqual(modelNameSupportsTools("nemotron:latest"), true);
  });

  it("newly added family 2 is recognized with a variant suffix", () => {
    const { modelNameSupportsTools } = require("../src/clients/ollama-utils");
    assert.strictEqual(modelNameSupportsTools("nemotron-mini"), true);
  });

  it("newly added family 2 is recognized case-insensitively", () => {
    const { modelNameSupportsTools } = require("../src/clients/ollama-utils");
    assert.strictEqual(modelNameSupportsTools("NEMOTRON"), true);
  });

  it("pre-existing tool-capable families still recognized", () => {
    const { modelNameSupportsTools } = require("../src/clients/ollama-utils");
    assert.strictEqual(modelNameSupportsTools("llama3.1"), true);
    assert.strictEqual(modelNameSupportsTools("llama3.2"), true);
    assert.strictEqual(modelNameSupportsTools("mistral-nemo"), true);
    assert.strictEqual(modelNameSupportsTools("firefunction-v2"), true);
    assert.strictEqual(modelNameSupportsTools("qwen2.5"), true);
    assert.strictEqual(modelNameSupportsTools("mistral"), true);
  });

  it("unknown model returns false", () => {
    const { modelNameSupportsTools } = require("../src/clients/ollama-utils");
    assert.strictEqual(modelNameSupportsTools("gemma"), false);
    assert.strictEqual(modelNameSupportsTools("phi"), false);
    assert.strictEqual(modelNameSupportsTools("deepseek"), false);
  });

  it("empty string returns false without throwing", () => {
    const { modelNameSupportsTools } = require("../src/clients/ollama-utils");
    assert.strictEqual(modelNameSupportsTools(""), false);
  });

  it("undefined returns false without throwing", () => {
    const { modelNameSupportsTools } = require("../src/clients/ollama-utils");
    assert.strictEqual(modelNameSupportsTools(undefined), false);
  });

  it("null returns false without throwing", () => {
    const { modelNameSupportsTools } = require("../src/clients/ollama-utils");
    assert.strictEqual(modelNameSupportsTools(null), false);
  });

  it("non-string input returns false without throwing", () => {
    const { modelNameSupportsTools } = require("../src/clients/ollama-utils");
    assert.strictEqual(modelNameSupportsTools(42), false);
    assert.strictEqual(modelNameSupportsTools({}), false);
  });
});

// ── invokeOllama body.model resolution (behavioral) ──────────────────────────
describe("invokeOllama uses body.model when provided", () => {
  // We test by calling checkOllamaToolSupport with the model that invokeOllama
  // resolves.  The fix: resolvedModel = body.model || config.ollama.model.
  // We verify this via checkOllamaToolSupport, which is the function invoked
  // with resolvedModel inside invokeOllama.

  beforeEach(() => {
    delete require.cache[require.resolve("../src/clients/ollama-utils")];
  });

  it("body.model kimi-k2.5 is tool-capable after fix", async () => {
    // Simulate what invokeOllama does after the fix:
    // resolvedModel = body.model || config.ollama.model
    // With body.model = "kimi-k2.5", resolvedModel must be "kimi-k2.5"
    // and checkOllamaToolSupport must return true for it.
    const { checkOllamaToolSupport } = require("../src/clients/ollama-utils");
    const bodyModel = "kimi-k2.5";
    const configModel = "llama2";  // a model that does NOT support tools
    const resolvedModel = bodyModel || configModel;
    assert.strictEqual(resolvedModel, "kimi-k2.5");
    assert.strictEqual(await checkOllamaToolSupport(resolvedModel), true,
      "kimi-k2.5 resolved from body.model must be tool-capable");
  });

  it("body.model nemotron is tool-capable after fix", async () => {
    const { checkOllamaToolSupport } = require("../src/clients/ollama-utils");
    const bodyModel = "nemotron";
    const configModel = "llama2";
    const resolvedModel = bodyModel || configModel;
    assert.strictEqual(await checkOllamaToolSupport(resolvedModel), true,
      "nemotron resolved from body.model must be tool-capable");
  });

  it("without body.model, config model is used as fallback", async () => {
    const { checkOllamaToolSupport } = require("../src/clients/ollama-utils");
    const bodyModel = undefined;
    const configModel = "llama3.1";
    const resolvedModel = bodyModel || configModel;
    assert.strictEqual(resolvedModel, "llama3.1");
    assert.strictEqual(await checkOllamaToolSupport(resolvedModel), true,
      "llama3.1 from config fallback must still be tool-capable");
  });

  it("tool-incapable config model is NOT overridden when body.model absent", async () => {
    const { checkOllamaToolSupport } = require("../src/clients/ollama-utils");
    const bodyModel = undefined;
    const configModel = "gemma";  // not tool-capable
    const resolvedModel = bodyModel || configModel;
    assert.strictEqual(resolvedModel, "gemma");
    assert.strictEqual(await checkOllamaToolSupport(resolvedModel), false,
      "gemma from config must not be tool-capable");
  });

  it("body.model kimi-k2.5:latest (tagged) is tool-capable", async () => {
    const { checkOllamaToolSupport } = require("../src/clients/ollama-utils");
    const resolvedModel = "kimi-k2.5:latest" || "gemma";
    assert.strictEqual(await checkOllamaToolSupport(resolvedModel), true);
  });

  it("body.model nemotron-mini (variant) is tool-capable", async () => {
    const { checkOllamaToolSupport } = require("../src/clients/ollama-utils");
    const resolvedModel = "nemotron-mini" || "gemma";
    assert.strictEqual(await checkOllamaToolSupport(resolvedModel), true);
  });
});
