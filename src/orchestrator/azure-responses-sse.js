/**
 * Azure OpenAI Responses API — streaming adapter.
 *
 * The Responses API's streaming event vocabulary (response.created,
 * response.output_item.added, response.content_part.added,
 * response.output_text.delta/.done, response.function_call_arguments.delta/
 * .done, response.output_item.done, response.completed) is structurally
 * different from OpenAI Chat Completions' generic `choices[0].delta` chunk
 * shape, which is what sse-transformer.js's `_openaiToAnthropicEvents`
 * understands.
 *
 * Rather than duplicate that function's Anthropic-SSE emission logic (badge
 * injection, message_start/message_stop, the mid-stream-error and
 * no-finish-reason safety branches, usage extraction) for a second wire
 * format, this module translates Responses-API events into SYNTHETIC OpenAI
 * Chat-Completions SSE TEXT (`data: {"choices":[...]}\n\n`) and hands that
 * off unchanged to the existing, already-tested transformer. Net effect:
 * `invokeAzureOpenAI` returns a stream from this module exactly the way
 * invokeMoonshot/invokeBaidu/invokeOpenAI already return a raw upstream
 * stream — the orchestrator's existing `sseTransform.openaiToAnthropicSSE`
 * call site needs zero changes to consume it.
 *
 * Verified against two live captures from this deployment's actual Azure
 * endpoint (2026-08-26, api-version=2025-04-01-preview, model gpt-5.6-sol):
 * one plain-text response, one forced tool-call response. Re-verify against
 * a live capture if Azure's preview API version changes this shape.
 *
 * Tool-call dedup: the buffered Responses-API conversion in databricks.js
 * (invokeAzureOpenAI) filters out exact duplicate {name, arguments}
 * function-call signatures within one response (an observed GPT-5.x quirk).
 * To preserve that guarantee here without needing the FULL response in hand
 * first, this module buffers a function_call's argument fragments locally
 * (never emitting them) until that call's response.function_call_arguments.done
 * fires, checks the signature, and only then emits the accumulated deltas —
 * as one burst — or silently drops them if it's a repeat. This means
 * function-call arguments have a small, per-call delay (between that call's
 * first and last argument fragment) while text streams fully live with zero
 * delay — a deliberate tradeoff to keep the existing dedup guarantee, not an
 * oversight.
 */

const logger = require("../logger");
const { _sseDataLines } = require("./sse-transformer");

/**
 * @param {ReadableStream|AsyncIterable} rawResponsesStream - raw Azure
 *   Responses API SSE byte stream (stream:true was set on the request).
 * @param {Object} [opts]
 * @param {string} [opts.model] - fallback model id for synthesized chunks.
 * @returns {ReadableStream} synthetic OpenAI Chat-Completions SSE byte stream.
 */
