/**
 * WS6 — response verifier. Fixtures reproduce failures observed live from
 * the cheap tier (minimax) during July 2026 sessions.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { verify, _internal } = require('../src/routing/verifier');

const ask = (text) => ({ messages: [{ role: 'user', content: text }] });
const answer = (text, extra = {}) => ({
  content: [{ type: 'text', text }],
  stop_reason: 'end_turn',
  ...extra,
});

// ---------------------------------------------------------------------------
// Language drift — live incident: "+统一接口:" mid-English refactor plan
// ---------------------------------------------------------------------------

test('drift: sustained CJK in an English conversation fails', () => {
  const r = verify({
    payload: ask('Give me a plan to refactor the clients module'),
    responseBody: answer('Extract clients into adapter pattern\n  +统一接口: { chat(completion), embed(), health() }\n然后我们可以统一处理所有提供商'),
  });
  assert.equal(r.verdict, 'fail');
  assert.ok(r.reasons.some((x) => x.includes('language-drift')), r.reasons.join());
});

test('drift: a quoted foreign identifier does not fail', () => {
  const r = verify({
    payload: ask('What does the variable in this file mean?'),
    responseBody: answer('The variable 名前 holds the display name; everything else is standard config handling. It is read once at startup and cached.'),
  });
  assert.equal(r.verdict, 'pass', r.reasons.join());
});

test('drift: user writing Chinese gets Chinese answers without complaint', () => {
  const r = verify({
    payload: ask('请解释这个函数的作用'),
    responseBody: answer('这个函数用于重试失败的调用，最多尝试三次。'),
  });
  assert.equal(r.verdict, 'pass', r.reasons.join());
});

// ---------------------------------------------------------------------------
// Degeneration
// ---------------------------------------------------------------------------

test('degeneration: repetition loop fails', () => {
  const loop = 'the fix is to check the null case and '.repeat(30);
  const r = verify({ payload: ask('How do I fix this crash in the parser module?'), responseBody: answer(loop) });
  assert.equal(r.verdict, 'fail');
  assert.ok(r.reasons.some((x) => x.includes('degeneration')), r.reasons.join());
});

test('degeneration: a normal list with repeated stems passes', () => {
  const text = [
    'Steps to migrate:',
    '- Update the config loader to read the new field',
    '- Update the router to consume it',
    '- Update the tests to cover both paths',
    '- Update the docs with the new variable',
    'Each update is independent and can ship separately. Roll forward one module at a time and keep the legacy field until every consumer reads the new one.',
  ].join('\n');
  const r = verify({ payload: ask('List the steps to migrate the config field'), responseBody: answer(text) });
  assert.equal(r.verdict, 'pass', r.reasons.join());
});

// ---------------------------------------------------------------------------
// Truncation
// ---------------------------------------------------------------------------

test('truncation: max_tokens inside an open code fence fails', () => {
  const r = verify({
    payload: ask('Write the replacement retry function'),
    responseBody: answer('Here is the replacement:\n```js\nfunction retry(fn, attempts) {\n  let delay = 100;\n  for (', { stop_reason: 'max_tokens' }),
  });
  assert.equal(r.verdict, 'fail');
  assert.ok(r.reasons.some((x) => x.includes('truncation')), r.reasons.join());
});

test('truncation: max_tokens with closed fences passes (long but complete-ish)', () => {
  const r = verify({
    payload: ask('Explain the module structure in detail with an example'),
    responseBody: answer('The structure is layered.\n```js\nconst x = 1;\n```\nThere is more to say about each layer, starting with the transport which handles', { stop_reason: 'max_tokens' }),
  });
  assert.equal(r.verdict, 'pass', r.reasons.join());
});

// ---------------------------------------------------------------------------
// Malformed tool calls — live symptom: "Invalid tool parameters"
// ---------------------------------------------------------------------------

test('tool calls: string input fails', () => {
  const r = verify({
    payload: ask('read the readme'),
    responseBody: { content: [{ type: 'tool_use', id: 't1', name: 'Read', input: 'README.md' }], stop_reason: 'tool_use' },
  });
  assert.equal(r.verdict, 'fail');
  assert.ok(r.reasons.some((x) => x.includes('malformed-tool-call')), r.reasons.join());
});

test('tool calls: well-formed tool_use passes with no prose', () => {
  const r = verify({
    payload: ask('read the readme'),
    responseBody: { content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'README.md' } }], stop_reason: 'tool_use' },
  });
  assert.equal(r.verdict, 'pass', r.reasons.join());
});

// ---------------------------------------------------------------------------
// Empty / echo
// ---------------------------------------------------------------------------

test('empty response fails', () => {
  const r = verify({ payload: ask('Summarize the routing module'), responseBody: answer('') });
  assert.equal(r.verdict, 'fail');
  assert.ok(r.reasons.some((x) => x.includes('empty')), r.reasons.join());
});

test('prompt echo fails', () => {
  const q = 'Explain how the semantic cache decides whether two prompts are similar enough to match';
  const r = verify({ payload: ask(q), responseBody: answer(q) });
  assert.equal(r.verdict, 'fail');
  assert.ok(r.reasons.some((x) => x.includes('echo')), r.reasons.join());
});

// ---------------------------------------------------------------------------
// Layer 2 — content score
// ---------------------------------------------------------------------------

test('stub answer to a substantive ask fails on content score', () => {
  const r = verify({
    payload: ask('Review this retry helper for bugs and race conditions, weigh the trade-offs versus exponential backoff with jitter, and recommend a replacement with detailed reasoning about failure modes under concurrent load.'),
    responseBody: answer('Looks fine to me.'),
  });
  assert.equal(r.verdict, 'fail');
  assert.ok(r.reasons.some((x) => x.includes('low-content-score')), r.reasons.join());
});

test('structured answer to a structured ask passes with healthy score', () => {
  const r = verify({
    payload: ask('Compare the two caches and list the trade-offs'),
    responseBody: answer('Comparison:\n- Semantic cache: matches by meaning, sub-300ms hits, risk of near-miss matches\n- Prompt cache: provider-side, exact-prefix, free latency win\nTrade-offs: semantic saves whole responses but needs an embedder; prompt caching needs stable prefixes. Use both — they compose.'),
  });
  assert.equal(r.verdict, 'pass', r.reasons.join());
  assert.ok(r.score >= 60, `score ${r.score}`);
});

test('Codex environment_context merged into a trivial prompt does not fail the short answer', () => {
  // Live incident 2026-07-11: "Hi" merged with Codex's <environment_context>
  // (containing "claude-code" and access="write") scored 10 and escalated
  // every trivial Codex turn from SIMPLE to COMPLEX.
  const envBlock = '<environment_context>\n<cwd>/Users/x/claude-code</cwd>'
    + '<permission_profile type="managed"><entry access="write"><path>/Users/x/claude-code</path></entry></permission_profile>'.padEnd(400, ' ')
    + '</environment_context>';
  const r = verify({
    payload: ask(envBlock + '\n\nHi'),
    responseBody: answer('Hi! What can I help you with today?'),
  });
  assert.equal(r.verdict, 'pass', r.reasons.join());
});

test('goose turn-context wrapped around a trivial prompt does not fail the short answer', () => {
  // Live incident 2026-07-13: goose wraps every typed message in a
  // <turn-context> block (time, cwd, todo notes) — 275+ chars that made
  // "Hi" look like a substantive ask, so minimax's greeting scored 25 and
  // every trivial goose turn escalated MEDIUM→COMPLEX (Azure).
  const turnContext = '<turn-context>\n<current-time>2026-07-13 15:21:00</current-time>\n'
    + '<working-directory>/Users/x/claude-code</working-directory>\n\n'
    + 'Current tasks and notes:\nOnce given a task, immediately update your todo with all explicit and implicit requirements\n'
    + '</turn-context>';
  const r = verify({
    payload: ask(turnContext + '\nHi'),
    responseBody: answer('Hi! What can I help you with today?'),
  });
  assert.equal(r.verdict, 'pass', r.reasons.join());
});

// ---------------------------------------------------------------------------
// Fail-open contract
// ---------------------------------------------------------------------------

test('never throws: garbage inputs return pass', () => {
  assert.equal(verify({ payload: null, responseBody: null }).verdict, 'pass');
  assert.equal(verify({}).verdict, 'pass');
  assert.equal(verify({ payload: { messages: 'x' }, responseBody: { content: 42 } }).verdict, 'pass');
});
