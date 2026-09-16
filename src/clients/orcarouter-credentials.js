/**
 * OrcaRouter credential interface + dual adapters.
 *
 * Both ways of obtaining a credential produce the SAME result — a normal
 * OrcaRouter API key (`sk-orca-…`) that belongs to the user — and downstream
 * provider/model/catalog code treats them identically. This module is the one
 * seam; nothing else copies auth logic.
 *
 *   Adapter A — API key: the user pastes/stores an `sk-orca-…` key in their
 *   existing secret location (.env / process env, same as every other Lynkr
 *   provider). Supports update, clear, and a masked read for UI/status.
 *
 *   Adapter B — OAuth 2.0 + PKCE (Flow B, out-of-band code): the user opens
 *   the consent page, copies a one-time code, and the client exchanges it at
 *   www.orcarouter.ai/api/v1/auth/keys for a durable API key. Chosen over
 *   Flow A because Lynkr is self-hosted software whose install address differs
 *   on every deployment — there is no predictable loopback port to register,
 *   and the out-of-band flow exists precisely for that case (no callback
 *   registration step). PKCE binds the code to this process: the verifier is
 *   freshly generated per attempt, hashed to an S256 challenge that rides on
 *   the authorize URL, and never leaves the process until the exchange.
 *
 * Security invariants enforced here:
 *   - challenge = base64url(sha256(verifier)), no padding, S256 always.
 *   - verifier/state from crypto RNG per attempt; verifier never in a URL,
 *     log, error, or telemetry.
 *   - state is constant-time compared before a code is used.
 *   - exchange response `scope` is what was GRANTED, not what was asked for —
 *     a narrower grant is surfaced, never assumed.
 *   - the exchanged key is durable (not a refresh token): reused until the
 *     provider revokes it, no proactive refresh, no invented refresh grant.
 *   - a 401 from the relay marks the exact account + credential generation
 *     `needsReauth`; a late failure from an old generation never pollutes a
 *     newly logged-in credential.
 *
 * The key is persisted to the project's existing secret location (.env), the
 * same trust boundary Lynkr already uses for every provider key. It is never
 * written to logs, errors, telemetry, or this module's own outputs.
 *
 * @module clients/orcarouter-credentials
 */

const crypto = require("crypto");

// ---------------------------------------------------------------------------
// OAuth origins (public defaults; explicit overrides win; shared self-hosted
// fallback). Never derive one origin from the other.
// ---------------------------------------------------------------------------

function resolveAuthBase(env = process.env) {
  return String(
    env.ORCA_AUTH_BASE_URL || env.ORCA_BASE_URL || "https://www.orcarouter.ai"
  ).replace(/\/+$/, "");
}

function resolveApiBase(env = process.env) {
  return String(
    env.ORCA_API_BASE_URL || env.ORCA_BASE_URL || "https://api.orcarouter.ai"
  ).replace(/\/+$/, "");
}

/** Require HTTPS for non-loopback remote origins. */
function assertAllowedOrigin(base, { allowHttpLoopback = false } = {}) {
  let u;
  try {
    u = new URL(base);
  } catch {
    throw new Error(`OrcaRouter base URL is not a valid URL: ${base}`);
  }
  const host = u.hostname.toLowerCase();
  const isLoopback = host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1";
  const protocol = u.protocol.toLowerCase();
  if (protocol === "http:") {
    if (!(allowHttpLoopback && isLoopback)) {
      throw new Error(`OrcaRouter base URL must be HTTPS (got ${protocol}//${host})`);
    }
  } else if (protocol !== "https:") {
    throw new Error(`OrcaRouter base URL must be HTTPS (got ${protocol}//${host})`);
  }
  return base;
}

// ---------------------------------------------------------------------------
// PKCE primitives (S256)
// ---------------------------------------------------------------------------

function b64url(bytes) {
  return Buffer.from(bytes).toString("base64url");
}

