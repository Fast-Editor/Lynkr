/**
 * OrcaRouter model catalog discovery and capability filtering.
 *
 * OrcaRouter serves a single OpenAI-compatible endpoint
 * (https://api.orcarouter.ai/v1) whose `/models` listing is the authoritative
 * source for the models an account can actually call. Live discovery uses the
 * account's own API key so the list reflects the workspace's real serving
 * set, and every model carries metadata (supported_endpoint_types,
 * architecture.input_modalities, context_length, max_completion_tokens,
 * pricing) that the repository's static provider lists cannot provide.
 *
 * Capability filters map an AI entry point to a compatible subset:
 *   - chat            : ?capability=chat + supported_endpoint_types includes
 *                       at least one of openai / anthropic / gemini /
 *                       openai-response; image-generation / openai-video /
 *                       jina-rerank / embeddings-only models are excluded.
 *   - multimodal chat : chat ∩ architecture.input_modalities includes the
 *                       actual non-text modality (image / audio / video).
 *                       Models that do not declare capabilities fail closed
 *                       (never mixed into a multimodal list).
 *   - embedding       : ?capability=embedding / strict `embeddings` endpoint.
 *   - image generation: ?capability=image / strict `image-generation`.
 *   - video generation: strict `openai-video`.
 *   - rerank          : strict `jina-rerank`.
 *
 * Bounds: request timeout, max items, accepted item shape and whitelisted
 * endpoint types are all capped so a catalog response cannot consume
 * unbounded memory or advertise routes this client cannot speak.
 *
 * Failure handling: when live discovery fails, callers fall back to a small
 * verified seed (see VERIFIED_SEED below) that preserves metadata (context,
 * input modalities, reasoning-effort ladders). Live results are authoritative
 * and are never mixed with the seed.
 *
 * @module clients/orcarouter-catalog
 */

const logger = require("../logger");

// Live discovery bounds. The catalog is exposed through the repository's
// own /v1/models and /v1/providers handlers, so keep it memory-bounded.
const CATALOG_TIMEOUT_MS = 15000;
const CATALOG_MAX_ITEMS = 5000;

// Endpoint types this client can actually speak (OpenAI chat-completions wire
// format through the shared openrouter-utils converters). Any model that only
// advertises other endpoint types is filtered out — a model that the client
// cannot call must never appear in a chat dropdown.
const CHAT_ENDPOINT_TYPES = new Set(["openai", "openai-response", "anthropic", "gemini"]);

// Capability→endpoint-type matches for non-chat entry points.
const CAPABILITY_ENDPOINTS = {
  embedding: new Set(["embeddings"]),
  image: new Set(["image-generation"]),
  video: new Set(["openai-video"]),
  rerank: new Set(["jina-rerank"]),
};

/**
 * Small verified fallback seed, used ONLY when live discovery is unavailable
 * (cold start, catalog outage). Each entry preserves the metadata this
 * repository already consumes elsewhere: context length, input modalities,
 * and the verified reasoning-effort ladder for openai/gpt-5.5 (low/medium/
 * high/xhigh — see the routing/model-slots notes on Codex effort enums).
 * Live discovery success is authoritative and never merged with this list.
 */
const VERIFIED_SEED = [
  {
    id: "openai/gpt-5.5",
    name: "OpenAI: GPT-5.5",
    context_length: 1000000,
    max_completion_tokens: 128000,
    supported_endpoint_types: ["openai", "openai-response"],
    architecture: { input_modalities: ["text", "image", "file"], output_modalities: ["text"] },
    reasoning_efforts: ["low", "medium", "high", "xhigh"],
    seed: true,
  },
  {
    id: "anthropic/claude-opus-4.8",
    name: "Anthropic: Claude Opus 4.8",
    context_length: 200000,
    supported_endpoint_types: ["anthropic", "openai"],
    architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] },
    reasoning_efforts: ["low", "medium", "high", "xhigh"],
    seed: true,
  },
  {
    id: "google/gemini-3.5-flash",
    name: "Google: Gemini 3.5 Flash",
    context_length: 1000000,
    supported_endpoint_types: ["gemini", "openai", "openai-response"],
    architecture: { input_modalities: ["text", "image", "audio", "video"], output_modalities: ["text"] },
    reasoning_efforts: ["low", "medium", "high"],
    seed: true,
  },
  {
    id: "deepseek/deepseek-v4-pro",
    name: "DeepSeek: DeepSeek V4 Pro",
    context_length: 128000,
    supported_endpoint_types: ["openai"],
    architecture: { input_modalities: ["text"], output_modalities: ["text"] },
    reasoning_efforts: ["low", "medium", "high"],
    seed: true,
  },
  {
    id: "orcarouter/auto",
    name: "OrcaRouter: Auto (adaptive routing)",
    context_length: 1000000,
    supported_endpoint_types: ["openai", "openai-response", "anthropic", "gemini"],
    architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] },
    seed: true,
  },
];

