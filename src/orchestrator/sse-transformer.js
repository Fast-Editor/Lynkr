/**
 * Phase 2b — cross-format SSE streaming transform.
 *
 * When the client speaks Anthropic but the tier-resolved upstream speaks
 * OpenAI Chat Completions, the buffered path costs a full generation of
 * latency before the client sees a single token. This module reshapes the
 * upstream's SSE deltas into Anthropic Messages events in flight.
 *
 * The hard part is tool calls: OpenAI streams tool_calls[i].function.arguments
 * as unparseable JSON slivers spread across chunks. The transformer
 * accumulates fragments per tool index and emits one clean
 * content_block_start + content_block_delta(input_json_delta) +
 * content_block_stop per COMPLETE tool_use, at stream end — matching the
 * shape Lynkr's buffered synthesis has always sent, so clients see no
 * difference in event structure.
 *
 * Default on; kill switch LYNKR_STREAM_TRANSFORM=false. The buffered path
 * stays for body.stream === false and for hallucination-recovery re-prompts
 * (which require a parsed, buffered response).
 */
const logger = require("../logger");

// Upstreams whose streaming wire format is OpenAI Chat Completions SSE.
// ollama is excluded (own format + buffering quirks), moonshot/zai are
// excluded (their invoke fns convert buffered responses to Anthropic).
const DEFAULT_OPENAI_SSE_PROVIDERS = [
  "openai",
  "azure-openai",
  "openrouter",
  "databricks",
  "lmstudio",
  "llamacpp",
];

function _transformProviders() {
  const env = process.env.LYNKR_STREAM_TRANSFORM_PROVIDERS;
  return new Set(
    env ? env.split(",").map((s) => s.trim()).filter(Boolean) : DEFAULT_OPENAI_SSE_PROVIDERS,
  );
}

function shouldTransform(clientWantsStream, provider) {
  // Default ON since 2026-07-21 (E2E-verified against live upstreams);
  // LYNKR_STREAM_TRANSFORM=false is the kill switch, mirroring
  // LYNKR_NATIVE_PASSTHROUGH. Kill switches stay on streaming paths because
  // past the first byte a stream cannot be retried — reverting behavior via
  // env + restart beats reverting code during an incident.
  if (process.env.LYNKR_STREAM_TRANSFORM === "false") return false;
  if (clientWantsStream !== true) return false;
  return _transformProviders().has(provider);
}

function _sse(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function _mapFinishReason(reason) {
  switch (reason) {
    case "tool_calls":
    case "function_call":
      return "tool_use";
    case "length":
      return "max_tokens";
    case "stop":
    default:
      return "end_turn";
  }
}

/** Normalize a web ReadableStream or Node Readable into an async iterator of Buffers. */
async function* _iterateStream(stream) {
  if (typeof stream.getReader === "function") {
    const reader = stream.getReader();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) return;
        yield value;
      }
    } finally {
      try { reader.releaseLock(); } catch { /* released */ }
    }
  } else {
    yield* stream;
  }
}

/** Split an SSE byte stream into `data:` payload strings. */
async function* _sseDataLines(stream) {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of _iterateStream(stream)) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith("data:")) yield trimmed.slice(5).trim();
    }
  }
  const trimmed = buffer.trim();
  if (trimmed.startsWith("data:")) yield trimmed.slice(5).trim();
}

/**
 * Core transform: OpenAI Chat Completions SSE → Anthropic Messages SSE.
 * Yields Anthropic SSE event strings. `stats` accumulates for the onClose
 * finalizer: tool names/arg sizes and usage, gathered DURING the stream so
 * telemetry needs no second pass.
 */
