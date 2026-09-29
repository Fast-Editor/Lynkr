const assert = require('assert');
const { describe, it } = require('node:test');
const { stripHarnessEnvelope } = require('../src/routing/harness-envelope');
const { analyzeRisk } = require('../src/routing/risk-analyzer');
const ca = require('../src/routing/complexity-analyzer');

// Modeled on the live 2026-09-26 incident: Cursor's envelope rides INSIDE the
// user message; the workspace <rules> block contains risk/force vocabulary the
// user never typed, and telemetry-style truncation leaves the last block
// unclosed. The ask ("Hi") trails the envelope.
const ENVELOPE = `<user_info>
OS Version: darwin 25.5.0
Shell: zsh
Workspace Path: /Users/someone/opencode-wrap
</user_info>

<git_status>
On branch main. Modified: server.js, package.json
</git_status>

<rules>
Never expose API keys or credentials. Do not deploy to production without
approval. Always think step by step and verify your work before migrating
the system or restructuring the codebase per the migration plan.
</rules>

Hi`;

describe('stripHarnessEnvelope', () => {
  it('removes paired envelope blocks, keeps the trailing ask', () => {
    const out = stripHarnessEnvelope(ENVELOPE);
    assert.strictEqual(out, 'Hi');
  });

  it('unclosed block at line start (truncated envelope) swallows to end', () => {
    const out = stripHarnessEnvelope('Hi again\n<rules>\nnever expose api keys and then it truncat');
    assert.strictEqual(out, 'Hi again');
  });

  it('mid-line tag mention is user content, preserved', () => {
    const t = 'why does <rules> in cursor payloads break my parser?';
    assert.strictEqual(stripHarnessEnvelope(t), t);
  });

  it('<user_query> wins outright when present', () => {
    const out = stripHarnessEnvelope('<user_info>x</user_info><user_query>fix the bug</user_query><rules>deploy stuff</rules>');
    assert.strictEqual(out, 'fix the bug');
  });

  it('plain text and non-strings pass through safely', () => {
    assert.strictEqual(stripHarnessEnvelope('just a normal ask'), 'just a normal ask');
    assert.strictEqual(stripHarnessEnvelope(null), '');
  });

  it('claude-code wrappers are untouched (different mechanism, different strip)', () => {
    const t = '[SUGGESTION MODE: xyz] some text';
    assert.strictEqual(stripHarnessEnvelope(t), t);
  });
});

describe('risk/force triggers scoped to the ask, not the envelope', () => {
  const payload = (content) => ({ messages: [{ role: 'user', content }] });

  it('incident regression: envelope rules vocab + "Hi" → risk low', () => {
    const r = analyzeRisk(payload(ENVELOPE));
    assert.strictEqual(r.level, 'low', JSON.stringify(r));
  });

  it('a genuinely risky ASK after the envelope still fires', () => {
    const r = analyzeRisk(payload(ENVELOPE.replace(/Hi$/, 'rotate the production credentials in .env now')));
    assert.notStrictEqual(r.level, 'low');
  });

  it('force-reasoning vocab inside the envelope does not force', () => {
    assert.strictEqual(ca.shouldForceReasoning(payload(ENVELOPE)), false);
  });

  it('force-reasoning in the actual ask still forces', () => {
    assert.strictEqual(ca.shouldForceReasoning(payload(ENVELOPE.replace(/Hi$/, 'ultrathink: prove this queue is correct'))), true);
  });
});