// Cache last-known-good live catalog so a momentary outage doesn't blank the
// dropdown. Keyed by API base + credential fingerprint + capability: model
// visibility depends on the account, so a failed fetch after rotation must
// never serve the previous account's models.
let lastKnownGood = new Map(); // cacheKey -> { models, fetchedAt }

function fingerprintKey(apiKey) {
  try {
    return require("crypto").createHash("sha256").update(String(apiKey || "")).digest("hex").slice(0, 16);
  } catch {
    return "nokey";
  }
}

function catalogCacheKey(apiBase, apiKey, capability) {
  const base = String(apiBase || "https://api.orcarouter.ai").replace(/\/+$/, "");
  return `${base}::${fingerprintKey(apiKey)}::${capability || "chat"}`;
}

/**
 * Build the chat-completions endpoint URL for the configured origin.
 * Rejects remote plaintext HTTP so a misconfigured base can never carry the
 * Bearer key in clear text (same HTTPS-or-loopback policy as auth origin).
 * @param {string} apiBase - e.g. https://api.orcarouter.ai
 * @returns {string} e.g. https://api.orcarouter.ai/v1/chat/completions
 */
function chatCompletionsUrl(apiBase) {
  const base = String(apiBase || "https://api.orcarouter.ai").replace(/\/+$/, "");
  try {
    require("./orcarouter-credentials").assertAllowedOrigin(base, { allowHttpLoopback: true });
  } catch (err) {
    throw new Error(`OrcaRouter API base rejected: ${err.message}`);
  }
  return `${base}/v1/chat/completions`;
}

/**
 * Fetch the live OrcaRouter model catalog for a given API base + key.
 * @param {string} apiBase
 * @param {string} apiKey
 * @param {object} [opts]
 * @param {string} [opts.capability] - chat | embedding | image | video | rerank
 * @returns {Promise<{ok:boolean, models?:Array, degraded?:boolean, reason?:string, cached?:boolean}>}
 */
async function fetchOrcaCatalog({ apiBase, apiKey, capability = "chat" }) {
  const base = String(apiBase || "https://api.orcarouter.ai").replace(/\/+$/, "");
  // Fail closed on plaintext remote bases — never send the Bearer key over HTTP.
  try {
    require("./orcarouter-credentials").assertAllowedOrigin(base, { allowHttpLoopback: true });
  } catch (err) {
    return { ok: false, reason: err.message, degraded: true };
  }
  const cacheKey = catalogCacheKey(base, apiKey, capability);
  const url = `${base}/v1/models${capability ? `?capability=${encodeURIComponent(capability)}` : ""}`;
  try {
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS),
    });
    if (!res.ok) {
      logger.warn({ status: res.status, base }, "OrcaRouter catalog fetch failed");
      return { ok: false, reason: `catalog HTTP ${res.status}`, degraded: true };
    }
    const payload = await res.json();
    const raw = Array.isArray(payload) ? payload : (payload.data || payload.models || []);
    if (!Array.isArray(raw)) {
      logger.warn({ base }, "OrcaRouter catalog response had no model array");
      return { ok: false, reason: "catalog response shape invalid", degraded: true };
    }
    const bounded = raw.slice(0, CATALOG_MAX_ITEMS);
    const models = bounded
      .map(sanitizeModel)
      .filter(Boolean);
    if (models.length === 0) {
      return { ok: false, reason: "catalog empty after sanitize", degraded: true };
    }
    lastKnownGood.set(cacheKey, { models, fetchedAt: Date.now() });
    return { ok: true, models, capability };
  } catch (err) {
    logger.debug({ err: err.message, base }, "OrcaRouter catalog fetch threw");
    const cached = lastKnownGood.get(cacheKey);
    if (cached && cached.models) {
      return { ok: true, models: cached.models, degraded: true, cached: true, reason: err.message };
    }
    return { ok: false, reason: err.message, degraded: true };
  }
}

/**
 * Accept only well-formed catalog items, preserving vendor/model namespaces
 * verbatim. Unknown fields are dropped; known fields are passed through.
 * @param {object} raw
 * @returns {object|null}
 */
