/**
 * LYNKR_API_KEY gate + LYNKR_BIND_HOST config.
 *
 * Contract pinned here:
 *   1. no key configured → every route is open (byte-identical to pre-9.14.23 behaviour)
 *   2. key configured → 401 without it on /v1/*, /routing/*, /metrics*, /dashboard/api/*
 *   3. any of x-api-key / api-key / Authorization: Bearer unlocks; an upstream OAuth bearer
 *      next to a valid x-api-key is fine (subscription passthrough keeps working)
 *   4. /health, /health/live, /health/ready are always open
 *   5. OpenAI endpoints get the OpenAI error shape, everything else the Anthropic shape
 *   6. comparison is constant-time and length-safe
 *   7. config parses LYNKR_BIND_HOST (default 0.0.0.0) and LYNKR_API_KEY (trimmed, null when empty)
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const express = require("express");

process.env.DATABRICKS_API_KEY = process.env.DATABRICKS_API_KEY || "test-key";
process.env.DATABRICKS_API_BASE = process.env.DATABRICKS_API_BASE || "http://test.com";
process.env.LOG_FILE_ENABLED = "false";
process.env.LYNKR_BIND_HOST = " 127.0.0.1 ";
process.env.LYNKR_API_KEY = "  cfg-key-123  ";

const { createApiKeyAuth, isProtected, isOpenAiSurface, presentedKeys, safeEqual } = require("../src/middleware/api-key-auth");

function appWith(key) {
  const app = express();
  app.use(createApiKeyAuth(key));
  const ok = (_req, res) => res.json({ ok: true });
  app.get("/health", ok); app.get("/health/live", ok); app.get("/health/ready", ok);
  app.post("/v1/messages", ok); app.post("/v1/chat/completions", ok); app.post("/v1/responses", ok);
  app.get("/v1/models", ok); app.get("/routing/stats", ok); app.get("/metrics", ok); app.get("/metrics/prometheus", ok);
  app.get("/dashboard/api/overview", ok); app.get("/dashboard", ok); app.get("/open", ok);
  return app;
}

async function withServer(app, fn) {
  const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  try { return await fn(server.address().port); } finally { await new Promise((r) => server.close(r)); }
}

function request(port, method, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path, headers }, (res) => {
      let body = ""; res.on("data", (c) => (body += c)); res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: body ? JSON.parse(body) : null }));
    });
    req.on("error", reject); req.end();
  });
}

test("no key configured: everything is open", async () => {
  await withServer(appWith(null), async (port) => {
    for (const [m, p] of [["POST", "/v1/messages"], ["GET", "/routing/stats"], ["GET", "/metrics"], ["GET", "/dashboard/api/overview"], ["GET", "/health"]]) {
      assert.equal((await request(port, m, p)).status, 200, `${m} ${p}`);
    }
  });
  await withServer(appWith(""), async (port) => { assert.equal((await request(port, "POST", "/v1/messages")).status, 200); });
});

test("key configured: protected routes 401 without a key, health stays open", async () => {
  await withServer(appWith("s3cret"), async (port) => {
    for (const [m, p] of [["POST", "/v1/messages"], ["GET", "/v1/models"], ["GET", "/routing/stats"], ["GET", "/metrics"], ["GET", "/metrics/prometheus"], ["GET", "/dashboard/api/overview"]]) {
      const r = await request(port, m, p);
      assert.equal(r.status, 401, `${m} ${p}`);
      assert.match(r.headers["www-authenticate"], /Bearer/);
    }
    for (const p of ["/health", "/health/live", "/health/ready", "/dashboard", "/open"]) {
      assert.equal((await request(port, "GET", p)).status, 200, p);
    }
  });
});

test("key configured: each header form unlocks; wrong key does not", async () => {
  await withServer(appWith("s3cret"), async (port) => {
    assert.equal((await request(port, "POST", "/v1/messages", { "x-api-key": "s3cret" })).status, 200);
    assert.equal((await request(port, "POST", "/v1/messages", { "api-key": "s3cret" })).status, 200);
    assert.equal((await request(port, "POST", "/v1/messages", { authorization: "Bearer s3cret" })).status, 200);
    assert.equal((await request(port, "POST", "/v1/messages", { authorization: "bearer s3cret" })).status, 200, "scheme is case-insensitive");
    assert.equal((await request(port, "POST", "/v1/messages", { "x-api-key": "s3cre" })).status, 401);
    assert.equal((await request(port, "POST", "/v1/messages", { "x-api-key": "s3cret-but-longer" })).status, 401);
    assert.equal((await request(port, "POST", "/v1/messages", { authorization: "Basic czNjcmV0" })).status, 401, "non-bearer schemes do not count");
  });
});

test("upstream OAuth bearer alongside a valid x-api-key passes (subscription passthrough)", async () => {
  await withServer(appWith("s3cret"), async (port) => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1In0.c2ln";
    assert.equal((await request(port, "POST", "/v1/messages", { "x-api-key": "s3cret", authorization: `Bearer ${jwt}` })).status, 200);
    assert.equal((await request(port, "POST", "/v1/messages", { authorization: `Bearer ${jwt}` })).status, 401, "an OAuth bearer alone is not the Lynkr key");
  });
});

test("error bodies: OpenAI shape on OpenAI endpoints, Anthropic shape elsewhere", async () => {
  await withServer(appWith("s3cret"), async (port) => {
    const oa = await request(port, "POST", "/v1/chat/completions");
    assert.deepEqual(oa.body, { error: { message: "invalid or missing API key", type: "invalid_request_error", code: "invalid_api_key" } });
    const resp = await request(port, "POST", "/v1/responses");
    assert.equal(resp.body.error.code, "invalid_api_key");
    const an = await request(port, "POST", "/v1/messages");
    assert.deepEqual(an.body, { type: "error", error: { type: "authentication_error", message: "invalid or missing API key" } });
    const rt = await request(port, "GET", "/routing/stats");
    assert.equal(rt.body.error.type, "authentication_error");
  });
});

test("getter form honours hot-reloaded keys without remounting", async () => {
  let current = null;
  await withServer(appWith(() => current), async (port) => {
    assert.equal((await request(port, "POST", "/v1/messages")).status, 200);
    current = "later";
    assert.equal((await request(port, "POST", "/v1/messages")).status, 401);
    assert.equal((await request(port, "POST", "/v1/messages", { "x-api-key": "later" })).status, 200);
    current = null;
    assert.equal((await request(port, "POST", "/v1/messages")).status, 200);
  });
});

test("isProtected / isOpenAiSurface / presentedKeys / safeEqual", () => {
  for (const p of ["/v1", "/v1/messages", "/v1/admin/reload", "/routing/analyze", "/metrics", "/metrics/x", "/dashboard/api/logs"]) assert.equal(isProtected(p), true, p);
  for (const p of ["/health", "/health/live", "/health/ready", "/dashboard", "/", "/v1x", "/routingx", "/metricsx"]) assert.equal(isProtected(p), false, p);
  assert.equal(isProtected("/v1/messages?stream=1"), true);
  assert.equal(isOpenAiSurface("/v1/chat/completions"), true); assert.equal(isOpenAiSurface("/v1/responses"), true); assert.equal(isOpenAiSurface("/v1/messages"), false);
  assert.deepEqual(presentedKeys({ "x-api-key": " a ", "api-key": "b", authorization: "Bearer  c " }), ["a", "b", "c"]);
  assert.deepEqual(presentedKeys({ authorization: "Basic xyz" }), []);
  assert.deepEqual(presentedKeys({ "x-api-key": ["arr", "ignored"] }), ["arr"]);
  assert.equal(safeEqual("abc", "abc"), true); assert.equal(safeEqual("abc", "abd"), false); assert.equal(safeEqual("abc", "abcd"), false);
  assert.equal(safeEqual("", ""), false, "empty never matches"); assert.equal(safeEqual(null, null), false);
});

test("config parses LYNKR_BIND_HOST and LYNKR_API_KEY (trimmed; empty → open)", () => {
  const config = require("../src/config");
  assert.equal(config.bindHost, "127.0.0.1");
  assert.equal(config.apiKey, "cfg-key-123");
  process.env.LYNKR_API_KEY = "   ";
  config.reloadConfig();
  assert.equal(config.apiKey, null, "blank key after hot reload disables the gate");
  process.env.LYNKR_API_KEY = "rotated";
  config.reloadConfig();
  assert.equal(config.apiKey, "rotated");
});
