const test = require('node:test');
const assert = require('node:assert/strict');

const clientProfiles = require('../src/routing/client-profiles');
const { analyzeRisk } = require('../src/routing/risk-classifier');
const { extractSessionId } = require('../src/api/middleware/session');

const OCR_TOOLS = [
  { name: 'task_done', description: 'finish' },
  { name: 'code_comment', description: 'comment' },
  { name: 'file_read', description: 'read' },
  { name: 'file_read_diff', description: 'diff' },
];

test('detects open-code-review via User-Agent', () => {
  const profile = clientProfiles.detectClient({
    headers: { 'user-agent': 'open-code-review/v1.9.6 | openai' },
    payload: { tools: [] },
  });
  assert.ok(profile, 'expected a profile match');
  assert.equal(profile.name, 'open-code-review');
});

test('fingerprint fallback via OCR toolset without UA', () => {
  const profile = clientProfiles.detectClient({
    headers: {},
    payload: { tools: OCR_TOOLS },
  });
  assert.ok(profile, 'expected fingerprint match');
  assert.equal(profile.name, 'open-code-review');
});

test('effectiveTools strips OCR baseline', () => {
  const profile = clientProfiles.detectClient({
    headers: { 'user-agent': 'open-code-review/dev' },
    payload: { tools: OCR_TOOLS },
  });
  const effective = clientProfiles.effectiveTools({ tools: OCR_TOOLS }, profile);
  assert.equal(effective.length, 0, 'pure-baseline bundle should score zero tools');
  const withExtra = clientProfiles.effectiveTools(
    { tools: [...OCR_TOOLS, { name: 'my_custom_search' }] },
    profile
  );
  assert.equal(withExtra.length, 1);
  assert.equal(withExtra[0].name, 'my_custom_search');
});

test('risk classifier ignores OCR system ruleset but fires on diff text', () => {
  const rulesetSystem = 'Review rules: check for SQL injection, XSS, authentication, secrets, credentials.';
  const trivialDiff = { messages: [{ role: 'user', content: 'Fix typo in README' }] };
  // Baseline without profile: system rules DO escalate (documents current behavior)
  const baseline = analyzeRisk({ ...trivialDiff, system: rulesetSystem, tools: [] });
  // OCR-profiled: same system must not escalate
  const ocrCalm = analyzeRisk({
    ...trivialDiff,
    system: rulesetSystem,
    tools: OCR_TOOLS,
    _clientProfile: { name: 'open-code-review' },
  });
  assert.notEqual(ocrCalm.level, 'high', `OCR system ruleset must not force high, got ${ocrCalm.level}`);
  // Fingerprint fallback (no _clientProfile attached yet) behaves the same
  const ocrFp = analyzeRisk({ ...trivialDiff, system: rulesetSystem, tools: OCR_TOOLS });
  assert.notEqual(ocrFp.level, 'high', `fingerprint fallback must not force high, got ${ocrFp.level}`);
  // Genuinely risky DIFF text still fires under OCR profile
  const riskyDiff = analyzeRisk({
    messages: [{ role: 'user', content: 'Rewrite authentication to decrypt credentials inline' }],
    tools: OCR_TOOLS,
    _clientProfile: { name: 'open-code-review' },
  });
  assert.equal(riskyDiff.level, 'high');
  void baseline; // documents pre-existing system-sensitive behavior for non-OCR traffic
});

test('extractSessionId honors x-session-affinity per-bundle keys', () => {
  const mkReq = (headers) => ({ headers, body: { messages: [] } });
  assert.equal(
    extractSessionId(mkReq({ 'x-session-affinity': 'bundle-aaa' })),
    'bundle-aaa'
  );
  // Unsubstituted OCR template placeholder falls through (no crash, no literal key)
  const fallback = extractSessionId(mkReq({ 'x-session-affinity': '{ocr_session_key}' }));
  assert.ok(fallback && fallback !== '{ocr_session_key}', 'placeholder must not become session id');
  // Explicit x-session-id still wins over affinity header
  assert.equal(
    extractSessionId(mkReq({ 'x-session-id': 'primary', 'x-session-affinity': 'bundle-aaa' })),
    'primary'
  );
});
