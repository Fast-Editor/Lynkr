/**
 * Phase 2a — native-format streaming passthrough.
 *
 * When the client speaks Anthropic and the tier-resolved upstream is an
 * Anthropic-family provider, the buffered orchestrator adds nothing but
 * latency: the response needs no format conversion and (post server-mode
 * removal) no tool execution. This module connects to the upstream with
 * stream:true and pipes the SSE bytes to the client as they arrive, so
 * Claude Code sees first tokens as soon as the model emits them.
 *
 * Fallback contract: before the first byte reaches the client we can still
 * fall back to the buffered orchestrator path — handleNativeStream returns
 * false and the router continues its normal flow. After the first byte the
 * stream is the response; upstream failures surface as SSE error events,
 * never retries.
 *
 * Kill switch: LYNKR_NATIVE_PASSTHROUGH=false reverts every request to the
 * buffered path.
 */
const config = require("../config");
const logger = require("../logger");

// Providers whose wire format is Anthropic Messages SSE end-to-end. vertex is
// deliberately absent: this deployment's vertex client speaks Gemini.
// - zai qualifies only when its endpoint is the Anthropic-format one
//   (api.z.ai/api/anthropic/...), not /chat/completions.
// - ollama qualifies only when LYNKR_OLLAMA_BUFFER_RESPONSES=false: buffering
//   is the default because Ollama Cloud thinking models (MiniMax M2.5) can
//   leak raw <think> tags into text blocks, and the buffered path is where
//   _liftLeakedThinkingBlocks repairs that. Streaming skips the repair.
//   The daemon must also expose the Anthropic Messages API (v0.14+) — that
//   check is async and happens in handleNativeStream, falling back to the
//   buffered path when absent.
// Tier configs write the z.ai provider as "z-ai"; the config key and
// invokeModel dispatch use "zai". Accept both.
function _canonicalProvider(provider) {
  return provider === "z-ai" ? "zai" : provider;
}

function _anthropicNative(provider) {
  switch (_canonicalProvider(provider)) {
    case "azure-anthropic":
      return true;
    case "zai":
      return !!config.zai?.apiKey && !String(config.zai?.endpoint || "").includes("/chat/completions");
    case "ollama":
      return process.env.LYNKR_OLLAMA_BUFFER_RESPONSES === "false" && !!config.ollama?.endpoint;
    default:
      return false;
  }
}

const IDLE_TIMEOUT_MS = Number.parseInt(process.env.LYNKR_STREAM_IDLE_TIMEOUT_MS ?? "60000", 10);

// Parseable Anthropic error event for mid-stream failures — clients fail fast
// and retry instead of hanging on a truncated stream.
const SSE_ERROR_EVENT = (message) =>
  `event: error\ndata: ${JSON.stringify({ type: "error", error: { type: "overloaded_error", message } })}\n\n`;

function _formatsMatch(clientFormat, provider) {
  return clientFormat === "anthropic" && _anthropicNative(provider);
}

/**
 * Response rewrites the passthrough CANNOT reproduce force the buffered
 * path. Only ANSI markdown rendering remains here: it rewrites whole text
 * blocks, which is impossible on a byte pipe. The routing badge is NOT a
 * disqualifier — it's injected as a synthetic SSE content block before the
 * upstream bytes (same trick the OAuth subscription passthrough ships).
 */
function _needsInflightRewrite() {
  try {
    const { enabled: ansiEnabled } = require("../utils/markdown-ansi");
    if (ansiEnabled) return true;
  } catch { /* renderer unavailable — nothing rewrites */ }
  return false;
}

function canPassthrough(body, tier) {
  if (process.env.LYNKR_NATIVE_PASSTHROUGH === "false") return false;
  if (body?.stream !== true) return false;
  if (!_formatsMatch("anthropic", tier?.provider)) return false;
  if (_needsInflightRewrite(body)) return false;
  return true;
}

