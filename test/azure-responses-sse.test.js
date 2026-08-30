/**
 * Azure OpenAI Responses API streaming adapter — regression tests.
 *
 * Fixtures below are VERBATIM captures from a live request against this
 * deployment's actual Azure endpoint (2026-08-26, api-version=
 * 2025-04-01-preview, model gpt-5.6-sol) — a plain-text response and a
 * forced tool-call response. Not synthetic/hand-built payloads: if Azure
 * changes this event shape, re-capture rather than hand-edit these.
 */
const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { azureResponsesToOpenAIChunks, _toOpenAIChunkText } = require('../src/orchestrator/azure-responses-sse');
const { _openaiToAnthropicEvents } = require('../src/orchestrator/sse-transformer');

const TEXT_FIXTURE = `event: response.created
data: {"type":"response.created","response":{"id":"resp_0c6f54e263876a2e006a8fb61175888190ba969326864f1ea2","object":"response","created_at":1787803153,"status":"in_progress","output":[],"usage":null},"sequence_number":0}

event: response.in_progress
data: {"type":"response.in_progress","response":{"id":"resp_0c6f54e263876a2e006a8fb61175888190ba969326864f1ea2","status":"in_progress","output":[],"usage":null},"sequence_number":1}

event: response.output_item.added
data: {"type":"response.output_item.added","item":{"id":"msg_0c6f54e263876a2e006a8fb61204288190a3870ff794a0f9da","type":"message","status":"in_progress","content":[],"role":"assistant"},"output_index":0,"sequence_number":2}

event: response.content_part.added
data: {"type":"response.content_part.added","content_index":0,"item_id":"msg_0c6f54e263876a2e006a8fb61204288190a3870ff794a0f9da","output_index":0,"part":{"type":"output_text","text":""},"sequence_number":3}

event: response.output_text.delta
data: {"type":"response.output_text.delta","content_index":0,"delta":"banana","item_id":"msg_0c6f54e263876a2e006a8fb61204288190a3870ff794a0f9da","output_index":0,"sequence_number":4}

event: response.output_text.done
data: {"type":"response.output_text.done","content_index":0,"item_id":"msg_0c6f54e263876a2e006a8fb61204288190a3870ff794a0f9da","output_index":0,"sequence_number":5,"text":"banana"}

event: response.content_part.done
data: {"type":"response.content_part.done","content_index":0,"item_id":"msg_0c6f54e263876a2e006a8fb61204288190a3870ff794a0f9da","output_index":0,"part":{"type":"output_text","text":"banana"},"sequence_number":6}

event: response.output_item.done
data: {"type":"response.output_item.done","item":{"id":"msg_0c6f54e263876a2e006a8fb61204288190a3870ff794a0f9da","type":"message","status":"completed","content":[{"type":"output_text","text":"banana"}],"role":"assistant"},"output_index":0,"sequence_number":7}

event: response.completed
data: {"type":"response.completed","response":{"id":"resp_0c6f54e263876a2e006a8fb61175888190ba969326864f1ea2","status":"completed","output":[{"id":"msg_0c6f54e263876a2e006a8fb61204288190a3870ff794a0f9da","type":"message","status":"completed","content":[{"type":"output_text","text":"banana"}],"role":"assistant"}],"usage":{"input_tokens":14,"input_tokens_details":{"cache_write_tokens":0,"cached_tokens":0},"output_tokens":5,"output_tokens_details":{"reasoning_tokens":0},"total_tokens":19}},"sequence_number":8}

`;

