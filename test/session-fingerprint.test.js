/**
 * WS1.5 — content-fingerprint session IDs + upward-drift re-pin.
 *
 * Part A (session.js): clients that send no session header get a session id
 * derived from sha256(first user message + system head + user-agent) instead
 * of a per-request UUID. Every turn of one conversation → same id → WS1
 * pinning actually works. (Live telemetry pre-fix: 278 distinct session ids
 * across 286 requests.)
 *
 * Part B (routing/index.js): a pinned session re-decides when the latest
 * user message scores above the pinned tier's ceiling + PIN_DRIFT_MARGIN,
 * so a "Hi"-opened session escapes its SIMPLE pin when the real task lands.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  fingerprintSessionId,
  extractSessionId,
} = require('../src/api/middleware/session');

function req({ messages, system, headers = {}, body = {} } = {}) {
  return {
    headers: { 'user-agent': 'claude-cli/2.1.204', ...headers },
    body: { messages, system, ...body },
  };
}

const CONVO_A_FIRST = 'Can you dig into the code and give me a refactor plan?';

test('same conversation across turns → same fingerprint', () => {
  const turn1 = req({ messages: [{ role: 'user', content: CONVO_A_FIRST }] });
  const turn3 = req({
    messages: [
      { role: 'user', content: CONVO_A_FIRST },
      { role: 'assistant', content: 'Sure — exploring now.' },
      { role: 'user', content: 'the whole code' },
    ],
  });
  const fp1 = fingerprintSessionId(turn1);
  const fp3 = fingerprintSessionId(turn3);
  assert.ok(fp1 && fp1.startsWith('fp-'));
  assert.equal(fp1, fp3, 'later turns must map to the opening message fingerprint');
});

test('different conversations → different fingerprints', () => {
  const a = fingerprintSessionId(req({ messages: [{ role: 'user', content: 'hi' }] }));
  const b = fingerprintSessionId(req({ messages: [{ role: 'user', content: 'explain CAP theorem' }] }));
  assert.ok(a && b);
  assert.notEqual(a, b);
});

test('same opener but different user-agent → different fingerprints', () => {
  const a = fingerprintSessionId(req({ messages: [{ role: 'user', content: 'hi' }] }));
  const b = fingerprintSessionId(req({
    messages: [{ role: 'user', content: 'hi' }],
    headers: { 'user-agent': 'cursor/1.0' },
  }));
  assert.notEqual(a, b);
});

test('system-reminder blocks are stripped — volatile reminder content does not fork the session', () => {
  const withReminderV1 = req({
    messages: [{
      role: 'user',
      content: `<system-reminder>date is 2026-07-07</system-reminder>${CONVO_A_FIRST}`,
    }],
  });
  const withReminderV2 = req({
    messages: [{
      role: 'user',
      content: `<system-reminder>date is 2026-07-08, tools changed</system-reminder>${CONVO_A_FIRST}`,
    }],
  });
  const bare = req({ messages: [{ role: 'user', content: CONVO_A_FIRST }] });
  assert.equal(fingerprintSessionId(withReminderV1), fingerprintSessionId(withReminderV2));
  assert.equal(fingerprintSessionId(withReminderV1), fingerprintSessionId(bare));
});

test('structured content blocks are fingerprinted like plain strings', () => {
  const plain = req({ messages: [{ role: 'user', content: CONVO_A_FIRST }] });
  const blocks = req({
    messages: [{ role: 'user', content: [{ type: 'text', text: CONVO_A_FIRST }] }],
  });
  assert.equal(fingerprintSessionId(plain), fingerprintSessionId(blocks));
});

test('no user messages / empty text → null (caller falls back to UUID)', () => {
  assert.equal(fingerprintSessionId(req({ messages: [] })), null);
  assert.equal(fingerprintSessionId(req({})), null);
  assert.equal(fingerprintSessionId(req({ messages: [{ role: 'assistant', content: 'x' }] })), null);
  assert.equal(fingerprintSessionId(req({ messages: [{ role: 'user', content: '   ' }] })), null);
});

test('LYNKR_SESSION_FINGERPRINT=false disables fingerprinting', () => {
  process.env.LYNKR_SESSION_FINGERPRINT = 'false';
  try {
    assert.equal(fingerprintSessionId(req({ messages: [{ role: 'user', content: 'hi' }] })), null);
  } finally {
    delete process.env.LYNKR_SESSION_FINGERPRINT;
  }
});

test('extractSessionId: explicit x-session-id header wins over fingerprint', () => {
  const r = req({
    messages: [{ role: 'user', content: 'hi' }],
    headers: { 'x-session-id': 'client-supplied-123' },
  });
  assert.equal(extractSessionId(r), 'client-supplied-123');
  assert.ok(!r.fingerprintedSessionId);
});

test('extractSessionId: falls back to fingerprint, then UUID', () => {
  const withMsg = req({ messages: [{ role: 'user', content: 'hi' }] });
  const id = extractSessionId(withMsg);
  assert.ok(id.startsWith('fp-'));
  assert.equal(withMsg.fingerprintedSessionId, true);

  const empty = req({ messages: [] });
  const uuid = extractSessionId(empty);
  assert.ok(!uuid.startsWith('fp-'));
  assert.equal(empty.generatedSessionId, true);
});

// ---------------------------------------------------------------------------
// Part B — upward-drift re-pin (checkPinScoreDrift)
// ---------------------------------------------------------------------------

const routing = require('../src/routing');
const { analyzeComplexity } = require('../src/routing/complexity-analyzer');

const COMPLEX_ASK =
  'Refactor the entire authentication and database architecture across all ' +
  'modules: redesign the API surface, implement zero-downtime schema ' +
  'migrations, add distributed tracing, and write comprehensive integration ' +
  'tests for every changed subsystem.';

test('drift: REASONING pin never drifts (already at the top)', async () => {
  const r = await routing.checkPinScoreDrift(
    { tier: 'REASONING' },
    { messages: [{ role: 'user', content: COMPLEX_ASK }] },
  );
  assert.equal(r.drift, false);
});

test('drift: no user text (tool-result-only turn) → no drift', async () => {
  const r = await routing.checkPinScoreDrift(
    { tier: 'SIMPLE' },
    { messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] }] },
  );
  assert.equal(r.drift, false);
  assert.equal(r.freshScore, null);
});

test('drift: null tier / missing pin fields → no drift, no throw', async () => {
  assert.equal((await routing.checkPinScoreDrift({}, { messages: [] })).drift, false);
  assert.equal((await routing.checkPinScoreDrift(null, { messages: [] })).drift, false);
});

test('drift verdict is consistent with the scorer: drift ⇔ score > ceiling + margin', async () => {
  // Score the message the same way the drift checker does, then assert the
  // checker's verdict matches score-vs-ceiling arithmetic. This pins the
  // WIRING (ceiling lookup, margin, comparison) without hardcoding the
  // scorer's exact output. The fixture must avoid FORCE_CLOUD_PATTERNS
  // phrases ("refactor the entire", "architecture review", ...) — those
  // short-circuit the drift check with drift=true/forced before the score
  // comparison this test exercises.
  const SCORED_ASK =
    'Evaluate splitting our monolith request handler into separate read and ' +
    'write services: analyze coupling in the current design, weigh consistency ' +
    'guarantees under concurrent load, estimate operational overhead, and ' +
    'recommend an incremental decomposition sequence with test checkpoints.';
  const analysis = await analyzeComplexity(
    { messages: [{ role: 'user', content: SCORED_ASK }] }, {},
  );
  const r = await routing.checkPinScoreDrift(
    { tier: 'SIMPLE' },
    { messages: [{ role: 'user', content: SCORED_ASK }] },
  );
  assert.equal(typeof r.freshScore, 'number');
  assert.equal(typeof r.ceiling, 'number');
  assert.equal(r.freshScore, analysis.score);
  const margin = Number(process.env.LYNKR_PIN_DRIFT_MARGIN) || 15;
  assert.equal(r.drift, r.freshScore > r.ceiling + margin);
});

test('drift: trivial follow-up on a SIMPLE pin stays pinned', async () => {
  const r = await routing.checkPinScoreDrift(
    { tier: 'SIMPLE' },
    { messages: [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello!' },
      { role: 'user', content: 'thanks' },
    ] },
  );
  assert.equal(r.drift, false, `trivial "thanks" must not drift (score=${r.freshScore}, ceiling=${r.ceiling})`);
});

test('drift: force-cloud phrase escapes the pin regardless of score', async () => {
  // "refactor the entire codebase" matches FORCE_CLOUD_PATTERNS — an
  // absolute override that full routing honours but pinned turns used to
  // bypass (live: scored 28, missed the drift threshold by 1, rode a
  // SIMPLE pin).
  const r = await routing.checkPinScoreDrift(
    { tier: 'SIMPLE' },
    { messages: [{ role: 'user', content: 'refactor the entire codebase give me a plan' }] },
  );
  assert.equal(r.drift, true);
  assert.equal(r.forced, 'force_cloud');
});

test('drift: force-cloud check uses typed text only (reminder-injected phrases ignored)', async () => {
  const r = await routing.checkPinScoreDrift(
    { tier: 'SIMPLE' },
    { messages: [{ role: 'user', content: 'thanks<system-reminder>tip: try a security audit or complete rewrite</system-reminder>' }] },
  );
  assert.equal(r.drift, false, JSON.stringify(r));
});

test('force-cloud with tier routing enabled uses the COMPLEX tier model, not the credential list', async () => {
  // Live incident (2026-07-07): force_cloud used getBestCloudProvider(),
  // whose priority list starts with databricks-if-credentialed. Pure
  // tier-routing installs carry DUMMY databricks values to pass startup
  // validation, so "architecture review" routed to the dummy base —
  // Lynkr proxying to itself — and hung.
  const envBackup = { ...process.env };
  try {
    process.env.TIER_SIMPLE = 'ollama:llama3.2';
    process.env.TIER_MEDIUM = 'ollama:llama3.2';
    process.env.TIER_COMPLEX = 'azure-anthropic:claude-sonnet-4-6';
    process.env.TIER_REASONING = 'azure-anthropic:claude-opus-4-8';
    for (const m of [
      '../src/config/index.js', '../src/clients/routing', '../src/routing/index.js',
      '../src/routing/model-tiers', '../src/routing/complexity-analyzer',
      '../src/routing/cost-optimizer', '../src/routing/agentic-detector',
    ]) delete require.cache[require.resolve(m)];
    require('../src/routing/telemetry')._disableForTests();
    const freshRouting = require('../src/clients/routing');
    const d = await freshRouting.determineProviderSmart(
      { messages: [{ role: 'user', content: 'Do an architecture review of the orchestrator' }] }, {},
    );
    assert.equal(d.method, 'force');
    assert.equal(d.reason, 'force_cloud_pattern');
    assert.equal(d.provider, 'azure-anthropic', `routed to ${d.provider} — credential-list leak`);
    assert.equal(d.model, 'claude-sonnet-4-6');
    assert.equal(d.tier, 'COMPLEX');
  } finally {
    process.env = envBackup;
  }
});
