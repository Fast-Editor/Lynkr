"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const init = require("../bin/lynkr-init.js");

describe("lynkr init", () => {
  describe("parseArgs", () => {
    it("recognises --help", () => {
      assert.equal(init.parseArgs(["--help"]).help, true);
      assert.equal(init.parseArgs(["-h"]).help, true);
    });

    it("recognises --force / -f", () => {
      assert.equal(init.parseArgs(["--force"]).force, true);
      assert.equal(init.parseArgs(["-f"]).force, true);
    });

    it("recognises --dry-run", () => {
      assert.equal(init.parseArgs(["--dry-run"]).dryRun, true);
    });

    it("accepts --output in both forms", () => {
      assert.equal(init.parseArgs(["--output=/tmp/x"]).output, "/tmp/x");
      assert.equal(init.parseArgs(["--output", "/tmp/y"]).output, "/tmp/y");
      assert.equal(init.parseArgs(["-o", "/tmp/z"]).output, "/tmp/z");
    });

    it("defaults are sane for an empty arg list", () => {
      const o = init.parseArgs([]);
      assert.equal(o.help, false);
      assert.equal(o.force, false);
      assert.equal(o.dryRun, false);
      assert.equal(o.output, null);
    });
  });

  describe("PROVIDERS schema", () => {
    it("covers every SUPPORTED_MODEL_PROVIDERS entry", () => {
      // Mirror of src/config/index.js SUPPORTED_MODEL_PROVIDERS — kept in sync
      // intentionally as a guard: if a new provider lands without being added
      // to the wizard, this test fails loudly.
      const supported = [
        "databricks", "azure-anthropic", "ollama", "openrouter", "azure-openai",
        "openai", "llamacpp", "lmstudio", "bedrock", "zai", "vertex", "moonshot",
      ];
      for (const key of supported) {
        assert.ok(init.PROVIDERS[key], `wizard missing provider entry for ${key}`);
        assert.ok(init.PROVIDERS[key].label, `${key} needs a human label`);
        assert.ok(init.PROVIDERS[key].defaultModel, `${key} needs a defaultModel`);
        assert.ok(Array.isArray(init.PROVIDERS[key].creds), `${key} creds must be an array`);
      }
    });

    it("PROVIDER_ORDER puts local providers first", () => {
      const localKeys = init.PROVIDER_ORDER.filter((k) => init.PROVIDERS[k].local);
      const cloudKeys = init.PROVIDER_ORDER.filter((k) => !init.PROVIDERS[k].local);
      const lastLocalIdx = Math.max(...localKeys.map((k) => init.PROVIDER_ORDER.indexOf(k)));
      const firstCloudIdx = Math.min(...cloudKeys.map((k) => init.PROVIDER_ORDER.indexOf(k)));
      assert.ok(lastLocalIdx < firstCloudIdx, "local providers should be listed before cloud ones");
    });
  });

  describe("TIERS", () => {
    it("exposes the canonical tier order", () => {
      assert.deepEqual(init.TIERS, ["SIMPLE", "MEDIUM", "COMPLEX", "REASONING"]);
    });
  });

  describe("buildEnvContent", () => {
    it("renders a header, the configured keys, and ends with a trailing newline", () => {
      const env = {
        MODEL_PROVIDER: "ollama",
        TIER_SIMPLE: "ollama:qwen2.5-coder:latest",
        OLLAMA_ENDPOINT: "http://localhost:11434",
        LYNKR_VISIBLE_ROUTING: "true",
        LOG_LEVEL: "info",
      };
      const out = init.buildEnvContent(env, /*isWrap*/ false, {});
      assert.match(out, /^# Lynkr configuration/);
      assert.match(out, /Mode: direct API/);
      assert.match(out, /^MODEL_PROVIDER=ollama$/m);
      assert.match(out, /^TIER_SIMPLE=ollama:qwen2\.5-coder:latest$/m);
      assert.match(out, /^OLLAMA_ENDPOINT=http:\/\/localhost:11434$/m);
      assert.match(out, /^LYNKR_VISIBLE_ROUTING=true$/m);
      assert.ok(out.endsWith("\n"));
    });

    it("groups tier keys, credential keys, and LYNKR_* keys into sections", () => {
      const env = {
        MODEL_PROVIDER: "openrouter",
        TIER_SIMPLE: "openrouter:openai/gpt-4o-mini",
        OPENROUTER_API_KEY: "sk-or-XXX",
        LYNKR_INTENT_WINDOW_N: "5",
        LOG_LEVEL: "info",
      };
      const out = init.buildEnvContent(env, /*isWrap*/ false, {});
      assert.match(out, /# Tier routing[\s\S]*MODEL_PROVIDER=/);
      assert.match(out, /# Provider credentials[\s\S]*OPENROUTER_API_KEY=/);
      assert.match(out, /# Routing intelligence[\s\S]*LYNKR_INTENT_WINDOW_N=/);
      assert.match(out, /# Logging[\s\S]*LOG_LEVEL=info/);
    });

    it("emits wrap mode in the header banner", () => {
      const out = init.buildEnvContent({ MODEL_PROVIDER: "ollama" }, /*isWrap*/ true, {});
      assert.match(out, /Mode: wrap \(Claude Pro\/Max subscription\)/);
    });
  });
});