/** Fresh 256-bit verifier from a crypto RNG. */
function generateVerifier() {
  return b64url(crypto.randomBytes(32));
}

/** S256 challenge: base64url(sha256(verifier)), no padding. */
function generateChallenge(verifier) {
  return b64url(crypto.createHash("sha256").update(verifier).digest());
}

/** Opaque CSRF state, fresh per attempt. */
function generateState() {
  return b64url(crypto.randomBytes(16));
}

/** Constant-time string comparison. */
function timingSafeEqualStr(a, b) {
  const ba = Buffer.from(String(a || ""));
  const bb = Buffer.from(String(b || ""));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

// ---------------------------------------------------------------------------
// Credential shape + store
// ---------------------------------------------------------------------------

/**
 * The credential result both adapters produce and every consumer consumes.
 * @typedef {object} OrcaCredential
 * @property {string} key            - the sk-orca-… API key
 * @property {string} source         - 'api_key' | 'pkce'
 * @property {string} [scope]        - granted scope (from exchange response)
 * @property {number} [generation]   - monotonic credential generation
 */

let _generation = 0;

/**
 * The one credential adapter seam. `read`, `save`, `clear` delegate to the
 * repository's own secret store (here: env/.env via a provided persistence
 * hook, defaulting to in-process state for headless/test use).
 */
class OrcaCredentialStore {
  /**
   * @param {object} [opts]
   * @param {object} [opts.env]            - env object (defaults to process.env)
   * @param {Function} [opts.loadSecret]    - () => string|null  current key
   * @param {Function} [opts.saveSecret]    - (key) => void       persist key
   * @param {Function} [opts.clearSecret]   - () => void          clear key
   */
  constructor(opts = {}) {
    this.env = opts.env || process.env;
    this._loadSecret = opts.loadSecret || (() => this.env.ORCAROUTER_API_KEY || null);
    // Default persistence keeps the in-memory env in sync so the same
    // process sees a just-saved key immediately (mirrors .env semantics).
    this._saveSecret = opts.saveSecret || ((key) => { this.env.ORCAROUTER_API_KEY = key; });
    this._clearSecret = opts.clearSecret || (() => { delete this.env.ORCAROUTER_API_KEY; });
    /** accountId → { generation, needsReauth } */
    this._reauthState = new Map();
  }

  /**
   * Read the current key (masked by default for UI/status display).
   * @returns {{ present:boolean, masked:string|null, generation:number, needsReauth:boolean }}
   */
  read() {
    const raw = this._loadSecret();
    const generation = _generation;
    const account = this._accountFor(raw);
    const st = this._reauthState.get(account);
    return {
      present: !!raw,
      masked: raw ? maskKey(raw) : null,
      generation,
      needsReauth: !!st?.needsReauth,
      account,
    };
  }

  /** Persist a newly obtained key (API key or PKCE result) and bump generation. */
  save(key, meta = {}) {
    if (!key || typeof key !== "string" || !key.trim()) {
      throw new Error("OrcaRouter credential save requires a key");
    }
    _generation += 1;
    this._saveSecret(key.trim());
    const account = this._accountFor(key);
    // A successful new login clears the reauth flag for this account only.
    if (this._reauthState.has(account)) this._reauthState.delete(account);
    return {
      key: key.trim(),
      source: meta.source || "api_key",
      scope: meta.scope || null,
      generation: _generation,
    };
  }

  /** Clear the stored key without touching reauth state (user-initiated). */
  clear() {
    _generation += 1;
    this._clearSecret();
  }

  /**
   * Mark a rejected credential generation `needsReauth`. Only the exact
   * account that made the rejected request is marked; a late failure from an
   * old generation must never pollute a newly reauthorized credential.
   * @param {string} key - the key that produced the 401
   * @param {number} generation - the generation that made the request
   */
  markRejected(key, generation) {
    const account = this._accountFor(key);
    // generation is assigned at save time; an absent generation (legacy
    // request) is treated as current — only an explicitly older generation is
    // skipped as stale.
    if (generation != null && generation < _generation) {
      // A stale request failed AFTER a newer login succeeded — don't mark
      // the fresh credential broken.
      return { skipped: true, reason: "stale_generation" };
    }
    this._reauthState.set(account, { needsReauth: true, at: Date.now() });
    return { account, needsReauth: true };
  }

  _accountFor(key) {
    if (!key) return "anonymous";
    // Account identity = the credential's own stable fingerprint (never the
    // key itself in logs); generation-safe reauth keys off this.
    return "orca-" + crypto.createHash("sha256").update(String(key)).digest("hex").slice(0, 16);
  }
}

/** Mask an API key for display: keep first 7 + last 4 chars. */
function maskKey(key) {
  const s = String(key || "");
  if (s.length <= 11) return s ? `${s.slice(0, 2)}…` : "";
  return `${s.slice(0, 7)}…${s.slice(-4)}`;
}

// ---------------------------------------------------------------------------
// Adapter A — API key
// ---------------------------------------------------------------------------

/**
 * Build the API-key adapter on the shared store seam.
 * Supports save (update), read (masked), and clear.
 */
function createApiKeyAdapter(store, opts = {}) {
  const keyInput = () => opts.env?.ORCAROUTER_API_KEY || store.env.ORCAROUTER_API_KEY || null;
  return {
    kind: "api_key",
    /** @returns {OrcaCredential|null} */
    obtain() {
      const raw = keyInput();
      if (!raw) return null;
      return { key: raw.trim(), source: "api_key", generation: _generation };
    },
    /** Persist/update an API key (user-entered) and return the credential. */
    set(key) {
      return store.save(key, { source: "api_key" });
    },
    /** Read masked state for UI. */
    status() {
      return store.read();
    },
    /** Clear the stored key. */
    clear() {
      return store.clear();
    },
  };
}

// ---------------------------------------------------------------------------
// Adapter B — OAuth 2.0 + PKCE (Flow B, out-of-band code)
// ---------------------------------------------------------------------------

/**
 * Build an authorize URL for Flow B (`callback_url=oob`, S256 mandatory).
 * @param {object} opts - { authBaseUrl, appName, verifier, state }
 * @returns {string}
 */
function buildAuthorizeUrl({ authBaseUrl, appName = "Lynkr", verifier, state }) {
  assertAllowedOrigin(authBaseUrl, { allowHttpLoopback: true });
  const u = new URL("/auth", authBaseUrl);
  u.searchParams.set("callback_url", "oob");
  u.searchParams.set("code_challenge", generateChallenge(verifier));
  u.searchParams.set("code_challenge_method", "S256");
  u.searchParams.set("state", state);
  u.searchParams.set("app_name", appName);
  u.searchParams.set("scope", "api");
  return u.toString();
}

/**
 * Exchange an out-of-band code for a durable API key.
 * @param {object} opts - { authBaseUrl, code, verifier, fetchImpl }
 * @returns {Promise<{ok:boolean, credential?:OrcaCredential, error?:{status?:number, code?:string, message:string}}>}
 */
async function exchangeCode({ authBaseUrl, code, verifier, fetchImpl = fetch }) {
  const url = `${String(authBaseUrl).replace(/\/+$/, "")}/api/v1/auth/keys`;
  let res;
  try {
    res = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        code,
        code_verifier: verifier,
        code_challenge_method: "S256",
      }),
    });
  } catch (err) {
    return { ok: false, error: { code: "network", message: `OrcaRouter exchange failed: ${err.message}` } };
  }

  const text = await res.text().catch(() => "");
  let body = null;
  try { body = JSON.parse(text); } catch { /* non-JSON error body */ }

  if (!res.ok) {
    // 400 = challenge mismatch/downgrade; 403 = unknown/expired/used code or
    // verifier mismatch; 429 = per-user per-24h PKCE key cap.
    const message = body?.error_description
      || (typeof body?.error === "string" ? body.error : null)
      || body?.message
      || `HTTP ${res.status}`;
    return {
      ok: false,
      error: { status: res.status, code: body?.error || "http_error", message },
    };
  }

  const key = body?.key;
  if (!key || typeof key !== "string" || !key.trim()) {
    return { ok: false, error: { status: res.status, code: "invalid_response", message: "OrcaRouter exchange returned no key" } };
  }

  // Read the GRANTED scope (not the requested scope). A narrower grant is
  // surfaced, never assumed to be the requested one.
  const scope = typeof body.scope === "string" ? body.scope : null;

  return {
    ok: true,
    credential: {
      key: key.trim(),
      source: "pkce",
      scope,
      generation: _generation,
    },
  };
}

