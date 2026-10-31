/**
 * Optional API-key gate for Lynkr's own HTTP surface.
 *
 * When `LYNKR_API_KEY` is set (config.apiKey), every request under /v1/*, /routing/*, /metrics*
 * and /dashboard/api/* must present that key as `x-api-key: <key>`, `api-key: <key>` or
 * `Authorization: Bearer <key>`. Health probes stay open. When no key is configured the
 * middleware is a no-op, so existing deployments behave exactly as before.
 *
 * Why all three header forms: Anthropic-style clients send x-api-key, Azure-style clients send
 * api-key, OpenAI-style clients send a bearer. A client may legitimately carry an *upstream*
 * OAuth bearer (subscription passthrough, see src/auth-mode.js) alongside the Lynkr key in
 * x-api-key — any one matching credential is enough, the others are left untouched for the
 * downstream auth-mode logic.
 */
const crypto = require("node:crypto");

const PROTECTED = [/^\/v1(\/|$)/, /^\/routing(\/|$)/, /^\/metrics(\/|$)/, /^\/dashboard\/api(\/|$)/];
const EXEMPT = new Set(["/health", "/health/live", "/health/ready"]);
const OPENAI_SURFACE = [/^\/v1\/chat\/completions/, /^\/v1\/responses/, /^\/v1\/embeddings/];

/** Constant-time string comparison (length leak only). */
function safeEqual(a, b) {
  const ab = Buffer.from(String(a ?? ""), "utf8");
  const bb = Buffer.from(String(b ?? ""), "utf8");
  if (ab.length === 0 || ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

/** Every credential the request presents, in header order of preference. */
function presentedKeys(headers = {}) {
  const out = [];
  const get = (name) => {
    const v = headers[name] ?? headers[name.toLowerCase()];
    return Array.isArray(v) ? v[0] : v;
  };
  const xApiKey = get("x-api-key");
  if (xApiKey) out.push(String(xApiKey).trim());
  const apiKey = get("api-key");
  if (apiKey) out.push(String(apiKey).trim());
  const auth = get("authorization");
  if (auth && /^Bearer\s+/i.test(auth)) out.push(String(auth).replace(/^Bearer\s+/i, "").trim());
  return out;
}

function isProtected(path) {
  const p = String(path || "/").split("?")[0];
  if (EXEMPT.has(p)) return false;
  return PROTECTED.some((re) => re.test(p));
}

function isOpenAiSurface(path) {
  const p = String(path || "/").split("?")[0];
  return OPENAI_SURFACE.some((re) => re.test(p));
}

/**
 * @param {string|null|(() => string|null)} keyOrGetter configured key, or a getter so hot-reloaded
 *   values (config.apiKey) are honoured without re-mounting.
 */
function createApiKeyAuth(keyOrGetter) {
  const getKey = typeof keyOrGetter === "function" ? keyOrGetter : () => keyOrGetter;
  return function apiKeyAuth(req, res, next) {
    const key = getKey();
    if (!key) return next();
    const path = req.path || req.url;
    if (!isProtected(path)) return next();
    if (presentedKeys(req.headers).some((k) => safeEqual(k, key))) return next();
    res.status(401);
    res.set("WWW-Authenticate", 'Bearer realm="lynkr"');
    if (isOpenAiSurface(path)) {
      return res.json({ error: { message: "invalid or missing API key", type: "invalid_request_error", code: "invalid_api_key" } });
    }
    return res.json({ type: "error", error: { type: "authentication_error", message: "invalid or missing API key" } });
  };
}

module.exports = { createApiKeyAuth, isProtected, isOpenAiSurface, presentedKeys, safeEqual };