const TOOLCALL_FIXTURE = `event: response.created
data: {"type":"response.created","response":{"id":"resp_0666285fb13ce6f8006a8fb6470cf48194be1c7472353dabc4","status":"in_progress","output":[],"usage":null},"sequence_number":0}

event: response.in_progress
data: {"type":"response.in_progress","response":{"id":"resp_0666285fb13ce6f8006a8fb6470cf48194be1c7472353dabc4","status":"in_progress","output":[],"usage":null},"sequence_number":1}

event: response.output_item.added
data: {"type":"response.output_item.added","item":{"id":"fc_0666285fb13ce6f8006a8fb64849a08194a57868782e3654a2","type":"function_call","status":"in_progress","arguments":"","call_id":"call_GJVC5hJMlt5zONEzCXHo8dij","name":"calculator"},"output_index":0,"sequence_number":2}

event: response.function_call_arguments.delta
data: {"type":"response.function_call_arguments.delta","delta":"{\\"","item_id":"fc_0666285fb13ce6f8006a8fb64849a08194a57868782e3654a2","output_index":0,"sequence_number":3}

event: response.function_call_arguments.delta
data: {"type":"response.function_call_arguments.delta","delta":"a","item_id":"fc_0666285fb13ce6f8006a8fb64849a08194a57868782e3654a2","output_index":0,"sequence_number":4}

event: response.function_call_arguments.delta
data: {"type":"response.function_call_arguments.delta","delta":"\\":","item_id":"fc_0666285fb13ce6f8006a8fb64849a08194a57868782e3654a2","output_index":0,"sequence_number":5}

event: response.function_call_arguments.delta
data: {"type":"response.function_call_arguments.delta","delta":"918","item_id":"fc_0666285fb13ce6f8006a8fb64849a08194a57868782e3654a2","output_index":0,"sequence_number":6}

event: response.function_call_arguments.delta
data: {"type":"response.function_call_arguments.delta","delta":"21","item_id":"fc_0666285fb13ce6f8006a8fb64849a08194a57868782e3654a2","output_index":0,"sequence_number":7}

event: response.function_call_arguments.delta
data: {"type":"response.function_call_arguments.delta","delta":",\\"","item_id":"fc_0666285fb13ce6f8006a8fb64849a08194a57868782e3654a2","output_index":0,"sequence_number":8}

event: response.function_call_arguments.delta
data: {"type":"response.function_call_arguments.delta","delta":"b","item_id":"fc_0666285fb13ce6f8006a8fb64849a08194a57868782e3654a2","output_index":0,"sequence_number":9}

event: response.function_call_arguments.delta
data: {"type":"response.function_call_arguments.delta","delta":"\\":","item_id":"fc_0666285fb13ce6f8006a8fb64849a08194a57868782e3654a2","output_index":0,"sequence_number":10}

event: response.function_call_arguments.delta
data: {"type":"response.function_call_arguments.delta","delta":"3","item_id":"fc_0666285fb13ce6f8006a8fb64849a08194a57868782e3654a2","output_index":0,"sequence_number":11}

event: response.function_call_arguments.delta
data: {"type":"response.function_call_arguments.delta","delta":"}","item_id":"fc_0666285fb13ce6f8006a8fb64849a08194a57868782e3654a2","output_index":0,"sequence_number":12}

event: response.function_call_arguments.done
data: {"type":"response.function_call_arguments.done","arguments":"{\\"a\\":91821,\\"b\\":3}","item_id":"fc_0666285fb13ce6f8006a8fb64849a08194a57868782e3654a2","output_index":0,"sequence_number":13}

event: response.output_item.done
data: {"type":"response.output_item.done","item":{"id":"fc_0666285fb13ce6f8006a8fb64849a08194a57868782e3654a2","type":"function_call","status":"completed","arguments":"{\\"a\\":91821,\\"b\\":3}","call_id":"call_GJVC5hJMlt5zONEzCXHo8dij","name":"calculator"},"output_index":0,"sequence_number":14}

event: response.completed
data: {"type":"response.completed","response":{"id":"resp_0666285fb13ce6f8006a8fb6470cf48194be1c7472353dabc4","status":"completed","output":[{"id":"fc_0666285fb13ce6f8006a8fb64849a08194a57868782e3654a2","type":"function_call","status":"completed","arguments":"{\\"a\\":91821,\\"b\\":3}","call_id":"call_GJVC5hJMlt5zONEzCXHo8dij","name":"calculator"}],"usage":{"input_tokens":63,"input_tokens_details":{"cache_write_tokens":0,"cached_tokens":0},"output_tokens":23,"output_tokens_details":{"reasoning_tokens":0},"total_tokens":86}},"sequence_number":15}

`;

async function collect(asyncGen) {
  const out = [];
  for await (const v of asyncGen) out.push(v);
  return out;
}

function textStreamFrom(str) {
  return (async function* () { yield new TextEncoder().encode(str); })();
}

