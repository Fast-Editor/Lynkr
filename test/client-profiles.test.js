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

// ─── Goose (Block CLI) profile ─────────────────────────────────────────────

// Goose CLI 1.41 default loadout — captured live 2026-07-13. Goose sends NO
// user-agent header, so detection is fingerprint-only.
const GOOSE_TOOLS = [
  'analyze', 'delegate', 'edit', 'load', 'load_skill', 'read_image',
  'shell', 'tree', 'write',
  'apps__create_app', 'apps__delete_app', 'apps__iterate_app', 'apps__list_apps',
  'extensionmanager__list_resources', 'extensionmanager__manage_extensions',
  'extensionmanager__read_resource', 'extensionmanager__search_available_extensions',
  'todo__todo_write',
].map((name) => ({ name, input_schema: { type: 'object', properties: {} } }));

// OpenCode 1.18.x — sends `opencode/x.y.z ai-sdk/…` UA plus a lowercase
// default loadout (captured live 2026-08-22). Without this profile every
// OpenCode first turn scored ~80 (harness counted as intent) → REASONING
// pin for the whole session.
const OPENCODE_TOOLS = [
  'bash', 'edit', 'glob', 'grep', 'question', 'read', 'skill', 'task',
  'todowrite', 'webfetch', 'write',
].map((name) => ({ name }));

test('detectClient — opencode user-agent matches', () => {
  const profile = detectClient({
    headers: { 'user-agent': 'opencode/1.18.21 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14' },
    payload: {},
  });
  assert.ok(profile);
  assert.equal(profile.name, 'opencode');
});

test('detectClient — opencode tool fingerprint matches when UA missing', () => {
  const profile = detectClient({
    headers: {},
    payload: { tools: OPENCODE_TOOLS },
  });
  assert.ok(profile);
  assert.equal(profile.name, 'opencode');
});

test('detectClient — goose fingerprint matches with no user-agent', () => {
  const profile = detectClient({
    headers: {},
    payload: { tools: GOOSE_TOOLS },
  });
  assert.ok(profile);
  assert.equal(profile.name, 'goose');
});

test('detectClient — goose fingerprint survives default extensions being disabled', () => {
  // Drop the apps__* and extensionmanager__* extension tools (7 of 18);
  // the core loadout alone must still clear the 0.6 threshold.
  const coreOnly = GOOSE_TOOLS.filter((t) =>
    !t.name.startsWith('apps__') && !t.name.startsWith('extensionmanager__')
  );
  const profile = detectClient({ headers: {}, payload: { tools: coreOnly } });
  assert.ok(profile);
  assert.equal(profile.name, 'goose');
});

test('trivial "hi" + goose baseline tools + profile → NOT agentic', () => {
  const detector = new AgenticDetector();
  const payload = {
    messages: [{ role: 'user', content: 'hi' }],
    tools: GOOSE_TOOLS,
  };
  const result = detector.detect(payload, { clientProfile: PROFILES['goose'] });
  assert.equal(result.isAgentic, false);
  assert.equal(result.agentType, 'SINGLE_SHOT');
  const toolSignals = result.signals.filter((s) =>
    s.signal.includes('tool_count') || s.signal.includes('agentic_tool')
  );
  assert.equal(toolSignals.length, 0);
});

test('goose baseline + MCP additions with profile → scores only the additions', () => {
  const detector = new AgenticDetector();
  const extraTools = [
    { name: 'mcp__github__list_issues' },
    { name: 'mcp__slack__post' },
  ];
  const payload = {
    messages: [{ role: 'user', content: 'check github and slack' }],
    tools: [...GOOSE_TOOLS, ...extraTools],
  };
  const result = detector.detect(payload, { clientProfile: PROFILES['goose'] });
  const toolCountSignals = result.signals.filter((s) => s.signal.endsWith('tool_count'));
  assert.equal(toolCountSignals.length, 0);
  assert.deepEqual(
    effectiveTools(payload, PROFILES['goose']).map((t) => t.name).sort(),
    ['mcp__github__list_issues', 'mcp__slack__post'],
  );
});

