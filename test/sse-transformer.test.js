const { describe, it } = require("node:test");
const assert = require("node:assert");

process.env.MODEL_PROVIDER = "databricks";
process.env.DATABRICKS_API_KEY = process.env.DATABRICKS_API_KEY || "test-key";
process.env.DATABRICKS_API_BASE = process.env.DATABRICKS_API_BASE || "http://test.com";

const {
  shouldTransform,
  openaiToAnthropicSSE,
  anthropicToOpenaiSSE,
} = require("../src/orchestrator/sse-transformer");

// Test knob from the spec: interpose real delays between chunks so
// backpressure/partial-frame bugs can't hide behind synchronous mocks.
const SLOW_UPSTREAM_MS = Number.parseInt(process.env.SLOW_UPSTREAM_MS ?? "5", 10);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Build a web-ReadableStream-like upstream from SSE payload strings. */
function mockUpstream(dataPayloads, { delayMs = SLOW_UPSTREAM_MS, failAfter = null } = {}) {
  const encoder = new TextEncoder();
  let i = 0;
  return new ReadableStream({
    async pull(controller) {
      if (failAfter !== null && i >= failAfter) {
        controller.error(new Error("upstream disconnected"));
        return;
      }
      if (i >= dataPayloads.length) {
        controller.close();
        return;
      }
      if (delayMs > 0) await sleep(delayMs);
      controller.enqueue(encoder.encode(dataPayloads[i]));
      i += 1;
    },
  });
}

async function drainToString(readable) {
  const reader = readable.getReader();
  const decoder = new TextDecoder();
  let out = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  return out;
}

function parseEvents(sseText) {
  const events = [];
  for (const line of sseText.split("\n")) {
    if (line.startsWith("data: ")) {
      const raw = line.slice(6).trim();
      if (raw === "[DONE]") { events.push({ type: "[DONE]" }); continue; }
      events.push(JSON.parse(raw));
    }
  }
  return events;
}