async function* _openaiToAnthropicEvents(upstream, opts = {}) {
  const fallbackModel = opts.model || "unknown";
  const stats = {
    toolCalls: [], // { name, argBytes }
    usage: { input_tokens: null, output_tokens: null },
    stopReason: null,
  };

  let started = false;
  let messageId = null;
  let model = fallbackModel;
  let nextIndex = 0;
  let textIndex = null; // open text block index, null when closed
  let finishReason = null;
  const toolAcc = new Map(); // openai tool index -> { id, name, args }

  const startMessage = function* () {
    if (started) return;
    started = true;
    yield _sse("message_start", {
      type: "message_start",
      message: {
        id: messageId || `msg_${Date.now()}`,
        type: "message",
        role: "assistant",
        content: [],
        model,
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 1 },
      },
    });
    // LYNKR_VISIBLE_ROUTING badge — a clean first text block, before any
    // upstream content. Unlike the byte-pipe passthrough, the transformer
    // owns the indices, so the badge slots in properly.
    if (opts.badgeText) {
      const index = nextIndex++;
      yield _sse("content_block_start", { type: "content_block_start", index, content_block: { type: "text", text: "" } });
      yield _sse("content_block_delta", { type: "content_block_delta", index, delta: { type: "text_delta", text: opts.badgeText } });
      yield _sse("content_block_stop", { type: "content_block_stop", index });
    }
  };

  const closeTextBlock = function* () {
    if (textIndex === null) return;
    yield _sse("content_block_stop", { type: "content_block_stop", index: textIndex });
    textIndex = null;
  };

  const flushToolBlocks = function* () {
    for (const [, tool] of [...toolAcc.entries()].sort((a, b) => a[0] - b[0])) {
      const index = nextIndex++;
      const args = tool.args || "{}";
      yield _sse("content_block_start", {
        type: "content_block_start",
        index,
        content_block: {
          type: "tool_use",
          id: tool.id || `toolu_${Date.now()}_${index.toString(36)}`,
          name: tool.name || "unknown",
          input: {},
        },
      });
      yield _sse("content_block_delta", {
        type: "content_block_delta",
        index,
        delta: { type: "input_json_delta", partial_json: args },
      });
      yield _sse("content_block_stop", { type: "content_block_stop", index });
      stats.toolCalls.push({ name: tool.name || "unknown", argBytes: args.length });
    }
    toolAcc.clear();
  };

  try {
    for await (const payload of _sseDataLines(upstream)) {
      if (payload === "[DONE]") break;

      let chunk;
      try {
        chunk = JSON.parse(payload);
      } catch {
        continue; // partial/garbled chunk — skip, never crash the stream
      }

      if (chunk.id && !messageId) messageId = chunk.id;
      if (chunk.model) model = chunk.model;
      if (chunk.usage) {
        if (chunk.usage.prompt_tokens != null) stats.usage.input_tokens = chunk.usage.prompt_tokens;
        if (chunk.usage.completion_tokens != null) stats.usage.output_tokens = chunk.usage.completion_tokens;
      }

      const choice = chunk.choices?.[0];
      if (!choice) continue;
      if (choice.finish_reason) finishReason = choice.finish_reason;
      const delta = choice.delta || {};

      yield* startMessage();

      // Text deltas are straightforward: open a block on first text, then
      // emit a text_delta per chunk.
      if (typeof delta.content === "string" && delta.content.length > 0) {
        if (textIndex === null) {
          textIndex = nextIndex++;
          yield _sse("content_block_start", {
            type: "content_block_start",
            index: textIndex,
            content_block: { type: "text", text: "" },
          });
        }
        yield _sse("content_block_delta", {
          type: "content_block_delta",
          index: textIndex,
          delta: { type: "text_delta", text: delta.content },
        });
      }

      // Tool-call fragments: accumulate per OpenAI tool index. Fragments of
      // function.arguments are NOT parseable individually — only the full
      // concatenation is valid JSON, so blocks are emitted at stream end.
      if (Array.isArray(delta.tool_calls)) {
        yield* closeTextBlock();
        for (const tc of delta.tool_calls) {
          const idx = tc.index ?? 0;
          if (!toolAcc.has(idx)) toolAcc.set(idx, { id: null, name: null, args: "" });
          const acc = toolAcc.get(idx);
          if (tc.id) acc.id = tc.id;
          if (tc.function?.name) acc.name = (acc.name || "") + tc.function.name;
          if (typeof tc.function?.arguments === "string") acc.args += tc.function.arguments;
        }
      }
    }
  } catch (err) {
    logger.warn({ err: err.message }, "[SSETransform] Upstream stream failed mid-flight");
    yield* startMessage();
    yield* closeTextBlock();
    yield _sse("error", {
      type: "error",
      error: { type: "overloaded_error", message: `Lynkr: upstream stream failed — retry (${err.message})` },
    });
    stats.stopReason = "stream_error";
    if (opts.onClose) { try { opts.onClose(stats); } catch { /* non-fatal */ } }
    return;
  }

  // Normal end of stream ([DONE] or upstream EOF).
  yield* startMessage();
  yield* closeTextBlock();
  yield* flushToolBlocks();

  const stopReason = _mapFinishReason(finishReason);
  stats.stopReason = stopReason;
  yield _sse("message_delta", {
    type: "message_delta",
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: { output_tokens: stats.usage.output_tokens ?? 0 },
  });
  yield _sse("message_stop", { type: "message_stop" });

  if (opts.onClose) { try { opts.onClose(stats); } catch { /* non-fatal */ } }
}