function sanitizeModel(raw) {
  if (!raw || typeof raw !== "object") return null;
  const id = typeof raw.id === "string" ? raw.id.trim() : "";
  if (!id || id.length > 256) return null;
  const out = { id };
  if (typeof raw.name === "string") out.name = raw.name;
  if (typeof raw.context_length === "number") out.context_length = raw.context_length;
  if (typeof raw.max_completion_tokens === "number") out.max_completion_tokens = raw.max_completion_tokens;
  if (Array.isArray(raw.supported_endpoint_types)) {
    out.supported_endpoint_types = raw.supported_endpoint_types.filter((t) => typeof t === "string");
  }
  if (raw.architecture && typeof raw.architecture === "object") {
    const arch = {};
    if (Array.isArray(raw.architecture.input_modalities)) {
      arch.input_modalities = raw.architecture.input_modalities.filter((m) => typeof m === "string");
    }
    if (Array.isArray(raw.architecture.output_modalities)) {
      arch.output_modalities = raw.architecture.output_modalities.filter((m) => typeof m === "string");
    }
    if (Object.keys(arch).length) out.architecture = arch;
  }
  if (Array.isArray(raw.reasoning_efforts)) {
    out.reasoning_efforts = raw.reasoning_efforts.filter((m) => typeof m === "string");
  }
  if (raw.pricing && typeof raw.pricing === "object") {
    out.pricing = raw.pricing;
  }
  return out;
}

/**
 * Chat-compatible? Whitelists endpoint types this client can speak.
 * Mixed-capability models (e.g. ["openai", "embeddings"]) are chat-capable;
 * only models with NO chat endpoint (image-generation / openai-video /
 * jina-rerank / embeddings-only) are excluded.
 * @param {object} model
 * @returns {boolean}
 */
function isChatCapable(model) {
  const ep = model?.supported_endpoint_types;
  if (!Array.isArray(ep) || ep.length === 0) return false;
  // Chat-capable = speaks at least one chat wire format. Mixed-capability
  // models (e.g. ["openai", "embeddings"]) handle chat fine — do NOT exclude
  // them for also advertising image/video/rerank/embeddings endpoints.
  // (Only chat vs non-chat matters; embeddings-only etc. fail hasChat above.)
  return ep.some((t) => CHAT_ENDPOINT_TYPES.has(t));
}

/**
 * Capability filter by entry-point type. Only fields the catalog metadata can
 * actually prove are used — no guessing by model name.
 * @param {Array<object>} models
 * @param {object} req - { capability?: string, modality?: string }
 * @returns {Array<object>}
 */
function filterModelsByCapability(models, req = {}) {
  const capability = req.capability || "chat";
  const modality = req.modality || null;
  const list = Array.isArray(models) ? models : [];
  if (capability === "chat") {
    const chat = list.filter(isChatCapable);
    if (!modality || modality === "text") return chat;
    // Multimodal: require the actual non-text modality to be declared.
    return chat.filter((m) => {
      const mods = m?.architecture?.input_modalities;
      if (!Array.isArray(mods)) return false; // fail closed
      return mods.includes(modality);
    });
  }
  const endpointSet = CAPABILITY_ENDPOINTS[capability];
  if (!endpointSet) return [];
  return list.filter((m) => {
    const ep = m?.supported_endpoint_types;
    return Array.isArray(ep) && ep.some((t) => endpointSet.has(t));
  });
}

/**
 * Get a chat model list for the configured provider — live when possible,
 * otherwise verified seed / last-known-good. Used by the repository's model
 * catalog handlers so the dropdown is real catalog, never free text.
 * @param {object} cfg - config.orcarouter
 * @param {object} [opts] - { capability, modality }
 * @returns {Promise<{models:Array, source:'live'|'seed'|'cached', degraded:boolean}>}
 */
async function getOrcaChatModels(cfg, opts = {}) {
  const capability = opts.capability || "chat";
  if (cfg?.apiKey) {
    const live = await fetchOrcaCatalog({
      apiBase: cfg.apiBaseUrl,
      apiKey: cfg.apiKey,
      capability,
    });
    if (live.ok) {
      const models = filterModelsByCapability(live.models, { capability, modality: opts.modality });
      return {
        models,
        source: live.cached ? "cached" : "live",
        degraded: !!live.degraded,
      };
    }
  }
  // Verified fallback — never the free-text/example list, always metadata-rich.
  const models = filterModelsByCapability(VERIFIED_SEED, { capability, modality: opts.modality });
  return { models, source: "seed", degraded: true };
}

module.exports = {
  chatCompletionsUrl,
  fetchOrcaCatalog,
  filterModelsByCapability,
  isChatCapable,
  getOrcaChatModels,
  sanitizeModel,
  VERIFIED_SEED,
  CHAT_ENDPOINT_TYPES,
  catalogCacheKey,
  _lastKnownGood: lastKnownGood,
};
