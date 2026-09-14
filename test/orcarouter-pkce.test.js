"use strict";

/**
 * OrcaRouter PKCE + API-key credential seam tests.
 *
 * Covers the dual-authentication hard gate:
 *   - API-key adapter: save / read (masked) / clear
 *   - PKCE adapter: verifier/challenge/state generation, S256 challenge
 *     (base64url(sha256(verifier)), no padding), authorize URL, exchange
 *     path + body, success persistence, denial, state mismatch, code
 *     reuse/expiry (403), scope downgrade, broken key terminal
 *     classification (needsReauth), 429, network failure.
 *   - Secrets / verifier never appear in URLs, logs, errors, or snapshots.
 *
 * Only fake keys and fake codes are used — never a real credential.
 */

const assert = require("node:assert/strict");
const { describe, it, beforeEach, afterEach } = require("node:test");
const crypto = require("crypto");

function b64url(bytes) {
  return Buffer.from(bytes).toString("base64url");
}

function clearModules() {
  for (const p of [
    "../src/clients/orcarouter-credentials",
    "../src/clients/orcarouter-catalog",
    "../src/clients/databricks",
    "../src/config",
    "../src/routing",
  ]) {
    delete require.cache[require.resolve(p)];
  }
}

describe("OrcaRouter credential seam (API key + PKCE)", () => {
  let originalEnv;
  let originalFetch;

  beforeEach(() => {
    originalEnv = { ...process.env };
    originalFetch = global.fetch;
    process.env.LOG_FILE_ENABLED = "false";
    clearModules();
  });

  afterEach(() => {
    process.env = originalEnv;
    global.fetch = originalFetch;
    clearModules();
  });

  describe("PKCE primitives", () => {
    it("challenge is base64url(sha256(verifier)) with no padding", () => {
      const mod = require("../src/clients/orcarouter-credentials");
      const verifier = mod.generateVerifier();
      // base64url has no '+' '/' or '='
      assert.ok(!verifier.includes("+") && !verifier.includes("/") && !verifier.includes("="));
      const expected = b64url(crypto.createHash("sha256").update(verifier).digest());
      assert.equal(mod.generateChallenge(verifier), expected);
      assert.ok(!mod.generateChallenge(verifier).includes("="), "S256 challenge must be unpadded");
    });

    it("generates fresh verifier + state per attempt from a crypto RNG", () => {
      const mod = require("../src/clients/orcarouter-credentials");
      const v1 = mod.generateVerifier();
      const v2 = mod.generateVerifier();
      assert.notEqual(v1, v2);
      assert.notEqual(mod.generateState(), mod.generateState());
      assert.ok(v1.length >= 40, "verifier should be high-entropy");
      assert.ok(mod.generateState().length >= 20);
    });

    it("timingSafeEqualStr compares state in constant time", () => {
      const mod = require("../src/clients/orcarouter-credentials");
      assert.equal(mod.timingSafeEqualStr("abc", "abc"), true);
      assert.equal(mod.timingSafeEqualStr("abc", "abd"), false);
      assert.equal(mod.timingSafeEqualStr("", ""), true);
      assert.equal(mod.timingSafeEqualStr("abc", "abcd"), false);
    });

    it("remote origins must be HTTPS; HTTP only for loopback", () => {
      const mod = require("../src/clients/orcarouter-credentials");
      assert.doesNotThrow(() => mod.assertAllowedOrigin("https://www.orcarouter.ai"));
      assert.doesNotThrow(() => mod.assertAllowedOrigin("https://api.orcarouter.ai", { allowHttpLoopback: true }));
      assert.doesNotThrow(() => mod.assertAllowedOrigin("http://127.0.0.1:51733", { allowHttpLoopback: true }));
      assert.doesNotThrow(() => mod.assertAllowedOrigin("http://localhost:51733", { allowHttpLoopback: true }));
      assert.throws(() => mod.assertAllowedOrigin("http://www.orcarouter.ai"), /must be HTTPS/);
      assert.throws(() => mod.assertAllowedOrigin("http://127.0.0.1:51733"), /must be HTTPS/);
      assert.throws(() => mod.assertAllowedOrigin("http://api.orcarouter.ai", { allowHttpLoopback: true }), /must be HTTPS/);
    });
  });

  describe("authorize URL (Flow B, out-of-band)", () => {
    it("uses callback_url=oob, S256, state, app_name, scope=api", () => {
      const mod = require("../src/clients/orcarouter-credentials");
      const verifier = mod.generateVerifier();
      const state = mod.generateState();
      const url = new URL(mod.buildAuthorizeUrl({
        authBaseUrl: "https://www.orcarouter.ai",
        appName: "Lynkr",
        verifier,
        state,
      }));
      assert.equal(url.origin, "https://www.orcarouter.ai");
      assert.equal(url.pathname, "/auth");
      assert.equal(url.searchParams.get("callback_url"), "oob");
      assert.equal(url.searchParams.get("code_challenge_method"), "S256");
      assert.equal(url.searchParams.get("state"), state);
      assert.equal(url.searchParams.get("app_name"), "Lynkr");
      assert.equal(url.searchParams.get("scope"), "api");
      // The verifier itself must NEVER appear in the URL — only its S256 hash.
      assert.ok(!url.searchParams.get("code_challenge").includes(verifier));
      assert.ok(!url.toString().includes(verifier), "verifier leaked into authorize URL");
    });

    it("enforces S256 challenge equal to sha256(verifier) on the wire", () => {
      const mod = require("../src/clients/orcarouter-credentials");
      const verifier = "dGVzdC12ZXJpZmllci1mYWtlLXZlcmllbmNlLXZhbHVl"; // fake
      const url = new URL(mod.buildAuthorizeUrl({ authBaseUrl: "https://www.orcarouter.ai", appName: "Lynkr", verifier, state: "st" }));
      const expected = b64url(crypto.createHash("sha256").update(verifier).digest());
      assert.equal(url.searchParams.get("code_challenge"), expected);
    });
  });

  describe("exchange (fake auth server)", () => {
    function fakeAuthServer(routes) {
      const calls = [];
      global.fetch = async (url, options = {}) => {
        calls.push({ url, method: options.method || "GET", headers: options.headers || {}, body: options.body });
        const parsed = new URL(url);
        const route = routes.find((r) => r.path && parsed.pathname === r.path && (r.method ? r.method === (options.method || "GET") : true));
        if (!route) return new Response(JSON.stringify({ error: "not_found" }), { status: 404, headers: { "content-type": "application/json" } });
        return new Response(JSON.stringify(route.body), { status: route.status || 200, headers: { "content-type": "application/json" } });
      };
      return calls;
    }

    it("posts to /api/v1/auth/keys on the auth origin with code + verifier", async () => {
      const calls = fakeAuthServer([
        { path: "/api/v1/auth/keys", method: "POST", status: 200, body: { key: "sk-orca-fake-key-123", user_id: "42", scope: "api" } },
      ]);
      const mod = require("../src/clients/orcarouter-credentials");
      const verifier = mod.generateVerifier();
      const result = await mod.exchangeCode({
        authBaseUrl: "https://www.orcarouter.ai",
        code: "fake-auth-code",
        verifier,
      });
      assert.equal(result.ok, true);
      assert.equal(result.credential.key, "sk-orca-fake-key-123");
      assert.equal(result.credential.scope, "api");
      assert.equal(calls.length, 1);
      assert.equal(calls[0].url, "https://www.orcarouter.ai/api/v1/auth/keys");
      assert.ok(!calls[0].url.includes("v1/chat"), "exchange must not hit the inference path");
      const sent = JSON.parse(calls[0].body);
      assert.equal(sent.code, "fake-auth-code");
      assert.equal(sent.code_verifier, verifier);
      assert.equal(sent.code_challenge_method, "S256");
      // verifier must not appear in the raw body? It SHOULD (that's the point
      // of PKCE), but must never appear in a log/URL — verify URL only here.
    });

    it("reads GRANTED scope, not the requested scope (downgrade surfaced)", async () => {
      fakeAuthServer([
        { path: "/api/v1/auth/keys", method: "POST", status: 200, body: { key: "sk-orca-fake", user_id: "1", scope: "connector" } },
      ]);
      const mod = require("../src/clients/orcarouter-credentials");
      const verifier = mod.generateVerifier();
      const result = await mod.exchangeCode({ authBaseUrl: "https://www.orcarouter.ai", code: "c", verifier });
      assert.equal(result.ok, true);
      assert.equal(result.credential.scope, "connector"); // granted, not requested "api"
    });

    it("403 = code unknown / expired / reused → surfaced error", async () => {
      fakeAuthServer([
        { path: "/api/v1/auth/keys", method: "POST", status: 403, body: { error: "invalid_grant", error_description: "Code unknown, expired, or already used" } },
      ]);
      const mod = require("../src/clients/orcarouter-credentials");
      const result = await mod.exchangeCode({ authBaseUrl: "https://www.orcarouter.ai", code: "used", verifier: mod.generateVerifier() });
      assert.equal(result.ok, false);
      assert.equal(result.error.status, 403);
      assert.match(result.error.message, /unknown, expired, or already used/i);
    });

    it("400 = challenge downgrade / unknown method → surfaced error", async () => {
      fakeAuthServer([
        { path: "/api/v1/auth/keys", method: "POST", status: 400, body: { error: "invalid_request", error_description: "code_challenge_method unrecognised" } },
      ]);
      const mod = require("../src/clients/orcarouter-credentials");
      const result = await mod.exchangeCode({ authBaseUrl: "https://www.orcarouter.ai", code: "c", verifier: mod.generateVerifier() });
      assert.equal(result.ok, false);
      assert.equal(result.error.status, 400);
    });

    it("429 = per-user PKCE key cap → surfaced, no retry loop", async () => {
      fakeAuthServer([
        { path: "/api/v1/auth/keys", method: "POST", status: 429, body: { error: "rate_limit_exceeded", error_description: "Too many PKCE keys" } },
      ]);
      const mod = require("../src/clients/orcarouter-credentials");
      const result = await mod.exchangeCode({ authBaseUrl: "https://www.orcarouter.ai", code: "c", verifier: mod.generateVerifier() });
      assert.equal(result.ok, false);
      assert.equal(result.error.status, 429);
      assert.match(result.error.message, /too many pkce keys/i);
    });

    it("network failure ends cleanly with an actionable error", async () => {
      global.fetch = async () => { throw new Error("ECONNREFUSED"); };
      const mod = require("../src/clients/orcarouter-credentials");
      const verifier = mod.generateVerifier();
      const result = await mod.exchangeCode({ authBaseUrl: "https://www.orcarouter.ai", code: "some-auth-code", verifier });
      assert.equal(result.ok, false);
      assert.equal(result.error.code, "network");
      assert.match(result.error.message, /orcarouter exchange failed/i);
      // Network error must not leak the verifier or the auth code.
      assert.ok(!result.error.message.includes(verifier), "verifier leaked into network error");
      assert.ok(!result.error.message.includes("some-auth-code"), "auth code leaked into network error");
    });
  });

  describe("API-key adapter", () => {
    it("saves, reads masked, clears through the shared seam", () => {
      const mod = require("../src/clients/orcarouter-credentials");
      const store = new mod.OrcaCredentialStore({ env: {} });
      const adapter = mod.createApiKeyAdapter(store, { env: {} });

      assert.equal(adapter.obtain(), null);
      const cred = adapter.set("sk-orca-fake-key-abcdefghijkl");
      assert.equal(cred.source, "api_key");
      assert.equal(adapter.obtain().key, "sk-orca-fake-key-abcdefghijkl");

      const st = adapter.status();
      assert.equal(st.present, true);
      assert.ok(st.masked.includes("sk-orca"));
      assert.ok(!st.masked.includes("abcdefghijkl"), "masked read must not expose the full key");
      assert.equal(store.read().masked, st.masked);

      adapter.clear();
      assert.equal(store.read().present, false);
    });

    it("save requires a non-empty key", () => {
      const mod = require("../src/clients/orcarouter-credentials");
      const store = new mod.OrcaCredentialStore({ env: {} });
      const adapter = mod.createApiKeyAdapter(store, { env: {} });
      assert.throws(() => adapter.set(""), /requires a key/);
    });
  });

  describe("generation-safe reauth classification", () => {
    it("marks the exact rejected generation needsReauth", () => {
      const mod = require("../src/clients/orcarouter-credentials");
      const store = new mod.OrcaCredentialStore({ env: {} });
      const adapter = mod.createApiKeyAdapter(store, { env: {} });
      const cred = adapter.set("sk-orca-fake-key-1");
      assert.equal(store.read().needsReauth, false);
      const marked = store.markRejected(cred.key, cred.generation);
      assert.equal(marked.needsReauth, true);
      assert.equal(store.read().needsReauth, true);
    });

    it("a stale failure after a new login never pollutes the fresh credential", () => {
      const mod = require("../src/clients/orcarouter-credentials");
      const store = new mod.OrcaCredentialStore({ env: {} });
      const adapter = mod.createApiKeyAdapter(store, { env: {} });
      const oldCred = adapter.set("sk-orca-fake-old");
      const oldGeneration = oldCred.generation;
      // New login replaces the key and bumps the generation.
      adapter.set("sk-orca-fake-new");
      // The OLD request's 401 arrives late.
      const result = store.markRejected("sk-orca-fake-old", oldGeneration);
      assert.equal(result.skipped, true);
      assert.equal(store.read().needsReauth, false, "fresh credential must not be marked broken");
      assert.equal(store.read().account.startsWith("orca-"), true);
    });

    it("a current-generation 401 on a revoked key marks it terminal (no fake refresh)", () => {
      const mod = require("../src/clients/orcarouter-credentials");
      const store = new mod.OrcaCredentialStore({ env: {} });
      const adapter = mod.createApiKeyAdapter(store, { env: {} });
      const cred = adapter.set("sk-orca-fake-revoked");
      store.markRejected(cred.key, cred.generation);
      // There is no refresh grant: the only recovery is a new login.
      assert.equal(store.read().needsReauth, true);
    });
  });

  describe("connectWithPkce end-to-end through the adapter", () => {
    it("returns authorize URL without a code, then exchanges + persists with one", async () => {
      const calls = [];
      global.fetch = async (url, options = {}) => {
        calls.push({ url, method: options.method });
        return new Response(JSON.stringify({ key: "sk-orca-pkce-issued", user_id: "7", scope: "api" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      };
      const mod = require("../src/clients/orcarouter-credentials");
      process.env.ORCA_AUTH_BASE_URL = "https://www.orcarouter.ai";

      const started = await mod.connectWithPkce({ appName: "Lynkr" });
      assert.equal(started.ok, true);
      assert.ok(started.authorizeUrl.startsWith("https://www.orcarouter.ai/auth?"));
      assert.ok(!started.authorizeUrl.includes(started.verifier), "verifier must not be in the authorize URL");

      const result = await mod.connectWithPkce({ appName: "Lynkr", code: "one-time-code" });
      assert.equal(result.ok, true);
      assert.equal(result.credential.key, "sk-orca-pkce-issued");
      assert.equal(result.credential.source, "pkce");
      // The persisted key is readable from the store — downstream code doesn't
      // care which adapter produced it.
      assert.equal(mod.getCredentialStore().read().present, true);
      assert.equal(mod.getCredentialStore().read().masked.includes("sk-orca-pkce-issued"), false);
      assert.equal(calls.filter((c) => c.method === "POST").length, 1);
      assert.equal(calls[0].url, "https://www.orcarouter.ai/api/v1/auth/keys");
    });

    it("does not leave the verifier in any error path", async () => {
      global.fetch = async () => new Response(JSON.stringify({ error: "denied", error_description: "The user declined" }), { status: 403, headers: { "content-type": "application/json" } });
      const mod = require("../src/clients/orcarouter-credentials");
      const started = await mod.connectWithPkce({ appName: "Lynkr" });
      const result = await mod.connectWithPkce({ appName: "Lynkr", code: "declined-code" });
      assert.equal(result.ok, false);
      assert.ok(!JSON.stringify(result).includes(started.verifier), "verifier leaked into error result");
      assert.ok(!JSON.stringify(result).includes("declined-code"));
    });
  });
});