function openaiChunk(delta, { finish = null, usage = null, id = "chatcmpl-1", model = "gpt-test" } = {}) {
  const chunk = { id, object: "chat.completion.chunk", model, choices: [{ index: 0, delta, finish_reason: finish }] };
  if (usage) chunk.usage = usage;
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

describe("SSE Transformer (OpenAI → Anthropic)", () => {
  it("emits message_start on first chunk and message_stop after [DONE]", async () => {
    const upstream = mockUpstream([
      openaiChunk({ role: "assistant", content: "Hi" }),
      openaiChunk({}, { finish: "stop" }),
      "data: [DONE]\n\n",
    ]);
    const events = parseEvents(await drainToString(openaiToAnthropicSSE(upstream)));

    assert.strictEqual(events[0].type, "message_start");
    assert.strictEqual(events[0].message.role, "assistant");
    assert.strictEqual(events.at(-1).type, "message_stop");
  });

  it("streams text deltas per chunk inside one text block", async () => {
    const upstream = mockUpstream([
      openaiChunk({ content: "Hello " }),
      openaiChunk({ content: "world" }),
      openaiChunk({}, { finish: "stop" }),
      "data: [DONE]\n\n",
    ]);
    const events = parseEvents(await drainToString(openaiToAnthropicSSE(upstream)));

    const starts = events.filter((e) => e.type === "content_block_start");
    const deltas = events.filter((e) => e.type === "content_block_delta");
    assert.strictEqual(starts.length, 1);
    assert.strictEqual(starts[0].content_block.type, "text");
    assert.deepStrictEqual(deltas.map((d) => d.delta.text), ["Hello ", "world"]);
  });

  it("accumulates tool-call argument fragments across chunks into one clean block", async () => {
    // The spec's exact scenario: arguments split mid-JSON-string across chunks.
    const upstream = mockUpstream([
      openaiChunk({ tool_calls: [{ index: 0, id: "call_abc", type: "function", function: { name: "Write", arguments: "" } }] }),
      openaiChunk({ tool_calls: [{ index: 0, function: { arguments: "{\"filena" } }] }),
      openaiChunk({ tool_calls: [{ index: 0, function: { arguments: "me\": \"x.js\"}" } }] }),
      openaiChunk({}, { finish: "tool_calls" }),
      "data: [DONE]\n\n",
    ]);
    const events = parseEvents(await drainToString(openaiToAnthropicSSE(upstream)));

    const toolStarts = events.filter((e) => e.type === "content_block_start" && e.content_block.type === "tool_use");
    assert.strictEqual(toolStarts.length, 1, "exactly one tool_use block");
    assert.strictEqual(toolStarts[0].content_block.id, "call_abc");
    assert.strictEqual(toolStarts[0].content_block.name, "Write");

    const jsonDeltas = events.filter((e) => e.type === "content_block_delta" && e.delta.type === "input_json_delta");
    assert.strictEqual(jsonDeltas.length, 1);
    assert.strictEqual(jsonDeltas[0].delta.partial_json, '{"filename": "x.js"}');
    assert.deepStrictEqual(JSON.parse(jsonDeltas[0].delta.partial_json), { filename: "x.js" });

    const messageDelta = events.find((e) => e.type === "message_delta");
    assert.strictEqual(messageDelta.delta.stop_reason, "tool_use");
  });

  it("handles multiple parallel tool calls without mixing fragments", async () => {
    const upstream = mockUpstream([
      openaiChunk({ tool_calls: [{ index: 0, id: "call_a", function: { name: "Read", arguments: "{\"pa" } }] }),
      openaiChunk({ tool_calls: [{ index: 1, id: "call_b", function: { name: "Bash", arguments: "{\"com" } }] }),
      openaiChunk({ tool_calls: [{ index: 0, function: { arguments: "th\": \"a.js\"}" } }] }),
      openaiChunk({ tool_calls: [{ index: 1, function: { arguments: "mand\": \"ls\"}" } }] }),
      openaiChunk({}, { finish: "tool_calls" }),
      "data: [DONE]\n\n",
    ]);
    const events = parseEvents(await drainToString(openaiToAnthropicSSE(upstream)));

    const jsonDeltas = events.filter((e) => e.type === "content_block_delta" && e.delta.type === "input_json_delta");
    assert.strictEqual(jsonDeltas.length, 2);
    assert.deepStrictEqual(JSON.parse(jsonDeltas[0].delta.partial_json), { path: "a.js" });
    assert.deepStrictEqual(JSON.parse(jsonDeltas[1].delta.partial_json), { command: "ls" });
  });

  it("converts OpenAI usage to Anthropic usage at message_delta", async () => {
    const upstream = mockUpstream([
      openaiChunk({ content: "ok" }),
      openaiChunk({}, { finish: "stop", usage: { prompt_tokens: 42, completion_tokens: 7, total_tokens: 49 } }),
      "data: [DONE]\n\n",
    ]);
    const events = parseEvents(await drainToString(openaiToAnthropicSSE(upstream)));

    const messageDelta = events.find((e) => e.type === "message_delta");
    assert.strictEqual(messageDelta.usage.output_tokens, 7);
  });

  it("reports usage and tool stats to the onClose finalizer", async () => {
    let closed = null;
    const upstream = mockUpstream([
      openaiChunk({ tool_calls: [{ index: 0, id: "c1", function: { name: "Grep", arguments: "{\"q\":\"x\"}" } }] }),
      openaiChunk({}, { finish: "tool_calls", usage: { prompt_tokens: 10, completion_tokens: 3 } }),
      "data: [DONE]\n\n",
    ]);
    await drainToString(openaiToAnthropicSSE(upstream, { onClose: (stats) => { closed = stats; } }));

    assert.ok(closed, "onClose fired");
    assert.strictEqual(closed.usage.input_tokens, 10);
    assert.strictEqual(closed.usage.output_tokens, 3);
    assert.deepStrictEqual(closed.toolCalls.map((t) => t.name), ["Grep"]);
    assert.strictEqual(closed.stopReason, "tool_use");
  });

  it("splits SSE frames that arrive fragmented across TCP chunks", async () => {
    const full = openaiChunk({ content: "fragmented" }) + openaiChunk({}, { finish: "stop" }) + "data: [DONE]\n\n";
    // Slice the byte stream at awkward boundaries (mid-line, mid-JSON).
    const pieces = [full.slice(0, 17), full.slice(17, 45), full.slice(45, 46), full.slice(46)];
    const events = parseEvents(await drainToString(openaiToAnthropicSSE(mockUpstream(pieces))));

    const delta = events.find((e) => e.type === "content_block_delta");
    assert.strictEqual(delta.delta.text, "fragmented");
    assert.strictEqual(events.at(-1).type, "message_stop");
  });

  it("surfaces a mid-stream upstream failure as an SSE error event, not a hang", async () => {
    const upstream = mockUpstream(
      [openaiChunk({ content: "partial " }), openaiChunk({ content: "answer" })],
      { failAfter: 2 },
    );
    const events = parseEvents(await drainToString(openaiToAnthropicSSE(upstream)));

    assert.ok(events.some((e) => e.type === "error"), "error event emitted");
    assert.ok(!events.some((e) => e.type === "message_stop"), "no fake completion after failure");
  });

  it("maps finish_reason length → max_tokens", async () => {
    const upstream = mockUpstream([
      openaiChunk({ content: "trunc" }),
      openaiChunk({}, { finish: "length" }),
      "data: [DONE]\n\n",
    ]);
    const events = parseEvents(await drainToString(openaiToAnthropicSSE(upstream)));
    assert.strictEqual(events.find((e) => e.type === "message_delta").delta.stop_reason, "max_tokens");
  });

  it("emits the routing badge as the first content block after message_start", async () => {
    const upstream = mockUpstream([
      openaiChunk({ content: "hello" }),
      openaiChunk({}, { finish: "stop" }),
      "data: [DONE]\n\n",
    ]);
    const events = parseEvents(await drainToString(openaiToAnthropicSSE(upstream, { badgeText: "*[Lynkr] SIMPLE → ornith (llamacpp)*\n\n" })));

    assert.strictEqual(events[0].type, "message_start");
    assert.strictEqual(events[1].type, "content_block_start");
    const badgeDelta = events[2];
    assert.strictEqual(badgeDelta.delta.text, "*[Lynkr] SIMPLE → ornith (llamacpp)*\n\n");
    assert.strictEqual(events[3].type, "content_block_stop");
    // Upstream text lands in the NEXT block with a distinct index.
    const textDelta = events.find((e) => e.type === "content_block_delta" && e.delta.text === "hello");
    assert.ok(textDelta, "upstream text still streams");
    assert.notStrictEqual(textDelta.index, badgeDelta.index, "badge and text use distinct block indices");
  });

  it("keeps 10 concurrent streams isolated (no cross-stream state leakage)", async () => {
    const runs = await Promise.all(
      Array.from({ length: 10 }, (_, i) => {
        const upstream = mockUpstream([
          openaiChunk({ content: `stream-${i}-text` }, { id: `chatcmpl-${i}` }),
          openaiChunk({ tool_calls: [{ index: 0, id: `call_${i}`, function: { name: `tool_${i}`, arguments: `{"n":${i}}` } }] }),
          openaiChunk({}, { finish: "tool_calls" }),
          "data: [DONE]\n\n",
        ], { delayMs: 1 + (i % 3) });
        return drainToString(openaiToAnthropicSSE(upstream)).then(parseEvents);
      }),
    );

    runs.forEach((events, i) => {
      const text = events.find((e) => e.type === "content_block_delta" && e.delta.type === "text_delta");
      assert.strictEqual(text.delta.text, `stream-${i}-text`);
      const tool = events.find((e) => e.type === "content_block_start" && e.content_block.type === "tool_use");
      assert.strictEqual(tool.content_block.name, `tool_${i}`);
      const args = events.find((e) => e.delta?.type === "input_json_delta");
      assert.deepStrictEqual(JSON.parse(args.delta.partial_json), { n: i });
    });
  });
});

describe("SSE Transformer (Anthropic → OpenAI, symmetric direction)", () => {
  it("round-trips text and tool_use into OpenAI chunk shape", async () => {
    const anthropicEvents = [
      `data: ${JSON.stringify({ type: "message_start", message: { id: "msg_1", usage: { input_tokens: 5 } } })}\n\n`,
      `data: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}\n\n`,
      `data: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hey" } })}\n\n`,
      `data: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`,
      `data: ${JSON.stringify({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_1", name: "Write", input: {} } })}\n\n`,
      `data: ${JSON.stringify({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"f":1}' } })}\n\n`,
      `data: ${JSON.stringify({ type: "content_block_stop", index: 1 })}\n\n`,
      `data: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 9 } })}\n\n`,
      `data: ${JSON.stringify({ type: "message_stop" })}\n\n`,
    ];
    const out = await drainToString(anthropicToOpenaiSSE(mockUpstream(anthropicEvents)));
    const events = parseEvents(out);

    assert.strictEqual(events[0].choices[0].delta.role, "assistant");
    assert.ok(events.some((e) => e.choices?.[0]?.delta?.content === "hey"));
    const toolStart = events.find((e) => e.choices?.[0]?.delta?.tool_calls?.[0]?.function?.name === "Write");
    assert.ok(toolStart, "tool call delta emitted");
    const finish = events.find((e) => e.choices?.[0]?.finish_reason);
    assert.strictEqual(finish.choices[0].finish_reason, "tool_calls");
    assert.strictEqual(finish.usage.completion_tokens, 9);
    assert.strictEqual(events.at(-1).type, "[DONE]");
  });
});

describe("shouldTransform gating", () => {
  it("is on by default, with LYNKR_STREAM_TRANSFORM=false as the kill switch", () => {
    const prev = process.env.LYNKR_STREAM_TRANSFORM;
    try {
      delete process.env.LYNKR_STREAM_TRANSFORM;
      assert.strictEqual(shouldTransform(true, "openai"), true, "default on");
      assert.strictEqual(shouldTransform(false, "openai"), false, "non-stream request");
      assert.strictEqual(shouldTransform(true, "azure-anthropic"), false, "anthropic-native handled by 2a");
      assert.strictEqual(shouldTransform(true, "ollama"), false, "ollama streams via 2a, not the transformer");

      process.env.LYNKR_STREAM_TRANSFORM = "false";
      assert.strictEqual(shouldTransform(true, "openai"), false, "kill switch");
    } finally {
      if (prev === undefined) delete process.env.LYNKR_STREAM_TRANSFORM;
      else process.env.LYNKR_STREAM_TRANSFORM = prev;
    }
  });
});
