/**
 * Stuck-loop detection (ROUTING-NOTES §4.10.5).
 *
 * Narrow-by-design detector: three identical consecutive assistant tool
 * calls (same name + same input) or three identical assistant text blocks.
 * Legitimate agent behavior — different inputs to the same tool, polls with
 * changing arguments, retry-once — must NOT trip it.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.DATABRICKS_API_KEY = process.env.DATABRICKS_API_KEY || 'test-key';
process.env.DATABRICKS_API_BASE = process.env.DATABRICKS_API_BASE || 'http://test.com';
process.env.LOG_FILE_ENABLED = 'false';

const { detectStuckLoop } = require('../src/routing/stuck-detector');

function assistantToolCall(name, input) {
  return {
    role: 'assistant',
    content: [{ type: 'tool_use', id: `tu_${Math.random().toString(36).slice(2)}`, name, input }],
  };
}

function toolResult(text) {
  return { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_x', content: text }] };
}

function assistantText(text) {
  return { role: 'assistant', content: [{ type: 'text', text }] };
}

function conversation(...turns) {
  return { messages: [{ role: 'user', content: 'do the thing' }, ...turns] };
}

test('three identical consecutive tool calls trip tool_repetition', () => {
  const payload = conversation(
    assistantToolCall('Read', { file: '/a.js' }),
    toolResult('contents'),
    assistantToolCall('Read', { file: '/a.js' }),
    toolResult('contents'),
    assistantToolCall('Read', { file: '/a.js' }),
    toolResult('contents'),
  );
  const result = detectStuckLoop(payload);
  assert.equal(result.stuck, true);
  assert.equal(result.reason, 'tool_repetition');
  assert.equal(result.repeats, 3);
});

test('same tool with DIFFERENT inputs is normal agent behavior — no trip', () => {
  const payload = conversation(
    assistantToolCall('Read', { file: '/a.js' }),
    toolResult('a'),
    assistantToolCall('Read', { file: '/b.js' }),
    toolResult('b'),
    assistantToolCall('Read', { file: '/c.js' }),
    toolResult('c'),
  );
  assert.equal(detectStuckLoop(payload).stuck, false);
});

test('two identical calls (retry-once) do not trip', () => {
  const payload = conversation(
    assistantToolCall('Bash', { cmd: 'npm test' }),
    toolResult('flaky failure'),
    assistantToolCall('Bash', { cmd: 'npm test' }),
    toolResult('pass'),
  );
  assert.equal(detectStuckLoop(payload).stuck, false);
});

test('a loop broken by a different call does not trip (run must be trailing)', () => {
  const payload = conversation(
    assistantToolCall('Read', { file: '/a.js' }),
    toolResult('x'),
    assistantToolCall('Read', { file: '/a.js' }),
    toolResult('x'),
    assistantToolCall('Write', { file: '/a.js', content: 'fixed' }),
    toolResult('ok'),
  );
  assert.equal(detectStuckLoop(payload).stuck, false);
});

test('three identical assistant text blocks trip text_repetition', () => {
  const payload = conversation(
    assistantText('I cannot complete this task.'),
    { role: 'user', content: 'try again' },
    assistantText('I cannot   complete this task.'), // whitespace normalized
    { role: 'user', content: 'please try again' },
    assistantText('I cannot complete this task.'),
  );
  const result = detectStuckLoop(payload);
  assert.equal(result.stuck, true);
  assert.equal(result.reason, 'text_repetition');
});

test('varied assistant text does not trip', () => {
  const payload = conversation(
    assistantText('Reading the file now.'),
    { role: 'user', content: 'ok' },
    assistantText('Found the bug on line 42.'),
    { role: 'user', content: 'fix it' },
    assistantText('Fixed and tests pass.'),
  );
  assert.equal(detectStuckLoop(payload).stuck, false);
});

test('short conversations never trip', () => {
  assert.equal(detectStuckLoop({ messages: [{ role: 'user', content: 'hi' }] }).stuck, false);
  assert.equal(detectStuckLoop({ messages: [] }).stuck, false);
  assert.equal(detectStuckLoop({}).stuck, false);
});

test('detector can be disabled via env', () => {
  process.env.LYNKR_STUCK_DETECTOR_ENABLED = 'false';
  const payload = conversation(
    assistantToolCall('Read', { file: '/a.js' }),
    toolResult('x'),
    assistantToolCall('Read', { file: '/a.js' }),
    toolResult('x'),
    assistantToolCall('Read', { file: '/a.js' }),
    toolResult('x'),
  );
  assert.equal(detectStuckLoop(payload).stuck, false);
  delete process.env.LYNKR_STUCK_DETECTOR_ENABLED;
});

test('repeat threshold is env-tunable', () => {
  process.env.LYNKR_STUCK_TOOL_REPEATS = '2';
  const payload = conversation(
    assistantToolCall('Bash', { cmd: 'npm test' }),
    toolResult('fail'),
    assistantToolCall('Bash', { cmd: 'npm test' }),
    toolResult('fail'),
  );
  assert.equal(detectStuckLoop(payload).stuck, true);
  delete process.env.LYNKR_STUCK_TOOL_REPEATS;
});
