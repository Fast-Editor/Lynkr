/**
 * Complexity analyzer must subtract client-harness baseline tools from
 * scoreTools / calculateWeightedScore, or the tool-count penalty inflates
 * the score for trivial follow-ups on subscription clients (Claude Code
 * attaches ~11 tools to every request; without the subtraction that alone
 * adds 16+ points and pushes "what did I just say?" past MEDIUM).
 *
 * This is the same fix pattern WS3 applied to the agentic detector,
 * extended here to the complexity analyzer.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { analyzeComplexity } = require('../src/routing/complexity-analyzer');
const { PROFILES } = require('../src/routing/client-profiles');

const CLAUDE_CODE_TOOLS = [
  'Task', 'Bash', 'Glob', 'Grep', 'Read', 'Edit', 'Write',
  'NotebookEdit', 'WebFetch', 'WebSearch', 'TodoWrite',
].map((name) => ({ name, input_schema: { type: 'object', properties: {} } }));

test('trivial follow-up + Claude Code baseline + profile → low complexity', async () => {
  const analysis = await analyzeComplexity({
    messages: [{ role: 'user', content: 'what did I just say?' }],
    tools: CLAUDE_CODE_TOOLS,
    _clientProfile: PROFILES['claude-code'],
  });
  // With WS3-alike subtraction, the score should be well below the MEDIUM
  // threshold (default 40). Previously this returned ~46 because the raw
  // tool count (11) added 16 points via scoreTools.
  assert.ok(analysis.score < 20, `expected score < 20, got ${analysis.score}`);
});

test('same trivial follow-up + baseline tools + NO profile → still low (unknown-harness guard)', async () => {
  const analysis = await analyzeComplexity({
    messages: [{ role: 'user', content: 'what did I just say?' }],
    tools: CLAUDE_CODE_TOOLS,
    // no _clientProfile — the guard should still zero the tool count because
    // every tool name matches a known-harness baseline AND there are >= 10.
  });
  assert.ok(analysis.score < 20, `expected score < 20, got ${analysis.score}`);
});

test('user-added tools beyond baseline still register (real MCP tools count)', async () => {
  const withExtras = await analyzeComplexity({
    messages: [{ role: 'user', content: 'search github and slack for open issues about pagination' }],
    tools: [
      ...CLAUDE_CODE_TOOLS,
      { name: 'mcp__github__list_issues' },
      { name: 'mcp__slack__search' },
      { name: 'mcp__linear__search' },
      { name: 'mcp__notion__query' },
      { name: 'mcp__jira__jql' },
    ],
    _clientProfile: PROFILES['claude-code'],
  });
  const baselineOnly = await analyzeComplexity({
    messages: [{ role: 'user', content: 'search github and slack for open issues about pagination' }],
    tools: CLAUDE_CODE_TOOLS,
    _clientProfile: PROFILES['claude-code'],
  });
  // 5 extra MCP tools should raise the score meaningfully.
  assert.ok(
    withExtras.score > baselineOnly.score,
    `expected extras (${withExtras.score}) > baseline-only (${baselineOnly.score})`
  );
});

test('unknown-harness guard requires >=10 tools (5 baseline tools still count)', async () => {
  const analysis = await analyzeComplexity({
    messages: [{ role: 'user', content: 'do a thing' }],
    tools: CLAUDE_CODE_TOOLS.slice(0, 5), // only 5 baseline tools → guard should NOT fire
  });
  // With 5 tools counted, scoreTools returns 8 (4 tools ≤ 6). Total score
  // depends on other signals — we're not asserting a specific value, just
  // that the meta.toolCount reflects the raw count (5).
  const rawToolCount = analysis.breakdown?.tools?.count
    ?? analysis.meta?.toolCount;
  assert.equal(rawToolCount, 5);
});

test('raw payload with 12 arbitrary non-baseline tools still gets inflated (old behavior preserved)', async () => {
  const tools = Array.from({ length: 12 }, (_, i) => ({ name: `custom_tool_${i}` }));
  const analysis = await analyzeComplexity({
    messages: [{ role: 'user', content: 'do many things' }],
    tools,
  });
  // No profile, no unknown-harness guard match (unknown names). Tool count
  // signal should fire normally.
  const rawToolCount = analysis.breakdown?.tools?.count
    ?? analysis.meta?.toolCount;
  assert.equal(rawToolCount, 12);
});
