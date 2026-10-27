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
        "openai", "atlas", "llamacpp", "lmstudio", "bedrock", "zai", "vertex", "moonshot",
        "baidu",
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

  // GitHub #129 — a llama.cpp-only wizard run used to write
  // OLLAMA_EMBEDDINGS_ENDPOINT=http://localhost:11434/... into .env and then
  // demand a local `ollama` binary for a classifier that no longer runs.
  describe("buildEnvContent — local provider baselines (#129)", () => {
    const allLlamaCpp = {
      SIMPLE: { provider: "llamacpp", model: "qwen2.5-coder" },
      MEDIUM: { provider: "llamacpp", model: "qwen2.5-coder" },
      COMPLEX: { provider: "llamacpp", model: "qwen3-32b" },
      REASONING: { provider: "llamacpp", model: "qwen3-32b" },
    };

    it("omits OLLAMA_* baseline keys when no tier uses ollama", () => {
      const out = init.buildEnvContent(
        { MODEL_PROVIDER: "llamacpp", TIER_SIMPLE: "llamacpp:qwen2.5-coder", LLAMACPP_ENDPOINT: "http://10.0.0.5:8080" },
        false,
        allLlamaCpp,
      );
      assert.doesNotMatch(out, /^OLLAMA_EMBEDDINGS_ENDPOINT=/m);
      assert.doesNotMatch(out, /^OLLAMA_MODEL=/m);
      assert.doesNotMatch(out, /^LMSTUDIO_ENDPOINT=/m);
      assert.match(out, /^LLAMACPP_ENDPOINT=http:\/\/10\.0\.0\.5:8080$/m);
      assert.match(out, /^LLAMACPP_EMBEDDINGS_ENDPOINT=/m);
    });

    it("keeps OLLAMA_* baseline keys when a tier uses ollama", () => {
      const out = init.buildEnvContent(
        { MODEL_PROVIDER: "ollama", TIER_SIMPLE: "ollama:qwen2.5-coder:latest" },
        false,
        { SIMPLE: { provider: "ollama", model: "qwen2.5-coder:latest" } },
      );
      assert.match(out, /^OLLAMA_EMBEDDINGS_ENDPOINT=http:\/\/localhost:11434\/api\/embeddings$/m);
      assert.match(out, /^OLLAMA_EMBEDDINGS_MODEL=nomic-embed-text$/m);
    });

    it("always keeps keys the user supplied, even for a provider no tier uses", () => {
      const out = init.buildEnvContent(
        { MODEL_PROVIDER: "llamacpp", OLLAMA_ENDPOINT: "http://gpu-box:11434" },
        false,
        allLlamaCpp,
      );
      assert.match(out, /^OLLAMA_ENDPOINT=http:\/\/gpu-box:11434$/m);
      assert.doesNotMatch(out, /^OLLAMA_EMBEDDINGS_ENDPOINT=/m);
    });
  });

  describe("probeLocalProviders (#129)", () => {
    const http = require("http");

    it("reports a reachable llama.cpp /v1/models endpoint with its model ids", async () => {
      const server = http.createServer((req, res) => {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ object: "list", data: [{ id: "qwen2.5-coder" }, { id: "qwen3-32b" }] }));
      });
      await new Promise((r) => server.listen(0, "127.0.0.1", r));
      try {
        const base = `http://127.0.0.1:${server.address().port}`;
        const results = await init.probeLocalProviders(
          { SIMPLE: { provider: "llamacpp", model: "qwen2.5-coder" } },
          { LLAMACPP_ENDPOINT: `${base}/` },
        );
        assert.equal(results.length, 1);
        assert.equal(results[0].provider, "llamacpp");
        assert.equal(results[0].reachable, true);
        assert.equal(results[0].url, `${base}/v1/models`, "trailing slash collapsed, /v1/models appended");
        assert.deepEqual(results[0].models, ["qwen2.5-coder", "qwen3-32b"]);
      } finally {
        server.close();
      }
    });

    it("reports an unreachable endpoint without throwing", async () => {
      const results = await init.probeLocalProviders(
        { SIMPLE: { provider: "llamacpp", model: "x" } },
        { LLAMACPP_ENDPOINT: "http://127.0.0.1:1" },
        { timeoutMs: 2000 },
      );
      assert.equal(results[0].reachable, false);
      assert.equal(typeof results[0].error, "string");
      assert.ok(results[0].error.length > 0);
    });

    it("probes each distinct local provider once and skips cloud providers", async () => {
      const urls = [];
      const fetchFn = async (url) => { urls.push(url); return { ok: true, status: 200, json: async () => ({ data: [] }) }; };
      const results = await init.probeLocalProviders(
        {
          SIMPLE: { provider: "llamacpp", model: "a" },
          MEDIUM: { provider: "llamacpp", model: "b" },
          COMPLEX: { provider: "openrouter", model: "c" },
          REASONING: { provider: "ollama", model: "d" },
        },
        { LLAMACPP_ENDPOINT: "http://llama:8080", OLLAMA_ENDPOINT: "http://gpu:11434" },
        { fetchFn },
      );
      assert.deepEqual(results.map((r) => r.provider).sort(), ["llamacpp", "ollama"]);
      assert.deepEqual(urls.sort(), ["http://gpu:11434/api/tags", "http://llama:8080/v1/models"]);
    });

    it("resolves to [] when every tier is a cloud provider", async () => {
      const results = await init.probeLocalProviders(
        { SIMPLE: { provider: "openrouter", model: "x" } },
        {},
        { fetchFn: async () => { throw new Error("must not be called"); } },
      );
      assert.deepEqual(results, []);
    });

    it("reads Ollama's /api/tags model names and treats :latest as the same model", () => {
      const logs = []; const warns = [];
      init.reportLocalProbes(
        [{ provider: "ollama", url: "http://gpu:11434/api/tags", reachable: true, models: ["qwen2.5-coder:latest"] }],
        { SIMPLE: { provider: "ollama", model: "qwen2.5-coder" }, MEDIUM: { provider: "ollama", model: "qwen3-32b" } },
        (m) => logs.push(m), (m) => warns.push(m),
      );
      assert.equal(logs.length, 1);
      assert.match(logs[0], /reachable at http:\/\/gpu:11434\/api\/tags/);
      assert.equal(warns.length, 1);
      assert.match(warns[0], /qwen3-32b/);
      assert.doesNotMatch(warns[0], /qwen2\.5-coder/);
    });

    it("never mentions installing Ollama for an unreachable llama.cpp endpoint", () => {
      const warns = [];
      init.reportLocalProbes(
        [{ provider: "llamacpp", url: "http://10.0.0.5:8080/v1/models", reachable: false, models: [], error: "ECONNREFUSED" }],
        { SIMPLE: { provider: "llamacpp", model: "x" } },
        () => {}, (m) => warns.push(m),
      );
      assert.ok(warns.length >= 1);
      assert.match(warns[0], /llama\.cpp .* not reachable at http:\/\/10\.0\.0\.5:8080\/v1\/models/);
      assert.doesNotMatch(warns.join("\n"), /ollama/i);
    });
  });
});
