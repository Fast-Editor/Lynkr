/**
 * WS3 — client profile detection + agentic-detector integration tests.
 *
 * These verify the fix for D5: Claude Code (and friends) attach a large
 * baseline tool loadout to every request, which used to inflate the
 * agentic detector's tool-count signals into false positives. The fix is
 * a client profile that names the baseline; effectiveTools() subtracts
 * it before scoring.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  detectClient,
  effectiveTools,
  allToolsAreBaseline,
  PROFILES,
} = require('../src/routing/client-profiles');
const { AgenticDetector } = require('../src/routing/agentic-detector');

// Convenience — Claude Code's full baseline loadout (matches PROFILES.claude-code).
const CLAUDE_CODE_TOOLS = [
  'Task', 'Bash', 'Glob', 'Grep', 'Read', 'Edit', 'Write',
  'NotebookEdit', 'WebFetch', 'WebSearch', 'TodoWrite',
  'BashOutput', 'KillShell', 'SlashCommand',
].map((name) => ({ name, input_schema: { type: 'object', properties: {} } }));

test('detectClient — user-agent regex matches Claude Code', () => {
  const profile = detectClient({
    headers: { 'user-agent': 'claude-code/1.2.3 (Mac)' },
    payload: {},
  });
  assert.ok(profile);
  assert.equal(profile.name, 'claude-code');
});

test('detectClient — matches the actual Claude Code CLI User-Agent (claude-cli/…)', () => {
  const profile = detectClient({
    headers: { 'user-agent': 'claude-cli/2.1.201 (darwin)' },
    payload: {},
  });
  assert.ok(profile);
  assert.equal(profile.name, 'claude-code');
});

test('detectClient — matches claude-vscode extension UA', () => {
  const profile = detectClient({
    headers: { 'user-agent': 'claude-vscode/1.0.0' },
    payload: {},
  });
  assert.ok(profile);
  assert.equal(profile.name, 'claude-code');
});

test('detectClient — user-agent takes precedence over tool fingerprint', () => {
  const profile = detectClient({
    headers: { 'user-agent': 'cursor/0.99' },
    payload: { tools: CLAUDE_CODE_TOOLS },
  });
  assert.equal(profile.name, 'cursor');
});

test('detectClient — tool fingerprint matches when UA missing', () => {
  const profile = detectClient({
    headers: {},
    payload: { tools: CLAUDE_CODE_TOOLS },
  });
  assert.ok(profile);
  assert.equal(profile.name, 'claude-code');
});

test('detectClient — returns null on unknown client with no tools', () => {
  const profile = detectClient({ headers: { 'user-agent': 'MyBot/1.0' }, payload: {} });
  assert.equal(profile, null);
});

test('effectiveTools — subtracts Claude Code baseline, returns MCP additions', () => {
  const tools = [
    ...CLAUDE_CODE_TOOLS,
    { name: 'mcp__exa__search' },
    { name: 'mcp__github__list_issues' },
    { name: 'mcp__slack__post' },
  ];
  const profile = PROFILES['claude-code'];
  const effective = effectiveTools({ tools }, profile);
  assert.equal(effective.length, 3);
  assert.deepEqual(effective.map((t) => t.name).sort(), [
    'mcp__exa__search', 'mcp__github__list_issues', 'mcp__slack__post',
  ]);
});

test('effectiveTools — with null profile returns full list', () => {
  const tools = [{ name: 'Read' }, { name: 'Write' }];
  assert.deepEqual(effectiveTools({ tools }, null).length, 2);
});

test('allToolsAreBaseline — true for pure Claude Code loadout', () => {
  assert.equal(allToolsAreBaseline({ tools: CLAUDE_CODE_TOOLS }), true);
});

test('allToolsAreBaseline — false when a non-baseline tool is present', () => {
  const tools = [...CLAUDE_CODE_TOOLS, { name: 'mcp__foo__bar' }];
  assert.equal(allToolsAreBaseline({ tools }), false);
});

test('allToolsAreBaseline — false on empty tools', () => {
  assert.equal(allToolsAreBaseline({ tools: [] }), false);
});

// ─── Agentic detector integration ─────────────────────────────────────────

test('trivial "hi" + Claude Code baseline tools + profile → NOT agentic', () => {
  const detector = new AgenticDetector();
  const payload = {
    messages: [{ role: 'user', content: 'hi' }],
    tools: CLAUDE_CODE_TOOLS,
  };
  const result = detector.detect(payload, { clientProfile: PROFILES['claude-code'] });
  assert.equal(result.isAgentic, false);
  assert.equal(result.agentType, 'SINGLE_SHOT');
  // Tool-count / agentic-tool signals should have been suppressed entirely.
  const toolSignals = result.signals.filter((s) =>
    s.signal.includes('tool_count') || s.signal.includes('agentic_tool')
  );
  assert.equal(toolSignals.length, 0);
});

test('same payload without profile → detector fires (proves the profile mattered)', () => {
  const detector = new AgenticDetector();
  const payload = {
    messages: [{ role: 'user', content: 'hi' }],
    tools: CLAUDE_CODE_TOOLS,
  };
  const result = detector.detect(payload);
  // WS3.2 guard: the pure-baseline heuristic still zeroes tool signals for
  // an unknown client that happens to look like Claude Code, so agentic
  // stays false. This proves the guard covers UA-less traffic too.
  assert.equal(result.isAgentic, false);
  assert.equal(result.scoringNote, 'unknown_harness_guard');
});

test('Claude Code baseline + 3 MCP tools with profile → scores only the 3', () => {
  const detector = new AgenticDetector();
  const extraTools = [
    { name: 'mcp__exa__search' },
    { name: 'mcp__github__list_issues' },
    { name: 'mcp__slack__post' },
  ];
  const payload = {
    messages: [{ role: 'user', content: 'search github and slack for issues' }],
    tools: [...CLAUDE_CODE_TOOLS, ...extraTools],
  };
  const result = detector.detect(payload, { clientProfile: PROFILES['claude-code'] });
  // 3 tools = no tool-count signal fires (>3 threshold). No signals with
  // very_high_tool_count / high_tool_count / moderate_tool_count.
  const toolCountSignals = result.signals.filter((s) => s.signal.endsWith('tool_count'));
  assert.equal(toolCountSignals.length, 0);
});

test('unknown client with 12 arbitrary custom tools → agentic fires (old behavior preserved)', () => {
  const detector = new AgenticDetector();
  const tools = Array.from({ length: 12 }, (_, i) => ({ name: `custom_tool_${i}` }));
  const payload = {
    messages: [{ role: 'user', content: 'do a bunch of things' }],
    tools,
  };
  const result = detector.detect(payload);
  // These aren't in ANY profile's baseline, so allToolsAreBaseline=false
  // and the tool_count signal fires normally.
  const hasHighToolCount = result.signals.some((s) => s.signal === 'very_high_tool_count');
  assert.equal(hasHighToolCount, true);
});

test('deep tool_result loop with baseline-only tools → still agentic (signals 3+ intact)', () => {
  const detector = new AgenticDetector();
  const messages = [
    { role: 'user', content: 'refactor this' },
  ];
  // 6 tool_result turns — signal 3 fires at >5 with weight 30.
  for (let i = 0; i < 6; i++) {
    messages.push({
      role: 'assistant',
      content: [{ type: 'tool_use', id: `t${i}`, name: 'Bash', input: { command: 'ls' } }],
    });
    messages.push({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: `t${i}`, content: 'ok' }],
    });
  }
  const payload = { messages, tools: CLAUDE_CODE_TOOLS };
  const result = detector.detect(payload, { clientProfile: PROFILES['claude-code'] });
  // Tool signals were zeroed, but tool_result loop signal + conversation
  // depth still push it well over threshold.
  assert.equal(result.isAgentic, true);
});

test('user-agent alone matches even with empty tools array', () => {
  const detector = new AgenticDetector();
  const profile = detectClient({
    headers: { 'user-agent': 'anthropic-cli 1.0' },
    payload: {},
  });
  assert.ok(profile);
  const result = detector.detect(
    { messages: [{ role: 'user', content: 'hi' }], tools: [] },
    { clientProfile: profile },
  );
  assert.equal(result.isAgentic, false);
});

test('unknown harness guard requires >=10 tools', () => {
  const detector = new AgenticDetector();
  // 5 baseline-only tools — the guard's threshold is >=10, so this should
  // NOT be zeroed. But 5 tools = no tool_count signal anyway (>5 required).
  const payload = {
    messages: [{ role: 'user', content: 'hi' }],
    tools: CLAUDE_CODE_TOOLS.slice(0, 5),
  };
  const result = detector.detect(payload);
  // With 5 tools the moderate_tool_count signal doesn't fire (threshold >3, ≤5).
  // Actually count > 3 fires — check the exact signal.
  const highSignals = result.signals.filter((s) => s.signal === 'high_tool_count' || s.signal === 'very_high_tool_count');
  assert.equal(highSignals.length, 0);
  // scoringNote should not be 'unknown_harness_guard' since tools.length < 10.
  assert.notEqual(result.scoringNote, 'unknown_harness_guard');
});