/**
 * Synthetic badge block frames (no trailing separator — the frame processor
 * joins). NEVER emitted before message_start: Anthropic's SSE contract opens
 * every stream with message_start, and Claude Code's incremental parser
 * hard-rejects content_block events that precede it (zero events parsed,
 * instant retry — live incident 2026-07-21).
 */
function _badgeFrames(badgeText) {
  return [
    `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}`,
    `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: badgeText } })}`,
    `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}`,
  ];
}

function _readWithIdleTimeout(reader, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`upstream idle > ${ms}ms`)), ms);
  });
  return Promise.race([reader.read(), timeout]).finally(() => clearTimeout(timer));
}

/**
 * Usage arrives in the FINAL message_delta event, so keep a tail buffer
 * rather than a head capture. Best-effort — returns nulls on any miss.
 */
function _extractUsageFromTail(tail) {
  let inputTokens = null;
  let outputTokens = null;
  for (const line of tail.split("\n")) {
    if (!line.startsWith("data:")) continue;
    try {
      const evt = JSON.parse(line.slice(5).trim());
      if (evt?.type === "message_start" && evt.message?.usage?.input_tokens != null) {
        inputTokens = evt.message.usage.input_tokens;
      }
      if (evt?.type === "message_delta" && evt.usage) {
        if (evt.usage.output_tokens != null) outputTokens = evt.usage.output_tokens;
        if (evt.usage.input_tokens != null) inputTokens = evt.usage.input_tokens;
      }
    } catch { /* partial event in tail window */ }
  }
  return { inputTokens, outputTokens };
}

/**
 * Frame-level processor for piped Anthropic SSE. Two jobs:
 *
 *  - badge injection (all providers): the LYNKR_VISIBLE_ROUTING badge block
 *    is emitted immediately AFTER the upstream's message_start frame — never
 *    before it (protocol contract; see _badgeFrames).
 *  - ollama repairs (ollamaRepairs: true), both learned from live Claude
 *    Code 2.1.216 aborting the raw stream in <100ms:
 *      · drop thinking blocks: Ollama emits them UNSIGNED (no
 *        signature_delta), unlike api.anthropic.com, and CC rejects the
 *        stream. The buffered path solved this with
 *        _liftLeakedThinkingBlocks; streams strip instead.
 *      · normalize message_start: Ollama omits stop_reason/stop_sequence.
 *
 * Frames are "event: X\ndata: {...}\n\n" units; anything unparseable passes
 * through untouched.
 */
function _createFrameProcessor({ badgeText = null, ollamaRepairs = false } = {}) {
  let buffer = "";
  let badgePending = !!badgeText;
  const droppedIndices = new Set();

  // Returns null (drop), a string, or an array of frames (injection).
  const processFrame = (frame) => {
    const dataLine = frame.split("\n").find((l) => l.startsWith("data:"));
    if (!dataLine) return frame;
    let evt;
    try { evt = JSON.parse(dataLine.slice(5).trim()); } catch { return frame; }

    if (evt.type === "message_start" && evt.message) {
      let out = frame;
      if (ollamaRepairs) {
        if (!("stop_reason" in evt.message)) evt.message.stop_reason = null;
        if (!("stop_sequence" in evt.message)) evt.message.stop_sequence = null;
        out = `event: message_start\ndata: ${JSON.stringify(evt)}`;
      }
      if (badgePending) {
        badgePending = false;
        return [out, ..._badgeFrames(badgeText)];
      }
      return out;
    }
    if (!ollamaRepairs) return frame;
    if (evt.type === "content_block_start" && evt.content_block?.type === "thinking") {
      droppedIndices.add(evt.index);
      return null;
    }
    if (evt.type === "content_block_delta" && droppedIndices.has(evt.index)) return null;
    if (evt.type === "content_block_stop" && droppedIndices.has(evt.index)) {
      droppedIndices.delete(evt.index);
      return null;
    }
    return frame;
  };

  return (chunkText, flush = false) => {
    buffer += chunkText;
    const frames = buffer.split("\n\n");
    buffer = flush ? "" : (frames.pop() ?? "");
    const out = frames.flatMap((f) => {
      const r = processFrame(f);
      return r === null ? [] : Array.isArray(r) ? r : [r];
    });
    if (flush && buffer) out.push(buffer);
    return out.length ? out.join("\n\n") + "\n\n" : "";
  };
}

