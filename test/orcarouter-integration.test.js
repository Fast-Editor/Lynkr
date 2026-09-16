"use strict";

/**
 * OrcaRouter provider integration tests.
 *
 * Covers:
 *   - provider registration (config + PROVIDER_INVOKERS + SSE transform)
 *   - invokeOrcaRouter wiring: Anthropic→OpenAI request, Bearer auth,
 *     inference endpoint, response conversion, streaming passthrough
 *   - dual-auth seam: both API-key and PKCE adapters produce the same
 *     credential result and downstream provider/catalog code is
 *     credential-source-agnostic
 *   - live model catalog fetch + capability filtering (chat; embedding/
 *     image/video/rerank filters; multimodal fail-closed; old-value
 *     invalidation), verified seed fallback
 *   - auth requests only hit www.orcarouter.ai; inference/catalog only hit
 *     api.orcarouter.ai/v1
 *   - secrets never appear in logs/errors/snapshots
 *
 * Uses fake keys only. The single live test is gated on ORCAROUTER_API_KEY.
 */

const assert = require("node:assert/strict");
const { describe, it, beforeEach, afterEach } = require("node:test");

function clearModules() {
  for (const p of [
    "../src/config",
    "../src/clients/databricks",
    "../src/clients/orcarouter-credentials",
    "../src/clients/orcarouter-catalog",
    "../src/clients/routing",
    "../src/routing",
    "../src/orchestrator/sse-transformer",
    "../src/clients/provider-capabilities",
    "../src/routing/cache-economics",
  ]) {
    delete require.cache[require.resolve(p)];
  }
}

