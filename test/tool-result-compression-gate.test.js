/**
 * Client-profile gate on the orchestrator's tool-result compressor.
 *
 * OpenMausBot (2026-10-14): Lynkr's compressJSON rewrote a 15 KB Composio
 * tool result to a 111-char key skeleton, deleting the harness's own paging
 * notice (saved result id + offset for agents_tool_result_read). The model
 * paged with a bad id and OpenMausBot failed the turn. The compressor was
 * built for shell output a coding agent can re-run; an app harness's tool
 * results are the data. Profiles may now opt out with
 * `compressToolResults: false`, honoured by toolResultCompressionAllowed().
 */

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.DATABRICKS_API_KEY = process.env.DATABRICKS_API_KEY || 'test-key';
process.env.DATABRICKS_API_BASE = process.env.DATABRICKS_API_BASE || 'http://test.com';
process.env.LOG_FILE_ENABLED = 'false';

const config = require('../src/config');
const { toolResultCompressionAllowed } = require('../src/orchestrator');
const { PROFILES } = require('../src/routing/client-profiles');
const { compressToolResults } = require('../src/context/tool-result-compressor');

// A tool result shaped like what OpenMausBot relays from Composio: a large
// JSON document (not web-search/fetch shaped, so compressJSON takes it) whose
// values carry the harness's own truncation placeholders and a paging notice
// with the saved result id + offset for agents_tool_result_read. The notice
// lives INSIDE the JSON, as it did in the live 2026-10-14 request (Lynkr's
// log: pattern json_response, 15283 → 111 chars).
function appHarnessHistory() {
  const big = {
    ok: true,
    result: {
      successful: true,
      data: {
        results: Array.from({ length: 80 }, (_, i) => ({
          index: i,
          use_case: `Check whether Gmail is connected (${i})`,
          recommended_plan_steps: ['[additional data omitted]', '[additional data omitted]'],
          execution_guidance: 'x'.repeat(40),
        })),
      },
    },
    notice: 'Oversized result truncated. Saved result id: tr_abc123; next offset: 12000 — read with agents_tool_result_read.',
  };
  return [
    { role: 'user', content: 'see if you have gmail access' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'composio_composio_search_tools', input: { queries: ['gmail'] } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: JSON.stringify(big) }] },
  ];
}

test('allowed by default for an unrecognized client and for coding-harness profiles', () => {
  const prev = config.toolResultCompression?.enabled;
  config.toolResultCompression = { ...(config.toolResultCompression || {}), enabled: true };
  try {
    assert.equal(toolResultCompressionAllowed({}), true);
    assert.equal(toolResultCompressionAllowed({ _clientProfile: null }), true);
    assert.equal(toolResultCompressionAllowed({ _clientProfile: PROFILES['claude-code'] }), true);
    assert.equal(toolResultCompressionAllowed({ _clientProfile: PROFILES['openai-codex'] }), true);
    assert.equal(toolResultCompressionAllowed({ _clientProfile: PROFILES['goose'] }), true);
  } finally {
    config.toolResultCompression = { ...(config.toolResultCompression || {}), enabled: prev };
  }
});

test('vetoed for the openmausbot profile', () => {
  const prev = config.toolResultCompression?.enabled;
  config.toolResultCompression = { ...(config.toolResultCompression || {}), enabled: true };
  try {
    assert.equal(toolResultCompressionAllowed({ _clientProfile: PROFILES['openmausbot'] }), false);
  } finally {
    config.toolResultCompression = { ...(config.toolResultCompression || {}), enabled: prev };
  }
});

test('the global TOOL_RESULT_COMPRESSION_ENABLED=false switch still wins for everyone', () => {
  const prev = config.toolResultCompression?.enabled;
  config.toolResultCompression = { ...(config.toolResultCompression || {}), enabled: false };
  try {
    assert.equal(toolResultCompressionAllowed({}), false);
    assert.equal(toolResultCompressionAllowed({ _clientProfile: PROFILES['claude-code'] }), false);
  } finally {
    config.toolResultCompression = { ...(config.toolResultCompression || {}), enabled: prev };
  }
});

test('proof of harm: the compressor does delete an app harness paging notice when it runs', () => {
  // Documents WHY the veto exists. If a future compressor change starts
  // preserving the notice, this assertion flips and the veto can be revisited.
  const messages = appHarnessHistory();
  const before = messages[2].content[0].content;
  assert.ok(before.includes('Saved result id: tr_abc123'));
  compressToolResults(messages, { tier: 'COMPLEX' });
  const after = messages[2].content[0].content;
  const text = typeof after === 'string' ? after : JSON.stringify(after);
  assert.ok(text.length < before.length, 'compressor should have compressed this JSON result');
  assert.ok(!text.includes('tr_abc123'), 'and in doing so it drops the harness paging notice — hence compressToolResults: false');
});