/**
 * Connect to the upstream with stream:true and pipe bytes to the client.
 * Returns true when the response was handled (success OR mid-stream error
 * already surfaced to the client), false when the router should fall back
 * to the buffered path (no bytes have been written).
 */
async function handleNativeStream(req, res, opts = {}) {
  const tier = opts.tier || {};
  const startedAt = Date.now();

  const body = { ...req.body, stream: true };
  if (tier.model && !body._tierModel) body._tierModel = tier.model;

  let upstream;
  try {
    // Reuse the provider clients: they own the endpoint, auth headers, model
    // override, internal-field stripping, and body repair.
    const databricks = require("../clients/databricks");
    const provider = _canonicalProvider(tier.provider);
    if (provider === "zai") {
      upstream = await databricks.invokeZai(body, req.headers);
    } else if (provider === "ollama") {
      // The daemon must speak the Anthropic Messages API (v0.14+); on older
      // daemons invokeOllama takes the legacy /api/chat path, which returns
      // its own format — fall back to the buffered converter.
      const { hasAnthropicEndpoint } = require("../clients/ollama-utils");
      if (!(await hasAnthropicEndpoint(config.ollama.endpoint))) {
        logger.debug("[NativeStream] Ollama daemon lacks Anthropic API — falling back to buffered path");
        return false;
      }
      upstream = await databricks.invokeOllama(body, req.headers);
    } else {
      upstream = await databricks.invokeAzureAnthropic(body, req.headers);
    }
  } catch (err) {
    logger.warn({ err: err.message }, "[NativeStream] Upstream connect failed — falling back to buffered path");
    return false;
  }

  if (!upstream?.ok || !upstream.stream) {
    logger.warn({ status: upstream?.status }, "[NativeStream] Upstream non-200 before first byte — falling back to buffered path");
    return false;
  }

  const contentType = upstream.contentType || "";
  if (!contentType.includes("text/event-stream")) {
    // Provider answered buffered JSON despite stream:true. Rare; hand the
    // request back to the buffered path (costs a duplicate upstream call).
    logger.warn({ contentType }, "[NativeStream] Upstream ignored stream:true — falling back to buffered path");
    try { upstream.stream.cancel?.()?.catch?.(() => { /* already drained */ }); } catch { /* already drained */ }
    return false;
  }

  // ── Past the point of no return: headers + bytes go to the client. ──
  res.status(200);
  // Never mirror upstream Content-Length — this response is chunked.
  res.set({
    "Content-Type": contentType,
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.set("X-Lynkr-Provider", tier.provider || "azure-anthropic");
  if (tier.tier) res.set("X-Lynkr-Tier", tier.tier);
  if (tier.model || req.body?.model) res.set("X-Lynkr-Model", tier.model || req.body.model);
  res.set("X-Lynkr-Routing-Method", "native-passthrough-stream");
  if (typeof res.flushHeaders === "function") res.flushHeaders();

  const reader = upstream.stream.getReader();
  const decoder = new TextDecoder();
  // Frame processing is needed when injecting the badge (which must land
  // AFTER the upstream's message_start) and for ollama's repairs. With
  // neither, the stream stays a pure byte pipe.
  const _wantsBadge = !!(config.routing?.visibleInteraction && opts.badgeText);
  const _isOllama = _canonicalProvider(tier.provider) === "ollama";
  const frameFilter = (_wantsBadge || _isOllama)
    ? _createFrameProcessor({ badgeText: _wantsBadge ? opts.badgeText : null, ollamaRepairs: _isOllama })
    : null;
  let tail = ""; // last ~16KB, for the usage-bearing final events
  let streamError = null;
  let firstByteAt = null;

  const writeWithBackpressure = async (data) => {
    if (!data || data.length === 0) return;
    // Honor backpressure: if the client reads slowly, wait for drain
    // instead of buffering the upstream into memory.
    if (!res.write(data)) {
      await new Promise((resolve) => res.once("drain", resolve));
    }
  };

  try {
    while (true) {
      const { value, done } = await _readWithIdleTimeout(reader, IDLE_TIMEOUT_MS);
      if (done) break;
      if (firstByteAt === null) firstByteAt = Date.now();

      let outText = null;
      if (frameFilter) {
        outText = frameFilter(decoder.decode(value, { stream: true }));
        await writeWithBackpressure(outText);
      } else {
        await writeWithBackpressure(Buffer.from(value));
        outText = decoder.decode(value, { stream: true });
      }

      tail += outText;
      if (tail.length > 16384) tail = tail.slice(-16384);
    }
    if (frameFilter) {
      // Flush the decoder and any partial frame held by the filter.
      const flushed = frameFilter(decoder.decode(), true);
      await writeWithBackpressure(flushed);
      tail += flushed;
    }
  } catch (err) {
    streamError = err;
    logger.warn({ err: err.message }, "[NativeStream] Upstream stream failed mid-flight — surfacing SSE error");
    // cancel() rejects ASYNCHRONOUSLY on a dead socket — a sync try/catch
    // would leak an unhandled rejection.
    try { reader.cancel().catch(() => { /* already dead */ }); } catch { /* already dead */ }
    try { res.write(SSE_ERROR_EVENT(`Lynkr: upstream stream failed — retry (${err.message})`)); } catch { /* client gone */ }
  } finally {
    try { reader.releaseLock(); } catch { /* already released */ }
  }
  res.end();

  // ── Response finalizer: telemetry runs on stream close, never blocks. ──
  setImmediate(() => {
    try {
      const latencyMs = Date.now() - startedAt;
      const ttftMs = firstByteAt ? firstByteAt - startedAt : null;
      const { inputTokens, outputTokens } = _extractUsageFromTail(tail);
      logger.info({
        provider: tier.provider || "azure-anthropic",
        ttftMs,
        latencyMs,
        outputTokens,
        error: streamError ? streamError.message : null,
      }, "[NativeStream] Stream closed");

      const { getMetricsCollector } = require("../observability/metrics");
      const mc = getMetricsCollector();
      if (streamError) mc.recordProviderFailure(tier.provider || "azure-anthropic");
      else mc.recordProviderSuccess(tier.provider || "azure-anthropic", latencyMs);
      if (inputTokens || outputTokens) mc.recordTokens(inputTokens || 0, outputTokens || 0);

      const telemetry = require("../routing/telemetry");
      telemetry.record({
        // request_id is NOT NULL in the telemetry schema — a null id silently
        // drops the whole row.
        request_id: req.headers["request-id"] || req.headers["x-request-id"] || require("crypto").randomUUID(),
        session_id: req.body?._sessionId || req.sessionId || null,
        timestamp: startedAt,
        tier: tier.tier || null,
        provider: tier.provider || "azure-anthropic",
        model: tier.model || req.body?.model || null,
        routing_method: "native-passthrough-stream",
        status_code: streamError ? 599 : 200,
        latency_ms: latencyMs,
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        message_count: req.body?.messages?.length || null,
        tool_count: Array.isArray(req.body?.tools) ? req.body.tools.length : 0,
        was_fallback: false,
        error_type: streamError ? "stream_error" : null,
      });
    } catch (err) {
      logger.debug({ err: err.message }, "[NativeStream] Telemetry finalizer failed (non-fatal)");
    }
  });

  return true;
}

module.exports = {
  canPassthrough,
  handleNativeStream,
  _createFrameProcessor,
  // Exported for unit tests.
  _formatsMatch,
  _extractUsageFromTail,
};