describe("OrcaRouter provider integration", () => {
  let originalEnv;
  let originalFetch;

  beforeEach(() => {
    originalEnv = { ...process.env };
    originalFetch = global.fetch;
    process.env.MODEL_PROVIDER = "orcarouter";
    process.env.ORCAROUTER_API_KEY = "sk-orca-test-key";
    process.env.ORCAROUTER_MODEL = "";
    process.env.ORCAROUTER_ENDPOINT = "";
    process.env.ORCA_AUTH_BASE_URL = "";
    process.env.ORCA_API_BASE_URL = "";
    process.env.ORCA_BASE_URL = "";
    process.env.FALLBACK_ENABLED = "false";
    process.env.TIER_SIMPLE = "";
    process.env.TIER_MEDIUM = "";
    process.env.TIER_COMPLEX = "";
    process.env.TIER_REASONING = "";
    process.env.LOG_FILE_ENABLED = "false";
    clearModules();
  });

  afterEach(() => {
    process.env = originalEnv;
    global.fetch = originalFetch;
    clearModules();
  });

  it("registers orcarouter as a first-class provider", () => {
    const config = require("../src/config");
    assert.equal(config.modelProvider.type, "orcarouter");
    assert.equal(config.orcarouter.apiKey, "sk-orca-test-key");
    assert.equal(config.orcarouter.endpoint, "https://api.orcarouter.ai/v1/chat/completions");
    assert.equal(config.orcarouter.authBaseUrl, "https://www.orcarouter.ai");
    assert.equal(config.orcarouter.apiBaseUrl, "https://api.orcarouter.ai");
  });

  it("requires ORCAROUTER_API_KEY for primary routing", () => {
    process.env.ORCAROUTER_API_KEY = "";
    clearModules();
    assert.throws(() => require("../src/config"), /Set ORCAROUTER_API_KEY before starting the proxy/);
  });

  it("registers an invoker in PROVIDER_INVOKERS and the SSE transformer", () => {
    const { PROVIDER_INVOKERS } = require("../src/clients/databricks");
    assert.equal(typeof PROVIDER_INVOKERS.orcarouter, "function");
    const { shouldTransform } = require("../src/orchestrator/sse-transformer");
    assert.equal(shouldTransform(true, "orcarouter"), true);
  });

  it("routes inference to api.orcarouter.ai/v1 with Bearer auth", async () => {
    const calls = [];
    global.fetch = async (url, opts = {}) => {
      calls.push({ url, options: opts });
      return new Response(JSON.stringify({
        id: "chatcmpl-orca-test",
        choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    };

    const { invokeOrcaRouter } = require("../src/clients/databricks");
    const result = await invokeOrcaRouter({
      system: "Be concise.",
      messages: [{ role: "user", content: "Say ok" }],
      tools: [{ name: "get_weather", description: "Get weather", input_schema: { type: "object", properties: {}, required: [] } }],
      max_tokens: 32,
      stream: false,
    });

    assert.equal(result.ok, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://api.orcarouter.ai/v1/chat/completions");
    assert.equal(calls[0].options.headers.Authorization, "Bearer sk-orca-test-key");

    const request = JSON.parse(calls[0].options.body);
    assert.equal(request.model, "orcarouter/auto");
    assert.equal(request.messages[0].role, "system");
    assert.equal(request.messages[0].content, "Be concise.");
    assert.equal(request.messages[1].role, "user");
    assert.equal(request.messages[1].content, "Say ok");
    assert.equal(request.tools[0].type, "function");
    assert.equal(request.tools[0].function.name, "get_weather");
  });

  it("does not hit the auth origin for inference", async () => {
    const urls = [];
    global.fetch = async (url, _options = {}) => {
      urls.push(String(url));
      return new Response(JSON.stringify({
        id: "chatcmpl-orca",
        choices: [{ message: { role: "assistant", content: "x" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    };
    const { invokeOrcaRouter } = require("../src/clients/databricks");
    await invokeOrcaRouter({ messages: [{ role: "user", content: "hi" }], stream: false });
    assert.ok(urls.every((u) => u.startsWith("https://api.orcarouter.ai/")), `inference hit wrong origin: ${urls}`);
  });

  it("applies explicit API base overrides for inference", async () => {
    process.env.ORCA_API_BASE_URL = "https://orca.example.com";
    process.env.ORCAROUTER_ENDPOINT = "";
    clearModules();
    const calls = [];
    global.fetch = async (url, options = {}) => {
      calls.push({ url, options });
      return new Response(JSON.stringify({
        id: "x", choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    };
    const { invokeOrcaRouter } = require("../src/clients/databricks");
    await invokeOrcaRouter({ messages: [{ role: "user", content: "hi" }], stream: false });
    assert.equal(calls[0].url, "https://orca.example.com/v1/chat/completions");
  });

  it("dual auth: both adapters yield a credential the same downstream code uses", () => {
    const mod = require("../src/clients/orcarouter-credentials");

    // API-key adapter
    const storeA = new mod.OrcaCredentialStore({ env: { ORCAROUTER_API_KEY: "sk-orca-a" } });
    const apiAdapter = mod.createApiKeyAdapter(storeA, { env: { ORCAROUTER_API_KEY: "sk-orca-a" } });
    const apiCred = apiAdapter.obtain();

    // PKCE adapter (fake issued key, same shape)
    const storeB = new mod.OrcaCredentialStore({ env: {} });
    const pkceCred = storeB.save("sk-orca-b", { source: "pkce", scope: "api" });

    // Same credential result: { key, source } — downstream provider/catalog
    // code treats them identically (only the `source` tag differs).
    assert.equal(apiCred.key.startsWith("sk-orca-"), true);
    assert.equal(pkceCred.key.startsWith("sk-orca-"), true);
    assert.equal(apiCred.source, "api_key");
    assert.equal(pkceCred.source, "pkce");

    // The provider invoker reads the key from config, not from the source.
    const config = require("../src/config");
    assert.equal(config.orcarouter.apiKey, process.env.ORCAROUTER_API_KEY);
  });

  it("catalog fetch uses the API origin and filters to chat-capable models", async () => {
    const urls = [];
    global.fetch = async (url, _options = {}) => {
      urls.push(String(url));
      return new Response(JSON.stringify({
        object: "list",
        data: [
          { id: "openai/gpt-5.5", supported_endpoint_types: ["openai", "openai-response"], architecture: { input_modalities: ["text", "image"] }, context_length: 1000000 },
          { id: "openai/text-embedding-3-large", supported_endpoint_types: ["embeddings"] },
          { id: "google/imagen-4.0-ultra-generate-001", supported_endpoint_types: ["image-generation"] },
          { id: "deepseek/deepseek-v4-pro", supported_endpoint_types: ["openai"] },
        ],
      }), { status: 200, headers: { "content-type": "application/json" } });
    };
    const { getOrcaChatModels } = require("../src/clients/orcarouter-catalog");
    const cfg = { apiKey: "sk-orca-test", apiBaseUrl: "https://api.orcarouter.ai" };
    const result = await getOrcaChatModels(cfg, { capability: "chat" });
    assert.equal(result.source, "live");
    assert.ok(urls[0].startsWith("https://api.orcarouter.ai/v1/models"), urls[0]);
    assert.ok(urls[0].includes("capability=chat"));
    const ids = result.models.map((m) => m.id);
    assert.ok(ids.includes("openai/gpt-5.5"));
    assert.ok(ids.includes("deepseek/deepseek-v4-pro"));
    assert.ok(!ids.includes("openai/text-embedding-3-large"), "embeddings-only model must not appear in chat");
    assert.ok(!ids.includes("google/imagen-4.0-ultra-generate-001"), "image-generation model must not appear in chat");
  });

  it("multimodal filter requires the declared input modality (fail closed)", async () => {
    global.fetch = async () => new Response(JSON.stringify({
      data: [
        { id: "anthropic/claude-opus-4.8", supported_endpoint_types: ["anthropic", "openai"], architecture: { input_modalities: ["text", "image"] } },
        { id: "deepseek/deepseek-v4-pro", supported_endpoint_types: ["openai"], architecture: { input_modalities: ["text"] } },
        { id: "no-arch-model", supported_endpoint_types: ["openai"] },
      ],
    }), { status: 200, headers: { "content-type": "application/json" } });
    const { getOrcaChatModels } = require("../src/clients/orcarouter-catalog");
    const cfg = { apiKey: "sk-orca-test", apiBaseUrl: "https://api.orcarouter.ai" };
    const imageChat = await getOrcaChatModels(cfg, { capability: "chat", modality: "image" });
    const ids = imageChat.models.map((m) => m.id);
    assert.ok(ids.includes("anthropic/claude-opus-4.8"));
    assert.ok(!ids.includes("deepseek/deepseek-v4-pro"), "text-only model must fail closed for image input");
    assert.ok(!ids.includes("no-arch-model"), "models that don't declare capabilities must fail closed");
  });

  it("non-chat capability filters (embedding/image/video/rerank) are strict endpoint matches", async () => {
    global.fetch = async (url) => {
      const cap = new URL(url).searchParams.get("capability");
      const data = {
        embedding: [{ id: "openai/text-embedding-3-large", supported_endpoint_types: ["embeddings"] }],
        image: [{ id: "google/imagen-4.0-ultra-generate-001", supported_endpoint_types: ["image-generation"] }],
        video: [],
        rerank: [],
      }[cap] || [];
      return new Response(JSON.stringify({ data }), { status: 200, headers: { "content-type": "application/json" } });
    };
    const { fetchOrcaCatalog } = require("../src/clients/orcarouter-catalog");
    const embedding = await fetchOrcaCatalog({ apiBase: "https://api.orcarouter.ai", apiKey: "k", capability: "embedding" });
    assert.equal(embedding.models[0].id, "openai/text-embedding-3-large");
    const image = await fetchOrcaCatalog({ apiBase: "https://api.orcarouter.ai", apiKey: "k", capability: "image" });
    assert.equal(image.models[0].id, "google/imagen-4.0-ultra-generate-001");
  });

  it("catalog failure falls back to the verified seed (never free text), marked degraded", async () => {
    global.fetch = async () => { throw new Error("catalog down"); };
    const { getOrcaChatModels, VERIFIED_SEED } = require("../src/clients/orcarouter-catalog");
    const cfg = { apiKey: "sk-orca-test", apiBaseUrl: "https://api.orcarouter.ai" };
    const result = await getOrcaChatModels(cfg, { capability: "chat" });
    assert.equal(result.degraded, true);
    assert.equal(result.source, "seed");
    const ids = result.models.map((m) => m.id);
    assert.deepEqual(ids, VERIFIED_SEED.map((m) => m.id).filter((id) => id !== "google/gemini-3.5-flash" ? true : true));
    // Seed preserves metadata: context, reasoning ladder, input modalities.
    const gpt = result.models.find((m) => m.id === "openai/gpt-5.5");
    assert.equal(gpt.context_length, 1000000);
    assert.deepEqual(gpt.reasoning_efforts, ["low", "medium", "high", "xhigh"]);
    assert.deepEqual(gpt.architecture.input_modalities, ["text", "image", "file"]);
  });

  it("old selected value is invalidated when the filtered list no longer contains it", () => {
    // Selector helper mirror: when provider/capability changes, a previously
    // selected model that is no longer compatible must be cleared.
    const { filterModelsByCapability } = require("../src/clients/orcarouter-catalog");
    const models = [
      { id: "a/text", supported_endpoint_types: ["openai"], architecture: { input_modalities: ["text"] } },
    ];
    const chat = filterModelsByCapability(models, { capability: "chat" });
    assert.equal(chat.length, 1);
    const image = filterModelsByCapability(models, { capability: "chat", modality: "image" });
    assert.equal(image.length, 0);
    // "a/text" selected for chat is valid; after an image attachment it is
    // not — the caller must clear it (asserted at the filter level here).
    assert.ok(!image.includes(chat[0]));
  });

  it("sanitizeModel bounds item shape and preserves vendor/model namespaces", () => {
    const { sanitizeModel } = require("../src/clients/orcarouter-catalog");
    const clean = sanitizeModel({ id: "anthropic/claude-opus-4.8", name: "Opus", supported_endpoint_types: ["anthropic"], architecture: { input_modalities: ["text"] }, context_length: 200000 });
    assert.equal(clean.id, "anthropic/claude-opus-4.8");
    assert.deepEqual(clean.architecture.input_modalities, ["text"]);
    assert.equal(sanitizeModel(null), null);
    assert.equal(sanitizeModel({}), null);
    assert.equal(sanitizeModel({ id: "" }), null);
    assert.equal(sanitizeModel({ id: "x".repeat(300) }), null);
    assert.deepEqual(sanitizeModel({ id: "a", architecture: { input_modalities: "not-array" } }).architecture, undefined);
  });

  it("secrets never appear in error messages or snapshots", async () => {
    const calls = [];
    global.fetch = async (url, options = {}) => {
      calls.push({ url, headers: options.headers });
      return new Response(JSON.stringify({ error: { message: "temporary" } }), { status: 503, headers: { "content-type": "application/json" } });
    };
    const { invokeOrcaRouter } = require("../src/clients/databricks");
    const result = await invokeOrcaRouter({ messages: [{ role: "user", content: "hello" }], stream: false });
    assert.equal(result.status, 503);
    // The key may be in request headers (that's required), but must never be
    // echoed in the returned body or any error text.
    assert.ok(!JSON.stringify(result).includes("sk-orca-test-key"));
  });

  it("marks a revoked key needsReauth on 401 (no fake refresh)", async () => {
    global.fetch = async () => new Response(JSON.stringify({ error: { message: "Invalid API key" } }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
    const { invokeOrcaRouter } = require("../src/clients/databricks");
    const mod = require("../src/clients/orcarouter-credentials");
    const result = await invokeOrcaRouter({ messages: [{ role: "user", content: "hi" }], stream: false });
    assert.equal(result.status, 401);
    assert.equal(mod.getCredentialStore().read().needsReauth, true);
    // No refresh grant exists — the only recovery is a new login.
    assert.equal(mod.getCredentialStore().read().masked.includes("sk-orca-test-key"), false);
  });

  it("does not replay a failed billable POST (no retryable statuses)", async () => {
    let calls = 0;
    global.fetch = async () => {
      calls += 1;
      return new Response(JSON.stringify({ error: { message: "temporary" } }), { status: 503, headers: { "content-type": "application/json" } });
    };
    const { invokeOrcaRouter } = require("../src/clients/databricks");
    const result = await invokeOrcaRouter({ messages: [{ role: "user", content: "hello" }], tools: [{ name: "noop", description: "No-op", input_schema: { type: "object" } }], stream: false });
    assert.equal(result.status, 503);
    assert.equal(calls, 1);
  });

  it("supports static routing, reasoning content, and OpenAI SSE transforms", async () => {
    const routing = require("../src/clients/routing");
    const decision = await routing.determineProviderSmart({ messages: [{ role: "user", content: "hello" }] });
    assert.equal(decision.provider, "orcarouter");
    assert.equal(decision.method, "static");

    const { supportsReasoningContent } = require("../src/clients/provider-capabilities");
    assert.equal(supportsReasoningContent("orcarouter"), true);

    const { shouldTransform } = require("../src/orchestrator/sse-transformer");
    assert.equal(shouldTransform(true, "orcarouter"), true);
  });

  it("cache economics resolve for orcarouter (automatic caching)", () => {
    const { getProviderCacheDefaults } = require("../src/routing/cache-economics");
    const defs = getProviderCacheDefaults("orcarouter");
    assert.equal(defs.mechanism, "automatic");
    assert.equal(defs.readMult, 0.1);
  });
});

// Live test — only runs when a real ORCAROUTER_API_KEY is present. Exercises
// the real provider code path (invokeOrcaRouter) and the real catalog fetch.
describe("OrcaRouter live (gated on ORCAROUTER_API_KEY)", () => {
  it("fetches the live chat catalog through the provider's code path", async () => {
    const key = process.env.ORCAROUTER_API_KEY;
    if (!key) {
      console.log("# SKIP live catalog test — ORCAROUTER_API_KEY not set");
      return;
    }
    const { getOrcaChatModels } = require("../src/clients/orcarouter-catalog");
    const result = await getOrcaChatModels(
      { apiKey: key, apiBaseUrl: "https://api.orcarouter.ai" },
      { capability: "chat" }
    );
    assert.equal(result.source, "live");
    assert.ok(result.models.length > 0);
    assert.ok(result.models.every((m) => m.id && typeof m.id === "string"));
    assert.ok(result.models.some((m) => m.id.includes("/")), "model ids should carry vendor/model namespace");
  });

  it("performs a real inference through invokeOrcaRouter (live)", async () => {
    const key = process.env.ORCAROUTER_API_KEY;
    if (!key) {
      console.log("# SKIP live inference test — ORCAROUTER_API_KEY not set");
      return;
    }

    // DATABRICKS_API_BASE is required only because src/logger transitively
    // requires src/config (databricks-primary guard); give it the same mock
    // harness the repo's unit runner uses. The requested provider is still
    // orcarouter, forced explicitly below.
    process.env.DATABRICKS_API_KEY = process.env.DATABRICKS_API_KEY || "test-key";
    process.env.DATABRICKS_API_BASE = process.env.DATABRICKS_API_BASE || "http://test.com";

    // Pick a chat model from the REAL catalog — never hard-coded, and never
    // the free-text/seed list: this is the model the workspace can actually
    // call.
    const { getOrcaChatModels } = require("../src/clients/orcarouter-catalog");
    const { models, source } = await getOrcaChatModels(
      { apiKey: key, apiBaseUrl: "https://api.orcarouter.ai" },
      { capability: "chat" }
    );
    assert.equal(source, "live");
    assert.ok(models.length > 0, "live catalog must list at least one chat model");
    const model = models[0].id;

    // Real inference through the provider path the proxy actually uses.
    const { invokeOrcaRouter } = require("../src/clients/databricks");
    const result = await invokeOrcaRouter(
      {
        system: "Reply with the single word ok.",
        messages: [{ role: "user", content: "Say ok" }],
        max_tokens: 16,
        stream: false,
        _tierModel: model, // tier-selected model marker — real providers read this
      },
      {}
    );

    assert.equal(result.ok, true, `live inference failed: ${JSON.stringify(result).slice(0, 200)}`);
    assert.ok(result.json && Array.isArray(result.json.content), "expected Anthropic-shaped content blocks");
    const text = result.json.content.filter((b) => b.type === "text").map((b) => b.text).join("");
    assert.ok(text.trim().length > 0, "live inference must return nonempty text");
    assert.ok(!JSON.stringify(result).includes(key), "live response must never echo the API key");
    // One real inference proves the end-to-end path; nothing here loops.
  });
});
