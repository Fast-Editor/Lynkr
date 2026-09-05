/**
 * Budget-driven history compression + tool-boundary alignment.
 *
 * Live incident: a 935-message session against a 128k-context model was
 * compressed to a fixed 10 recent messages (~56k tokens) while the model's
 * effective budget was 108.8k — roughly 50k tokens of usable context thrown
 * away, giving the agent amnesia about its own recent edits. compressHistory
 * now grows the verbatim-recent window to use the provided token budget.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.DATABRICKS_API_KEY = process.env.DATABRICKS_API_KEY || 'test-key';
process.env.DATABRICKS_API_BASE = process.env.DATABRICKS_API_BASE || 'http://test.com';
process.env.LOG_FILE_ENABLED = 'false';

const { compressHistory } = require('../src/context/compression');

function textMsg(role, chars) {
  return { role, content: 'x'.repeat(chars) };
}

function conversation(n, charsEach = 1000) {
  const messages = [];
  for (let i = 0; i < n; i++) {
    messages.push(textMsg(i % 2 === 0 ? 'user' : 'assistant', charsEach));
  }
  return messages;
}

test('without a budget, behavior is unchanged: fixed keepRecentTurns window', () => {
  const messages = conversation(100);
  const out = compressHistory(messages, { keepRecentTurns: 10, summarizeOlder: true, enabled: true });
  // 1 summary block + 10 recent messages.
  assert.equal(out.length, 11);
});

test('with a large budget, the recent window grows far beyond 10 messages', () => {
  const messages = conversation(100, 1000); // ~1050 chars/msg with overhead
  // 100k-token budget → 60% × 4 chars/token = 240k chars of recent window —
  // enough for ALL 100 messages (≈105k chars): no compression should occur.
  const out = compressHistory(messages, {
    keepRecentTurns: 10,
    summarizeOlder: true,
    enabled: true,
    budgetTokens: 100_000,
  });
  assert.equal(out.length, 100, 'everything fits the budget — nothing summarized');
});

test('with a budget that fits ~half the messages, the window is budget-sized, not 10', () => {
  const messages = conversation(100, 1000);
  // 25k tokens → 60% × 4 = 60k chars target → ~57 recent messages kept.
  const out = compressHistory(messages, {
    keepRecentTurns: 10,
    summarizeOlder: true,
    enabled: true,
    budgetTokens: 25_000,
  });
  const kept = out.length - 1; // minus the summary block
  assert.ok(kept > 40 && kept < 70, `expected ~57 recent messages kept, got ${kept}`);
  assert.ok(kept > 10, 'must keep more than the fixed floor when budget allows');
});

test('a tiny budget never shrinks the window below keepRecentTurns', () => {
  const messages = conversation(100, 1000);
  const out = compressHistory(messages, {
    keepRecentTurns: 10,
    summarizeOlder: true,
    enabled: true,
    budgetTokens: 100, // absurdly small
  });
  const kept = out.length - 1;
  assert.ok(kept >= 10, `keepRecentTurns is a floor, got ${kept}`);
});

test('the recent window never starts with an orphaned tool_result', () => {
  // Build a conversation where the naive split would land exactly on a
  // user/tool_result message, separating it from its assistant tool_use.
  const messages = [];
  for (let i = 0; i < 40; i++) {
    messages.push(textMsg(i % 2 === 0 ? 'user' : 'assistant', 500));
  }
  // Tool exchange at positions 40 (assistant tool_use) and 41 (user tool_result):
  messages.push({
    role: 'assistant',
    content: [{ type: 'tool_use', id: 'tu_1', name: 'read', input: { path: '/a' } }],
  });
  messages.push({
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'file contents' }],
  });
  // 9 more plain messages → keepRecentTurns=10 puts the naive split at index
  // 41, i.e. the recent window would START with the tool_result.
  for (let i = 0; i < 9; i++) {
    messages.push(textMsg(i % 2 === 0 ? 'assistant' : 'user', 500));
  }

  const out = compressHistory(messages, { keepRecentTurns: 10, summarizeOlder: true, enabled: true });
  // Find the first non-summary message of the recent window.
  const firstRecent = out[1];
  const startsWithToolResult = Array.isArray(firstRecent?.content)
    && firstRecent.content.some((b) => b?.type === 'tool_result');
  assert.equal(startsWithToolResult, false,
    'split must be pulled back so the tool_use/tool_result pair stays together');
  // The pair must both be present in the output.
  const hasToolUse = out.some((m) => Array.isArray(m?.content) && m.content.some((b) => b?.type === 'tool_use' && b.id === 'tu_1'));
  const hasToolResult = out.some((m) => Array.isArray(m?.content) && m.content.some((b) => b?.type === 'tool_result' && b.tool_use_id === 'tu_1'));
  assert.ok(hasToolUse && hasToolResult, 'tool exchange pair preserved intact');
});