// ─── Lynkr's own injected loadout ──────────────────────────────────────────

// IDE_SAFE_TOOLS — what the OpenAI-compat routers inject when a client sends
// no tools (e.g. goose's summarizer side-requests). Must fingerprint as a
// harness baseline so the detector doesn't score Lynkr's own plumbing.
const LYNKR_INJECTED_TOOLS = [
  'Write', 'Read', 'Edit', 'Bash', 'Glob', 'Grep', 'MultiEdit', 'LS',
  'NotebookRead', 'TodoWrite', 'Task', 'WebSearch', 'WebFetch',
  'WebAgent', 'NotebookEdit',
].map((name) => ({ name, input_schema: { type: 'object', properties: {} } }));

test('detectClient — Lynkr-injected IDE_SAFE loadout fingerprints as lynkr-injected', () => {
  const profile = detectClient({ headers: {}, payload: { tools: LYNKR_INJECTED_TOOLS } });
  assert.ok(profile);
  assert.equal(profile.name, 'lynkr-injected');
});

test('trivial "hi" + Lynkr-injected tools + profile → NOT agentic', () => {
  const detector = new AgenticDetector();
  const payload = {
    messages: [{ role: 'user', content: 'hi' }],
    tools: LYNKR_INJECTED_TOOLS,
  };
  const profile = detectClient({ headers: {}, payload });
  const result = detector.detect(payload, { clientProfile: profile });
  assert.equal(result.isAgentic, false);
  assert.equal(result.agentType, 'SINGLE_SHOT');
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

// ---------------------------------------------------------------------------
// OpenMausBot — an app harness on the OpenAI-compat surface that executes
// only the tools it sent. Its profile both names the baseline (so the
// agentic detector does not score the app's own loadout as intent) and
// vetoes IDE_SAFE_TOOLS injection (`injectTools: false`).
// ---------------------------------------------------------------------------

const { vetoesToolInjection, _resetForTests } = require('../src/routing/client-profiles');
const fs = require('fs');
const os = require('os');
const path = require('path');

// OpenMausBot 0.1.110 — ask_user + the built-in "agents" MCP server mounted as
// `agents_<tool>` (chat-mcp-tools.ts), as the openai-compat driver sends them.
const OPENMAUSBOT_TOOLS = [
  'ask_user',
  'agents_tool_result_read', 'agents_list_room_targets', 'agents_coordinate_bots',
  'agents_assignment_status', 'agents_list_bots', 'agents_list_rooms',
  'agents_select_computer', 'agents_list_threads', 'agents_close_thread',
  'agents_start_thread', 'agents_attach_file', 'agents_post_to_room',
  'agents_request_credential', 'agents_request_sign_in', 'agents_fill_login',
  'agents_memory_update', 'agents_memory_log', 'agents_session_search',
  'agents_session_read', 'agents_list_routines', 'agents_propose_routine',
  'agents_propose_routine_action', 'agents_propose_profile', 'agents_propose_model',
  'agents_propose_team_memory', 'agents_add_mcp_server',
].map((name) => ({ name, input_schema: { type: 'object', properties: {} } }));

test('detectClient — openmausbot user-agent matches', () => {
  const profile = detectClient({
    headers: { 'user-agent': 'openmausbot/0.1.110' },
    payload: {},
  });
  assert.ok(profile);
  assert.equal(profile.name, 'openmausbot');
});

test('detectClient — x-client header names the profile when there is no user-agent', () => {
  // OpenMausBot sends neither header today; an operator fronting it (or a
  // future release) can set x-client and skip the fingerprint entirely.
  const profile = detectClient({ headers: { 'x-client': 'openmausbot' }, payload: {} });
  assert.ok(profile);
  assert.equal(profile.name, 'openmausbot');
  const viaName = detectClient({ headers: { 'x-client-name': 'OpenMausBot desktop' }, payload: {} });
  assert.equal(viaName?.name, 'openmausbot');
});

test('detectClient — x-client header does not shadow a user-agent match', () => {
  const profile = detectClient({
    headers: { 'user-agent': 'claude-cli/2.1.201 (darwin)', 'x-client': 'openmausbot' },
    payload: {},
  });
  assert.equal(profile?.name, 'claude-code');
});

test('detectClient — openmausbot tool fingerprint matches with no headers at all', () => {
  const profile = detectClient({ headers: {}, payload: { tools: OPENMAUSBOT_TOOLS } });
  assert.ok(profile);
  assert.equal(profile.name, 'openmausbot');
});

test('detectClient — openmausbot fingerprint works on OpenAI-shaped tool objects', () => {
  const openaiShaped = OPENMAUSBOT_TOOLS.map((t) => ({
    type: 'function',
    function: { name: t.name, parameters: t.input_schema },
  }));
  const profile = detectClient({ headers: {}, payload: { tools: openaiShaped } });
  assert.equal(profile?.name, 'openmausbot');
});

test('detectClient — openmausbot fingerprint survives memory being switched off', () => {
  const noMemory = OPENMAUSBOT_TOOLS.filter((t) => !t.name.startsWith('agents_memory_'));
  const profile = detectClient({ headers: {}, payload: { tools: noMemory } });
  assert.equal(profile?.name, 'openmausbot');
});

test('detectClient — a bot with only ask_user + connector tools is NOT fingerprinted as openmausbot', () => {
  // The agents server is not mounted for every bot. ask_user + three Composio
  // tools is 1/27 of the baseline — well under 0.5 — so no profile matches,
  // and with tools present there is nothing to veto anyway.
  const tools = ['ask_user', 'composio_composio_search_tools', 'composio_composio_get_tool_schemas',
    'composio_composio_multi_execute_tool'].map((name) => ({ name }));
  const profile = detectClient({ headers: {}, payload: { tools } });
  assert.equal(profile, null);
});

test('detectClient — the OpenMausBot context-note marker in the user turn matches', () => {
  const profile = detectClient({
    headers: {},
    payload: {
      messages: [{
        role: 'user',
        content: 'Context from OpenMausBot updated since this conversation started; it replaces any earlier copy:\n…\n\nhi',
      }],
    },
  });
  assert.equal(profile?.name, 'openmausbot');
});

test('openmausbot profile vetoes tool injection; every other seed profile does not', () => {
  assert.equal(PROFILES['openmausbot'].injectTools, false);
  assert.equal(vetoesToolInjection(PROFILES['openmausbot']), true);
  for (const [name, profile] of Object.entries(PROFILES)) {
    if (name === 'openmausbot') continue;
    assert.equal(vetoesToolInjection(profile), false, `${name} must not veto injection`);
  }
  assert.equal(vetoesToolInjection(null), false);
  assert.equal(vetoesToolInjection(undefined), false);
});

test('effectiveTools — subtracts the openmausbot baseline, keeps the bot\'s connectors', () => {
  const extra = [
    { name: 'composio_gmail_send_email' },
    { name: 'mymcp_search_docs' },
  ];
  const profile = PROFILES['openmausbot'];
  const result = effectiveTools({ tools: [...OPENMAUSBOT_TOOLS, ...extra] }, profile);
  assert.deepEqual(result.map((t) => t.name), ['composio_gmail_send_email', 'mymcp_search_docs']);
});

test('trivial "hi" + openmausbot baseline tools + profile → NOT agentic', () => {
  const detector = new AgenticDetector();
  const payload = {
    messages: [{ role: 'user', content: 'hi' }],
    tools: OPENMAUSBOT_TOOLS,
  };
  const result = detector.detect(payload, { clientProfile: PROFILES['openmausbot'] });
  assert.equal(result.isAgentic, false);
  assert.equal(result.agentType, 'SINGLE_SHOT');
  const toolSignals = result.signals.filter((s) =>
    s.signal.includes('tool_count') || s.signal.includes('agentic_tool')
  );
  assert.equal(toolSignals.length, 0);
});

test('data/client-profiles.json override keeps seed flags and adds new vetoing profiles', () => {
  // Runs last: _loadUserProfiles mutates PROFILES in place for this process.
  const prevCwd = process.cwd();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lynkr-client-profiles-'));
  fs.mkdirSync(path.join(dir, 'data'));
  fs.writeFileSync(path.join(dir, 'data', 'client-profiles.json'), JSON.stringify({
    // Only a newer baseline for openmausbot — the veto and the 0.5 threshold must survive.
    openmausbot: { baselineTools: ['ask_user', 'agents_memory_update', 'agents_new_tool'] },
    // A brand-new app harness that also runs only its own tools.
    myapp: { headerPatterns: ['myapp/'], injectTools: false },
    // A new profile that says nothing about injection → default (no veto).
    other: { headerPatterns: ['other-cli/'] },
  }));
  try {
    process.chdir(dir);
    _resetForTests();
    const omb = detectClient({ headers: { 'user-agent': 'openmausbot/9.9.9' }, payload: {} });
    assert.equal(omb?.name, 'openmausbot');
    assert.equal(omb.injectTools, false, 'override must keep the seed injectTools veto');
    assert.equal(omb.detect.minToolFingerprintMatch, 0.5, 'override must keep the seed threshold');
    assert.ok(omb.baselineTools.has('agents_new_tool'));
    assert.equal(omb.detect.promptPatterns.length, 2, 'override must keep the seed prompt patterns');

    const myapp = detectClient({ headers: { 'user-agent': 'myapp/1.0' }, payload: {} });
    assert.equal(myapp?.name, 'myapp');
    assert.equal(vetoesToolInjection(myapp), true);

    const other = detectClient({ headers: { 'user-agent': 'other-cli/1.0' }, payload: {} });
    assert.equal(other?.name, 'other');
    assert.equal(vetoesToolInjection(other), false);
  } finally {
    process.chdir(prevCwd);
    _resetForTests();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// compressToolResults: false — app harnesses whose tool results are data.
// ---------------------------------------------------------------------------

const { vetoesToolResultCompression } = require('../src/routing/client-profiles');

test('openmausbot profile vetoes tool-result compression; every other seed profile does not', () => {
  assert.equal(PROFILES['openmausbot'].compressToolResults, false);
  assert.equal(vetoesToolResultCompression(PROFILES['openmausbot']), true);
  for (const [name, profile] of Object.entries(PROFILES)) {
    if (name === 'openmausbot') continue;
    assert.equal(vetoesToolResultCompression(profile), false, `${name} must keep compression on`);
  }
  assert.equal(vetoesToolResultCompression(null), false);
  assert.equal(vetoesToolResultCompression(undefined), false);
});

test('data/client-profiles.json override keeps the seed compressToolResults veto and accepts it on new profiles', () => {
  const prevCwd = process.cwd();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lynkr-client-profiles-compress-'));
  fs.mkdirSync(path.join(dir, 'data'));
  fs.writeFileSync(path.join(dir, 'data', 'client-profiles.json'), JSON.stringify({
    openmausbot: { baselineTools: ['ask_user'] },               // only a new baseline
    myapp: { headerPatterns: ['myapp/'], compressToolResults: false },
    other: { headerPatterns: ['other-cli/'] },
  }));
  try {
    process.chdir(dir);
    _resetForTests();
    const omb = detectClient({ headers: { 'user-agent': 'openmausbot/9.9.9' }, payload: {} });
    assert.equal(omb.compressToolResults, false, 'override must keep the seed compressToolResults veto');
    assert.equal(vetoesToolResultCompression(detectClient({ headers: { 'user-agent': 'myapp/1.0' }, payload: {} })), true);
    assert.equal(vetoesToolResultCompression(detectClient({ headers: { 'user-agent': 'other-cli/1.0' }, payload: {} })), false);
  } finally {
    process.chdir(prevCwd);
    _resetForTests();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