function azureResponsesToOpenAIChunks(rawResponsesStream, opts = {}) {
  const generator = _toOpenAIChunkText(rawResponsesStream, opts);
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

async function* _toOpenAIChunkText(rawResponsesStream, opts) {
  const id = `chatcmpl-azresp-${Date.now()}`;
  const created = Math.floor(Date.now() / 1000);
  const model = opts.model || "gpt-5.6-sol";

  const chunk = (delta, extra = {}) => `data: ${JSON.stringify({
    id, object: "chat.completion.chunk", created, model,
    choices: [{ index: 0, delta, finish_reason: null }],
    ...extra,
  })}\n\n`;

  const finishChunk = (finishReason, usage) => `data: ${JSON.stringify({
    id, object: "chat.completion.chunk", created, model,
    choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
    ...(usage ? { usage } : {}),
  })}\n\n`;

  // output_index -> {kind: "message"|"function_call", openaiToolIndex,
  //   name, callId, argBuf: string}. argBuf only used for function_call.
  const items = new Map();
  let nextToolIndex = 0;
  const seenToolSignatures = new Set();
  let sawFunctionCall = false;
  let sawAnyOutput = false;

  try {
    for await (const payload of _sseDataLines(rawResponsesStream)) {
      if (payload === "[DONE]") break;
      let ev;
      try { ev = JSON.parse(payload); } catch { continue; }

      switch (ev.type) {
        case "response.output_item.added": {
          const item = ev.item || {};
          if (item.type === "function_call") {
            items.set(ev.output_index, {
              kind: "function_call",
              openaiToolIndex: nextToolIndex++,
              name: item.name || "",
              callId: item.call_id || item.id || "",
              argBuf: "",
            });
          } else {
            items.set(ev.output_index, { kind: "message" });
          }
          break;
        }

        case "response.output_text.delta": {
          sawAnyOutput = true;
          if (ev.delta) yield chunk({ content: ev.delta });
          break;
        }

        case "response.function_call_arguments.delta": {
          const state = items.get(ev.output_index);
          if (state && state.kind === "function_call") {
            state.argBuf += ev.delta || "";
          }
          break;
        }

        case "response.function_call_arguments.done": {
          const state = items.get(ev.output_index);
          if (!state || state.kind !== "function_call") break;
          sawAnyOutput = true;
          sawFunctionCall = true;
          const finalArgs = typeof ev.arguments === "string" ? ev.arguments : state.argBuf;
          const signature = `${state.name}:${finalArgs}`;
          if (seenToolSignatures.has(signature)) {
            logger.warn({
              name: state.name,
              argsPreview: finalArgs.slice(0, 120),
            }, "[AzureResponsesSSE] Filtered duplicate streamed tool call");
            break;
          }
          seenToolSignatures.add(signature);
          // First delta for this tool carries id/name (empty arguments);
          // second carries the complete arguments as one fragment — matches
          // real OpenAI streaming shape, which sse-transformer.js's toolAcc
          // merge logic already expects (id/name first-non-null-wins, args
          // concatenated across fragments).
          yield chunk({
            tool_calls: [{
              index: state.openaiToolIndex,
              id: state.callId,
              type: "function",
              function: { name: state.name, arguments: "" },
            }],
          });
          yield chunk({
            tool_calls: [{
              index: state.openaiToolIndex,
              function: { arguments: finalArgs },
            }],
          });
          break;
        }

        case "response.completed": {
          const usageRaw = ev.response?.usage;
          const usage = usageRaw ? {
            prompt_tokens: usageRaw.input_tokens ?? 0,
            completion_tokens: usageRaw.output_tokens ?? 0,
            total_tokens: usageRaw.total_tokens
              ?? ((usageRaw.input_tokens ?? 0) + (usageRaw.output_tokens ?? 0)),
            prompt_tokens_details: {
              cached_tokens: usageRaw.input_tokens_details?.cached_tokens ?? 0,
            },
          } : undefined;
          const finishReason = sawFunctionCall ? "tool_calls" : "stop";
          yield finishChunk(finishReason, usage);
          yield "data: [DONE]\n\n";
          return;
        }

        case "response.failed":
        case "response.incomplete": {
          logger.warn({
            type: ev.type,
            error: ev.response?.error || ev.error || null,
          }, "[AzureResponsesSSE] Upstream reported failure mid-stream");
          // No finish_reason chunk, no [DONE] — matches sse-transformer.js's
          // own no-finish-reason safety branch (its EOF-without-finish_reason
          // case), which synthesizes an Anthropic error event rather than a
          // false-success message_stop when downstream sees the SSE end here.
          return;
        }

        default:
          break; // response.created/.in_progress, content_part.*, output_item.done — no chunk needed
      }
    }
  } catch (err) {
    logger.warn({ err: err.message }, "[AzureResponsesSSE] Upstream stream failed mid-flight");
    return;
  }

  // Stream ended without response.completed and without sawAnyOutput ever
  // firing a finish — same "don't fake success" discipline as above.
  if (!sawAnyOutput) {
    logger.warn("[AzureResponsesSSE] Upstream stream ended with no output and no response.completed");
  }
}

module.exports = {
  azureResponsesToOpenAIChunks,
  // Exported for unit tests.
  _toOpenAIChunkText,
};
