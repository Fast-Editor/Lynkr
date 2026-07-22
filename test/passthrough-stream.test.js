const { describe, it, before, after } = require("node:test");
const assert = require("node:assert");
const http = require("http");
const { EventEmitter } = require("events");

// Point the azure-anthropic client at the mock upstream BEFORE config loads.
const MOCK_PORT = 19883;
process.env.MODEL_PROVIDER = "databricks";
process.env.DATABRICKS_API_KEY = process.env.DATABRICKS_API_KEY || "test-key";
process.env.DATABRICKS_API_BASE = process.env.DATABRICKS_API_BASE || "http://test.com";
process.env.AZURE_ANTHROPIC_ENDPOINT = `http://127.0.0.1:${MOCK_PORT}/v1/messages`;
process.env.AZURE_ANTHROPIC_API_KEY = "test-anthropic-key";
delete process.env.LYNKR_NATIVE_PASSTHROUGH;
// Pin rewrite/eligibility env so a developer's local .env can't flip the
// assertions. ANSI rendering is the one remaining disqualifier (the badge is
// injected in-stream); ollama eligibility hangs on the buffer knob.
process.env.LYNKR_VISIBLE_ROUTING = "false";
process.env.MARKDOWN_RENDER_ANSI = "false";
process.env.LYNKR_OLLAMA_BUFFER_RESPONSES = "true";

const { canPassthrough, handleNativeStream, _extractUsageFromTail } = require("../src/orchestrator/passthrough-stream");

// Real timings, per the spec's footgun list: delta/backpressure bugs only
// show up when chunks arrive over an actual socket with delays.
const SLOW_UPSTREAM_MS = Number.parseInt(process.env.SLOW_UPSTREAM_MS ?? "25", 10);