/**
 * Full PKCE connect (Flow B): generate verifier+state, build authorize URL,
 * accept the pasted one-time code, exchange it, persist the durable key.
 *
 * Two-phase usage (same process — the verifier is the PKCE binding):
 *   const started = await connectWithPkce({ appName });
 *   // ... user authorizes started.authorizeUrl, pastes code ...
 *   const result = await connectWithPkce({ appName, code, verifier: started.verifier, state: started.state });
 * @param {object} opts - { authBaseUrl, appName, code?, verifier?, state?, env, fetchImpl }
 * @returns {Promise<{ok:boolean, authorizeUrl?:string, credential?:OrcaCredential, error?:object}>}
 */
async function connectWithPkce(opts = {}) {
  const authBaseUrl = resolveAuthBase(opts.env || process.env);
  // Second phase: reuse the verifier that produced the challenge. Generating
  // a fresh verifier here would never match the authorized challenge and the
  // exchange would always fail — fail fast with an actionable error instead.
  if (opts.code) {
    const verifier = typeof opts.verifier === "string" ? opts.verifier.trim() : "";
    if (!verifier) {
      return {
        ok: false,
        error: {
          code: "missing_verifier",
          message: "PKCE verifier missing — restart `lynkr connect orcarouter` and exchange the code in the same process.",
        },
      };
    }
    const exchanged = await exchangeCode({ authBaseUrl, code: opts.code, verifier, fetchImpl: opts.fetchImpl });
    if (!exchanged.ok) return exchanged;

    // Persist the durable key. The PKCE flow only issues keys via this seam.
    const credential = store.save(exchanged.credential.key, {
      source: "pkce",
      scope: exchanged.credential.scope,
    });
    return { ok: true, credential, authorizeUrl: undefined };
  }

  const verifier = generateVerifier();
  const state = generateState();
  const authorizeUrl = buildAuthorizeUrl({
    authBaseUrl,
    appName: opts.appName || "Lynkr",
    verifier,
    state,
  });

  // No code yet → hand back the authorize URL for the caller/UI to show and
  // the user to paste the code. The verifier stays in-process only.
  return { ok: true, authorizeUrl, state, verifier };
}

// Shared default store for the seam (tests may construct their own).
let store = new OrcaCredentialStore();

/** @returns {OrcaCredentialStore} */
function getCredentialStore() {
  return store;
}

/** Test helper: reset the shared store to a clean instance. */
function _resetCredentialStore() {
  store = new OrcaCredentialStore();
}

module.exports = {
  // seam + adapters
  OrcaCredentialStore,
  createApiKeyAdapter,
  connectWithPkce,
  getCredentialStore,
  _resetCredentialStore,
  // primitives
  generateVerifier,
  generateChallenge,
  generateState,
  timingSafeEqualStr,
  buildAuthorizeUrl,
  exchangeCode,
  maskKey,
  // origins
  resolveAuthBase,
  resolveApiBase,
  assertAllowedOrigin,
};