describe('azureResponsesToOpenAIChunks — Responses API -> OpenAI chunk shape', () => {
  it('text response: emits content deltas and a stop finish with usage', async () => {
    const chunks = await collect(_toOpenAIChunkText(textStreamFrom(TEXT_FIXTURE), { model: 'gpt-5.6-sol' }));
    const parsed = chunks
      .filter((c) => c.startsWith('data: ') && !c.includes('[DONE]'))
      .map((c) => JSON.parse(c.slice(6)));

    const contentDeltas = parsed.filter((c) => c.choices[0].delta.content);
    assert.equal(contentDeltas.map((c) => c.choices[0].delta.content).join(''), 'banana');

    const last = parsed[parsed.length - 1];
    assert.equal(last.choices[0].finish_reason, 'stop');
    assert.equal(last.usage.prompt_tokens, 14);
    assert.equal(last.usage.completion_tokens, 5);
    assert.equal(last.usage.total_tokens, 19);

    assert.ok(chunks.some((c) => c.includes('[DONE]')));
  });

  it('tool-call response: emits one complete tool_calls delta pair with correct args and finish_reason tool_calls', async () => {
    const chunks = await collect(_toOpenAIChunkText(textStreamFrom(TOOLCALL_FIXTURE), { model: 'gpt-5.6-sol' }));
    const parsed = chunks
      .filter((c) => c.startsWith('data: ') && !c.includes('[DONE]'))
      .map((c) => JSON.parse(c.slice(6)));

    const toolChunks = parsed.filter((c) => c.choices[0].delta.tool_calls);
    assert.equal(toolChunks.length, 2, 'expected exactly one id/name chunk + one args chunk');
    assert.equal(toolChunks[0].choices[0].delta.tool_calls[0].function.name, 'calculator');
    assert.equal(toolChunks[0].choices[0].delta.tool_calls[0].id, 'call_GJVC5hJMlt5zONEzCXHo8dij');
    assert.equal(toolChunks[1].choices[0].delta.tool_calls[0].function.arguments, '{"a":91821,"b":3}');

    const last = parsed[parsed.length - 1];
    assert.equal(last.choices[0].finish_reason, 'tool_calls');
    assert.equal(last.usage.prompt_tokens, 63);
    assert.equal(last.usage.completion_tokens, 23);
  });

  it('drops a duplicate tool-call signature within one response', async () => {
    // Same function_call_arguments.done fired twice for the same item — the
    // real observed GPT-5.x quirk the buffered path's dedup was built for.
    const duped = TOOLCALL_FIXTURE.replace(
      'event: response.completed',
      `event: response.function_call_arguments.done
data: {"type":"response.function_call_arguments.done","arguments":"{\\"a\\":91821,\\"b\\":3}","item_id":"fc_0666285fb13ce6f8006a8fb64849a08194a57868782e3654a2","output_index":0,"sequence_number":13}

event: response.completed`,
    );
    const chunks = await collect(_toOpenAIChunkText(textStreamFrom(duped), { model: 'gpt-5.6-sol' }));
    const parsed = chunks
      .filter((c) => c.startsWith('data: ') && !c.includes('[DONE]'))
      .map((c) => JSON.parse(c.slice(6)));
    const toolChunks = parsed.filter((c) => c.choices[0].delta.tool_calls);
    // Still exactly one id/name + one args pair — the repeat was dropped, not duplicated.
    assert.equal(toolChunks.length, 2);
  });

  it('mid-stream response.failed does not emit a false-success finish/[DONE]', async () => {
    const failed = TEXT_FIXTURE
      .split('event: response.completed')[0]
      + 'event: response.failed\ndata: {"type":"response.failed","response":{"error":{"message":"boom"}}}\n\n';
    const chunks = await collect(_toOpenAIChunkText(textStreamFrom(failed), { model: 'gpt-5.6-sol' }));
    assert.ok(!chunks.some((c) => c.includes('[DONE]')), 'must not fake a clean completion');
  });

  it('produces a real ReadableStream via azureResponsesToOpenAIChunks', async () => {
    const stream = azureResponsesToOpenAIChunks(textStreamFrom(TEXT_FIXTURE), { model: 'gpt-5.6-sol' });
    assert.equal(typeof stream.getReader, 'function');
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let text = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value);
    }
    assert.ok(text.includes('banana'));
    assert.ok(text.includes('[DONE]'));
  });
});

describe('azure-responses-sse -> sse-transformer end-to-end (Anthropic SSE)', () => {
  it('text response reshapes into a valid Anthropic content_block_delta stream', async () => {
    const openaiStream = azureResponsesToOpenAIChunks(textStreamFrom(TEXT_FIXTURE), { model: 'gpt-5.6-sol' });
    const anthropicEvents = await collect(_openaiToAnthropicEvents(openaiStream, { model: 'gpt-5.6-sol' }));
    const text = anthropicEvents.join('');
    assert.ok(text.includes('"type":"message_start"'));
    assert.ok(text.includes('banana'));
    assert.ok(text.includes('"type":"message_stop"'));
    // usage should have made it all the way through
    assert.ok(text.includes('"output_tokens":5') || text.includes('output_tokens": 5'));
  });

  it('tool-call response reshapes into a single complete Anthropic tool_use block', async () => {
    const openaiStream = azureResponsesToOpenAIChunks(textStreamFrom(TOOLCALL_FIXTURE), { model: 'gpt-5.6-sol' });
    const anthropicEvents = await collect(_openaiToAnthropicEvents(openaiStream, { model: 'gpt-5.6-sol' }));
    const text = anthropicEvents.join('');
    assert.ok(text.includes('"type":"tool_use"'));
    assert.ok(text.includes('calculator'));
    // Anthropic clients must never see partial tool JSON — full args in one shot.
    assert.ok(text.includes('{\\"a\\":91821,\\"b\\":3}') || text.includes('"a":91821'));
  });
});