const SSE_EVENTS = [
  `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "msg_1", usage: { input_tokens: 11 } } })}\n\n`,
  `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}\n\n`,
  `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "streamed" } })}\n\n`,
  `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`,
  `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 4 } })}\n\n`,
  `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
];

/** Minimal Express-response stand-in that records writes with timestamps. */
function mockRes() {
  const res = new EventEmitter();
  res.headers = {};
  res.statusCode = null;
  res.writes = [];
  res.ended = false;
  res.headersSent = false;
  res.status = (code) => { res.statusCode = code; return res; };
  res.set = (k, v) => {
    if (typeof k === "object") Object.assign(res.headers, k);
    else res.headers[k] = v;
    return res;
  };
  res.flushHeaders = () => { res.headersSent = true; };
  res.write = (buf) => { res.writes.push({ at: Date.now(), data: buf.toString() }); return true; };
  res.end = () => { res.ended = true; res.emit("finish"); };
  return res;
}

function mockReq(overrides = {}) {
  return {
    body: { model: "claude-test", stream: true, messages: [{ role: "user", content: "hi" }], ...overrides.body },
    headers: { "content-type": "application/json", ...overrides.headers },
  };
}

describe("Native streaming passthrough (Phase 2a)", () => {
  let server;
  let mode = "stream"; // stream | error500 | json200 | disconnect

  before((done) => {
    server = http.createServer((req, res) => {
      if (mode === "error500") {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: "upstream boom" } }));
        return;
      }
      if (mode === "json200") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ type: "message", content: [{ type: "text", text: "buffered" }] }));
        return;
      }

      res.writeHead(200, { "Content-Type": "text/event-stream" });
      let i = 0;
      const timer = setInterval(() => {
        if (mode === "disconnect" && i === 2) {
          clearInterval(timer);
          res.destroy(); // hard mid-stream failure
          return;
        }
        if (i >= SSE_EVENTS.length) {
          clearInterval(timer);
          res.end();
          return;
        }
        res.write(SSE_EVENTS[i]);
        i += 1;
      }, SLOW_UPSTREAM_MS);
    });
    server.listen(MOCK_PORT, done);
  });

  after((done) => server.close(done));

  describe("canPassthrough eligibility", () => {
    it("accepts anthropic-native provider + stream:true", () => {
      assert.strictEqual(canPassthrough({ stream: true }, { provider: "azure-anthropic" }), true);
    });

    it("rejects non-streaming requests, foreign providers, and the kill switch", () => {
      assert.strictEqual(canPassthrough({ stream: false }, { provider: "azure-anthropic" }), false);
      assert.strictEqual(canPassthrough({ stream: true }, { provider: "openai" }), false);
      assert.strictEqual(canPassthrough({ stream: true }, { provider: "vertex" }), false);

      process.env.LYNKR_NATIVE_PASSTHROUGH = "false";
      try {
        assert.strictEqual(canPassthrough({ stream: true }, { provider: "azure-anthropic" }), false);
      } finally {
        delete process.env.LYNKR_NATIVE_PASSTHROUGH;
      }
    });

    it("ollama eligibility follows the buffer knob (buffered by default)", () => {
      const config = require("../src/config");
      const hadEndpoint = config.ollama?.endpoint;
      if (!config.ollama) config.ollama = {};
      config.ollama.endpoint = config.ollama.endpoint || "http://localhost:11434";
      try {
        process.env.LYNKR_OLLAMA_BUFFER_RESPONSES = "true";
        assert.strictEqual(canPassthrough({ stream: true }, { provider: "ollama" }), false, "buffered → buffered path");
        process.env.LYNKR_OLLAMA_BUFFER_RESPONSES = "false";
        assert.strictEqual(canPassthrough({ stream: true }, { provider: "ollama" }), true, "unbuffered → native stream");
      } finally {
        process.env.LYNKR_OLLAMA_BUFFER_RESPONSES = "true";
        if (!hadEndpoint) config.ollama.endpoint = hadEndpoint;
      }
    });

    it("zai is eligible only on its Anthropic-format endpoint", () => {
      const config = require("../src/config");
      const saved = { ...config.zai };
      try {
        config.zai = { apiKey: "k", endpoint: "https://api.z.ai/api/anthropic/v1/messages" };
        assert.strictEqual(canPassthrough({ stream: true }, { provider: "zai" }), true);
        assert.strictEqual(canPassthrough({ stream: true }, { provider: "z-ai" }), true, "tier-config alias accepted");
        config.zai = { apiKey: "k", endpoint: "https://api.z.ai/v1/chat/completions" };
        assert.strictEqual(canPassthrough({ stream: true }, { provider: "zai" }), false, "OpenAI-format endpoint needs the transformer");
        config.zai = { apiKey: null, endpoint: "https://api.z.ai/api/anthropic/v1/messages" };
        assert.strictEqual(canPassthrough({ stream: true }, { provider: "zai" }), false, "no credentials");
      } finally {
        config.zai = saved;
      }
    });

    it("the visible-routing badge no longer disqualifies passthrough", () => {
      const config = require("../src/config");
      const saved = config.routing?.visibleInteraction;
      try {
        config.routing.visibleInteraction = true;
        assert.strictEqual(canPassthrough({ stream: true }, { provider: "azure-anthropic" }), true);
      } finally {
        config.routing.visibleInteraction = saved;
      }
    });
  });

  describe("handleNativeStream", () => {
    it("pipes upstream SSE incrementally — first bytes arrive before the stream finishes", async () => {
      mode = "stream";
      const res = mockRes();
      const handled = await handleNativeStream(mockReq(), res, { tier: { provider: "azure-anthropic", tier: "COMPLEX" } });

      assert.strictEqual(handled, true);
      assert.strictEqual(res.statusCode, 200);
      assert.ok(res.headers["Content-Type"].includes("text/event-stream"));
      assert.ok(res.ended, "response ended");

      // Incrementality (the TTFT claim): with N events at SLOW_UPSTREAM_MS
      // intervals, a buffered implementation would show ~zero spread between
      // first and last client write. A true pipe shows ≥ (N-2) intervals.
      assert.ok(res.writes.length >= 2, "multiple incremental writes");
      const spread = res.writes.at(-1).at - res.writes[0].at;
      assert.ok(
        spread >= SLOW_UPSTREAM_MS * (SSE_EVENTS.length - 2),
        `writes spread over time (got ${spread}ms) — stream was piped, not buffered`,
      );

      // Byte fidelity: client sees exactly what the upstream sent.
      const full = res.writes.map((w) => w.data).join("");
      assert.strictEqual(full, SSE_EVENTS.join(""), "SSE bytes forwarded untouched");
    });

    it("falls back (returns false, zero bytes written) when upstream 500s before first byte", async () => {
      mode = "error500";
      const res = mockRes();
      const handled = await handleNativeStream(mockReq(), res, { tier: { provider: "azure-anthropic" } });

      assert.strictEqual(handled, false, "router should fall back to buffered path");
      assert.strictEqual(res.writes.length, 0, "no bytes reached the client");
      assert.strictEqual(res.ended, false, "response still open for the buffered path");
    });

    it("falls back when upstream ignores stream:true and answers JSON", async () => {
      mode = "json200";
      const res = mockRes();
      const handled = await handleNativeStream(mockReq(), res, { tier: { provider: "azure-anthropic" } });

      assert.strictEqual(handled, false);
      assert.strictEqual(res.writes.length, 0);
    });

    it("injects the routing badge AFTER message_start (never before — protocol contract)", async () => {
      mode = "stream";
      const config = require("../src/config");
      const saved = config.routing?.visibleInteraction;
      const res = mockRes();
      try {
        config.routing.visibleInteraction = true;
        const handled = await handleNativeStream(mockReq(), res, {
          tier: { provider: "azure-anthropic", tier: "REASONING" },
          badgeText: "*[Lynkr] REASONING → claude-test (azure-anthropic) · score 88*\n\n",
        });
        assert.strictEqual(handled, true);
        const full = res.writes.map((w) => w.data).join("");
        assert.ok(full.includes("*[Lynkr] REASONING"), "badge text present");
        // Claude Code's incremental parser rejects any stream whose first
        // event is not message_start.
        const firstEvent = full.trimStart().split("\n")[0];
        assert.strictEqual(firstEvent, "event: message_start", "stream opens with message_start");
        assert.ok(full.indexOf("message_start") < full.indexOf("*[Lynkr]"), "badge comes after message_start");
        // Upstream content still follows the badge, through message_stop.
        assert.ok(full.indexOf('"text_delta","text":"streamed"') > -1, "upstream text present");
        assert.ok(full.indexOf("*[Lynkr]") < full.indexOf('"text_delta","text":"streamed"'), "upstream content after badge");
        assert.ok(full.includes("message_stop"));
      } finally {
        config.routing.visibleInteraction = saved;
      }
    });

    it("surfaces a mid-stream disconnect as an SSE error event, not a silent hang", async () => {
      mode = "disconnect";
      const res = mockRes();
      const handled = await handleNativeStream(mockReq(), res, { tier: { provider: "azure-anthropic" } });

      assert.strictEqual(handled, true, "past first byte — the stream IS the response");
      assert.ok(res.ended, "response was closed");
      const full = res.writes.map((w) => w.data).join("");
      assert.ok(full.includes(SSE_EVENTS[0]), "bytes before the failure were delivered");
      assert.ok(/event: error/.test(full), "parseable SSE error event appended");
    });
  });

  describe("frame processor", () => {
    const { _createFrameProcessor } = require("../src/orchestrator/passthrough-stream");
    const frame = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

    it("injects the badge immediately after message_start", () => {
      const proc = _createFrameProcessor({ badgeText: "*badge*\n\n" });
      const input =
        frame("message_start", { type: "message_start", message: { id: "m1" } }) +
        frame("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }) +
        frame("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } });
      const out = proc(input, true);

      const frames = out.split("\n\n").filter(Boolean);
      assert.ok(frames[0].includes("message_start"), "message_start first");
      // Badge block = start/delta/stop at frames[1..3]; the delta carries the text.
      assert.ok(frames[1].includes("content_block_start"), "badge block opens right after message_start");
      assert.ok(frames[2].includes("*badge*"), "badge text delta");
      assert.ok(out.includes('"text_delta","text":"hi"'), "upstream frames follow");
      assert.ok(out.indexOf("*badge*") < out.indexOf('"text_delta","text":"hi"'), "badge precedes upstream content");
    });

    it("injects the badge exactly once", () => {
      const proc = _createFrameProcessor({ badgeText: "*badge*" });
      const out =
        proc(frame("message_start", { type: "message_start", message: { id: "m1" } })) +
        proc(frame("message_start", { type: "message_start", message: { id: "m2" } }), true);
      assert.strictEqual(out.split("*badge*").length - 1, 1);
    });

    it("drops unsigned thinking blocks and keeps text blocks", () => {
      const filter = _createFrameProcessor({ ollamaRepairs: true });
      const input =
        frame("message_start", { type: "message_start", message: { id: "m1", usage: { input_tokens: 4 } } }) +
        frame("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } }) +
        frame("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "hmm" } }) +
        frame("content_block_stop", { type: "content_block_stop", index: 0 }) +
        frame("content_block_start", { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } }) +
        frame("content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "OK" } }) +
        frame("content_block_stop", { type: "content_block_stop", index: 1 }) +
        frame("message_stop", { type: "message_stop" });
      const out = filter(input, true);

      assert.ok(!out.includes("thinking"), "thinking frames removed");
      assert.ok(out.includes('"text_delta","text":"OK"'), "text frames intact");
      assert.ok(out.includes("message_stop"));
      // message_start normalized with the keys Claude Code expects.
      assert.ok(out.includes('"stop_reason":null'));
      assert.ok(out.includes('"stop_sequence":null'));
    });

    it("handles frames split across chunk boundaries", () => {
      const filter = _createFrameProcessor({ ollamaRepairs: true });
      const full =
        frame("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } }) +
        frame("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "x" } }) +
        frame("content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "kept" } });
      let out = "";
      // Slice mid-frame, mid-JSON.
      for (const piece of [full.slice(0, 40), full.slice(40, 95), full.slice(95, 96), full.slice(96)]) {
        out += filter(piece);
      }
      out += filter("", true);

      assert.ok(!out.includes("thinking_delta"), "split thinking frames still dropped");
      assert.ok(out.includes("kept"), "split text frame survives reassembly");
    });
  });

  describe("_extractUsageFromTail", () => {
    it("reads usage from the final message events", () => {
      const tail = SSE_EVENTS.join("");
      const { inputTokens, outputTokens } = _extractUsageFromTail(tail);
      assert.strictEqual(inputTokens, 11);
      assert.strictEqual(outputTokens, 4);
    });

    it("returns nulls on garbage without throwing", () => {
      const { inputTokens, outputTokens } = _extractUsageFromTail("data: {broken\nnot-sse\n");
      assert.strictEqual(inputTokens, null);
      assert.strictEqual(outputTokens, null);
    });
  });
});
