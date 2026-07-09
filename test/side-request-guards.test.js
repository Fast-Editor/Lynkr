/**
 * Post-WS1.5 hardening (2026-07-07) — three live-incident regressions:
 *
 * 1. Risk-forced decisions must never be pinned. Risk analysis re-runs on
 *    every turn, so pinning adds nothing — but it created a one-way
 *    ratchet where ONE phantom risk hit (suggestion-mode wrapper text,
 *    replayed repo transcripts) locked the whole conversation onto the
 *    expensive tier.
 *
 * 2. Badge stripping must not destroy real content or produce payloads
 *    Anthropic rejects. The old array branch dropped any block whose text
 *    STARTED with a badge (losing merged "badge+answer" blocks), and the
 *    badge-only placeholder was an empty string — which Anthropic 400s.
 *    This is the mechanism behind the interrupted-response badge echo
 *    loop.
 *
 * 3. Tool-less side requests must not refresh a pin's messageCount
 *    (phantom-compaction trigger).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Isolate telemetry before any routing module loads.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lynkr-sideguards-'));
require('../src/routing/telemetry')._setDbPathForTests(path.join(tmpDir, 'telemetry.db'));

const routing = require('../src/routing');
const sessionAffinity = require('../src/routing/session-affinity');
const { stripLynkrBadges } = require('../src/clients/databricks');

test.after(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ }
});

// ---------------------------------------------------------------------------
// 1. writeSessionPin refuses risk-forced decisions
// ---------------------------------------------------------------------------

test('writeSessionPin: refuses method="risk"', () => {
  sessionAffinity._clearAll?.();
  routing.writeSessionPin('sess-risk-1', {
    provider: 'azure-anthropic', model: 'claude-sonnet-4-6',
    tier: 'COMPLEX', method: 'risk', score: 100,
  }, { messages: [{ role: 'user', content: 'x' }] });
  assert.equal(sessionAffinity.getPin('sess-risk-1'), null);
});

test('writeSessionPin: refuses method="risk+window" (OAuth intent path shape)', () => {
  sessionAffinity._clearAll?.();
  routing.writeSessionPin('sess-risk-2', {
    provider: 'azure-anthropic', model: 'claude-sonnet-4-6',
    tier: 'COMPLEX', method: 'risk+window', score: 100,
  }, { messages: [] });
  assert.equal(sessionAffinity.getPin('sess-risk-2'), null);
});

test('writeSessionPin: refuses escalation_source="risk" regardless of method', () => {
  sessionAffinity._clearAll?.();
  routing.writeSessionPin('sess-risk-3', {
    provider: 'azure-anthropic', model: 'claude-sonnet-4-6',
    tier: 'COMPLEX', method: 'tier_config', escalation_source: 'risk',
  }, { messages: [] });
  assert.equal(sessionAffinity.getPin('sess-risk-3'), null);
});

test('writeSessionPin: still writes normal decisions', () => {
  sessionAffinity._clearAll?.();
  routing.writeSessionPin('sess-ok-1', {
    provider: 'ollama', model: 'minimax-m2.5:cloud',
    tier: 'SIMPLE', method: 'tier_config+window', score: 12,
  }, { messages: [{ role: 'user', content: 'hi' }] });
  const pin = sessionAffinity.getPin('sess-ok-1');
  assert.ok(pin);
  assert.equal(pin.provider, 'ollama');
});

test('writeSessionPin: does not misfire on methods merely containing "risk" substring safely', () => {
  sessionAffinity._clearAll?.();
  // No current method contains "risk" as a substring other than the risk
  // path itself — this guards the guard: a hypothetical "asterisk" method
  // must not be blocked.
  routing.writeSessionPin('sess-ok-2', {
    provider: 'ollama', model: 'm', tier: 'SIMPLE', method: 'asterisk',
  }, { messages: [] });
  assert.ok(sessionAffinity.getPin('sess-ok-2'));
});

// ---------------------------------------------------------------------------
// 2. Badge stripping
// ---------------------------------------------------------------------------

const BADGE = '*[Lynkr] SIMPLE → minimax-m2.5:cloud (ollama) · score 12 · savings ~100%*\n\n';
const PASSTHROUGH_BADGE = '*[Lynkr] subscription-passthrough → claude-haiku-4-5-20251001 (azure-anthropic)*\n\n';

test('strip: badge-only string content becomes non-empty placeholder (not "")', () => {
  const out = stripLynkrBadges([{ role: 'assistant', content: BADGE }]);
  assert.equal(typeof out[0].content, 'string');
  assert.ok(out[0].content.length > 0, 'empty assistant content would 400 upstream');
  assert.ok(!out[0].content.includes('[Lynkr]'));
});

test('strip: merged "badge + real answer" block keeps the real answer', () => {
  const out = stripLynkrBadges([{
    role: 'assistant',
    content: [{ type: 'text', text: BADGE + 'The answer is 42.' }],
  }]);
  const texts = out[0].content.map(b => b.text).join(' ');
  assert.ok(texts.includes('The answer is 42.'), `real answer lost: ${JSON.stringify(out[0].content)}`);
  assert.ok(!texts.includes('[Lynkr]'));
});

test('strip: badge-only block array becomes non-empty placeholder content', () => {
  const out = stripLynkrBadges([{
    role: 'assistant',
    content: [{ type: 'text', text: PASSTHROUGH_BADGE }],
  }]);
  assert.ok(Array.isArray(out[0].content));
  assert.ok(out[0].content.length >= 1, 'empty content[] would 400 upstream');
  assert.ok(out[0].content[0].text.length > 0, 'empty text block would 400 upstream');
});

test('strip: standalone badge block dropped, sibling blocks preserved', () => {
  const out = stripLynkrBadges([{
    role: 'assistant',
    content: [
      { type: 'text', text: BADGE },
      { type: 'text', text: 'Real reply.' },
      { type: 'tool_use', id: 't1', name: 'Bash', input: {} },
    ],
  }]);
  assert.equal(out[0].content.length, 2);
  assert.equal(out[0].content[0].text, 'Real reply.');
  assert.equal(out[0].content[1].type, 'tool_use');
});

test('strip: user messages untouched even if quoting a badge', () => {
  const msgs = [{ role: 'user', content: BADGE + 'why do I see this line?' }];
  const out = stripLynkrBadges(msgs);
  assert.equal(out[0].content, msgs[0].content);
});

// ---------------------------------------------------------------------------
// 3. checkSessionPin: tool-less serves don't refresh the pin
// ---------------------------------------------------------------------------

test('checkSessionPin: tool-less serve does not refresh messageCount', () => {
  sessionAffinity._clearAll?.();
  process.env.LYNKR_STICKY_SESSIONS = 'true';
  sessionAffinity.setPin('fp-refresh-test', {
    provider: 'ollama', model: 'm', tier: 'SIMPLE',
  }, { messageCount: 3, promptTokensEst: 100 });

  // Tool-less side request replaying the conversation with MORE messages.
  const sideResult = routing.checkSessionPin({
    _sessionId: 'fp-refresh-test',
    messages: [
      { role: 'user', content: 'hi' }, { role: 'assistant', content: 'yo' },
      { role: 'user', content: 'q' }, { role: 'assistant', content: 'a' },
      { role: 'user', content: 'wrapper prompt replaying everything' },
    ],
    // no tools
  });
  assert.equal(sideResult.serve, true);
  assert.equal(sessionAffinity.getPin('fp-refresh-test').messageCount, 3,
    'side request must not overwrite messageCount');

  // Tooled interactive turn DOES refresh.
  const mainResult = routing.checkSessionPin({
    _sessionId: 'fp-refresh-test',
    tools: [{ name: 'Bash' }],
    messages: [
      { role: 'user', content: 'hi' }, { role: 'assistant', content: 'yo' },
      { role: 'user', content: 'next real turn' },
    ],
  });
  assert.equal(mainResult.serve, true);
  assert.equal(sessionAffinity.getPin('fp-refresh-test').messageCount, 3,
    'refresh only bumps ts/messageCount when shape matches; 3 msgs == stored 3');
});

// ---------------------------------------------------------------------------
// 4. Pinned-turn badge: fresh score + pin@N
// ---------------------------------------------------------------------------

const { buildInteractionBlock } = require('../src/routing/interaction');

test('interaction block carries pin_score on pinned decisions', () => {
  const block = buildInteractionBlock({
    provider: 'ollama', model: 'm', tier: 'SIMPLE',
    method: 'oauth-tier-routing', score: 14, _pinScore: 0,
  });
  assert.equal(block.complexity_score, 14);
  assert.equal(block.pin_score, 0);
});

test('interaction block pin_score is null on non-pinned decisions', () => {
  const block = buildInteractionBlock({
    provider: 'ollama', model: 'm', tier: 'SIMPLE',
    method: 'tier_config', score: 22,
  });
  assert.equal(block.pin_score, null);
});