/**
 * OpenAI SSE → Anthropic SSE. Returns a web ReadableStream (exposes
 * getReader(), matching what the router's stream-forwarding path expects).
 */
function openaiToAnthropicSSE(upstream, opts = {}) {
  const generator = _openaiToAnthropicEvents(upstream, opts);
  const encoder = new TextEncoder();
  return new ReadableStream({
    async pull(controller) {
      try {
        const { value, done } = await generator.next();
        if (done) {
          controller.close();
          return;
        }
        controller.enqueue(encoder.encode(value));
      } catch (err) {
        controller.error(err);
      }
    },
    async cancel() {
      try { await generator.return(); } catch { /* already finished */ }
    },
  });
}

/**
 * Anthropic SSE → OpenAI SSE. The symmetric direction — unused by Lynkr's
 * current routes (OpenAI-speaking clients get buffered conversion) but kept
 * so both directions live and are tested together.
 */
async function* _anthropicToOpenaiEvents(upstream, opts = {}) {
  const model = opts.model || "unknown";
  let id = `chatcmpl_${Date.now()}`;
  let usage = null;
  let stopReason = null;
  const blockTypes = new Map(); // anthropic block index -> type
  let toolOrdinal = -1; // openai tool_calls array index

  const chunk = (delta, finish = null) => ({
    id,
    object: "chat.completion.chunk",
    model,
    choices: [{ index: 0, delta, finish_reason: finish }],
    ...(usage && finish ? { usage } : {}),
  });

  for await (const payload of _sseDataLines(upstream)) {
    let evt;
    try {
      evt = JSON.parse(payload);
    } catch {
      continue;
    }

    switch (evt.type) {
      case "message_start":
        if (evt.message?.id) id = evt.message.id;
        if (evt.message?.usage?.input_tokens != null) {
          usage = { prompt_tokens: evt.message.usage.input_tokens, completion_tokens: 0, total_tokens: evt.message.usage.input_tokens };
        }
        yield `data: ${JSON.stringify(chunk({ role: "assistant", content: "" }))}\n\n`;
        break;
      case "content_block_start":
        blockTypes.set(evt.index, evt.content_block?.type);
        if (evt.content_block?.type === "tool_use") {
          toolOrdinal += 1;
          yield `data: ${JSON.stringify(chunk({
            tool_calls: [{
              index: toolOrdinal,
              id: evt.content_block.id,
              type: "function",
              function: { name: evt.content_block.name, arguments: "" },
            }],
          }))}\n\n`;
        }
        break;
      case "content_block_delta":
        if (evt.delta?.type === "text_delta") {
          yield `data: ${JSON.stringify(chunk({ content: evt.delta.text }))}\n\n`;
        } else if (evt.delta?.type === "input_json_delta") {
          yield `data: ${JSON.stringify(chunk({
            tool_calls: [{ index: toolOrdinal, function: { arguments: evt.delta.partial_json } }],
          }))}\n\n`;
        }
        break;
      case "message_delta":
        if (evt.delta?.stop_reason) stopReason = evt.delta.stop_reason;
        if (evt.usage?.output_tokens != null) {
          usage = usage || { prompt_tokens: 0 };
          usage.completion_tokens = evt.usage.output_tokens;
          usage.total_tokens = (usage.prompt_tokens || 0) + evt.usage.output_tokens;
        }
        break;
      case "message_stop": {
        const finish = stopReason === "tool_use" ? "tool_calls" : stopReason === "max_tokens" ? "length" : "stop";
        yield `data: ${JSON.stringify(chunk({}, finish))}\n\n`;
        yield "data: [DONE]\n\n";
        break;
      }
      default:
        break; // ping, content_block_stop — no OpenAI equivalent needed
    }
  }
}

function anthropicToOpenaiSSE(upstream, opts = {}) {
  const generator = _anthropicToOpenaiEvents(upstream, opts);
  const encoder = new TextEncoder();
  return new ReadableStream({
    async pull(controller) {
      try {
        const { value, done } = await generator.next();
        if (done) {
          controller.close();
          return;
        }
        controller.enqueue(encoder.encode(value));
      } catch (err) {
        controller.error(err);
      }
    },
    async cancel() {
      try { await generator.return(); } catch { /* already finished */ }
    },
  });
}

module.exports = {
  shouldTransform,
  openaiToAnthropicSSE,
  anthropicToOpenaiSSE,
  // Exported for unit tests.
  _openaiToAnthropicEvents,
  _anthropicToOpenaiEvents,
};
