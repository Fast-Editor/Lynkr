const test = require('node:test');
const assert = require('node:assert');

process.env.LYNKR_KNN_DIR = process.env.LYNKR_KNN_DIR || '/tmp/lynkr-test-knn';

const rc = require('../src/routing/routing-config');
const signals = require('../src/routing/signals');
const decisions = require('../src/routing/decisions');
const outcomes = require('../src/routing/outcomes');

const CFG = {
  version: 1,
  mode: 'observe',
  anchor_bands: rc.DEFAULT_CONFIG.anchor_bands,
  harness: rc.DEFAULT_CONFIG.harness,
  signals: {
    anchor: { type: 'anchor_score' },
    judge: { type: 'jev', min_confidence: 0.5 },
    harness: { type: 'harness' },
    structured: { type: 'request_field', any_of: ['output_format', 'response_format'] },
    kw: { type: 'keyword', terms: ['recover', 'forensic'] },
    prev: { type: 'prev_outcome' },
    phase: { type: 'session_phase' },
  },
  decisions: [
    { name: 'escalate_on_regression', priority: 300, rules: { operator: 'AND', conditions: [{ signal: 'harness' }, { signal: 'prev', in: ['regression', 'no_progress'] }] }, tier: 'COMPLEX', effort: 'medium' },
    { name: 'hard', priority: 200, rules: { operator: 'AND', conditions: [{ signal: 'harness' }, { operator: 'OR', conditions: [{ signal: 'judge', tier_in: ['COMPLEX', 'REASONING'] }, { signal: 'anchor', band_in: ['COMPLEX', 'REASONING'] }, { signal: 'kw' }] }] }, tier: 'COMPLEX', effort: 'medium', hosts: ['DeepSeek'] },
    { name: 'easy', priority: 100, rules: { operator: 'AND', conditions: [{ signal: 'harness' }] }, tier: 'MEDIUM', effort: 'low' },
    { name: 'not_structured', priority: 10, rules: { operator: 'NOT', conditions: [{ signal: 'structured' }] }, tier: 'from:anchor' },
    { name: 'legacy', priority: 0, rules: { operator: 'AND', conditions: [] }, tier: 'from:legacy' },
  ],
};
const HARNESS = (instr) => `You are an AI assistant tasked with solving command-line tasks in a Linux environment.\n\nInstruction:\n${instr}\n\nYour response must be a JSON object.`;
const ctx = (over = {}) => ({ payload: { messages: [{ role: 'user', content: 'hello' }], tools: [] }, analysis: {}, legacy: { tier: 'MEDIUM', provider: 'p', model: 'm' }, risk: null, agenticResult: null, sessionId: null, prevTurns: [], ...over });

test('config validation catches shape errors', () => {
  const bad = { ...CFG, decisions: [{ name: 'a', priority: 1, rules: { operator: 'XOR', conditions: [] } }, { name: 'a', priority: 1, rules: { operator: 'AND', conditions: [{ signal: 'nope' }] }, tier: 'HUGE' }] };
  const errs = rc.validate(bad);
  assert.ok(errs.some((e) => /operator/.test(e)));
  assert.ok(errs.some((e) => /duplicate name/.test(e)));
  assert.ok(errs.some((e) => /priority 1 also used/.test(e)));
  assert.ok(errs.some((e) => /unknown signal "nope"/.test(e)));
  assert.ok(errs.some((e) => /tier must be/.test(e)));
  assert.deepStrictEqual(rc.validate(CFG), []);
});

test('default config agrees with legacy by construction', async () => {
  const r = await decisions.evaluate(ctx({ legacy: { tier: 'COMPLEX', provider: 'p', model: 'm' } }), rc.DEFAULT_CONFIG);
  assert.strictEqual(r.decision, 'legacy');
  assert.strictEqual(r.tier, 'COMPLEX');
  assert.strictEqual(r.agreesWithLegacy, true);
});

test('decisions walk by priority, first match wins; nested OR/NOT work', async () => {
  // harness + judge COMPLEX → hard
  let r = await decisions.evaluate(ctx({ payload: { messages: [{ role: 'user', content: HARNESS('build a kernel module') }] }, analysis: { anchorScore: 40, jev: { tier: 'COMPLEX', confidence: 0.9 } } }), CFG);
  assert.strictEqual(r.decision, 'hard'); assert.strictEqual(r.tier, 'COMPLEX'); assert.strictEqual(r.effort, 'medium'); assert.deepStrictEqual(r.hosts, ['DeepSeek']);
  // harness + weak judge + low anchor + no keyword → easy
  r = await decisions.evaluate(ctx({ payload: { messages: [{ role: 'user', content: HARNESS('create hello.txt') }] }, analysis: { anchorScore: 30, jev: { tier: 'COMPLEX', confidence: 0.3 } } }), CFG);
  assert.strictEqual(r.decision, 'easy'); assert.strictEqual(r.tier, 'MEDIUM'); assert.strictEqual(r.effort, 'low');
  // harness + keyword → hard even with low anchor
  r = await decisions.evaluate(ctx({ payload: { messages: [{ role: 'user', content: HARNESS('recover the deleted file') }] }, analysis: { anchorScore: 30 } }), CFG);
  assert.strictEqual(r.decision, 'hard');
  // non-harness, not structured → from:anchor
  r = await decisions.evaluate(ctx({ analysis: { anchorScore: 80 } }), CFG);
  assert.strictEqual(r.decision, 'not_structured'); assert.strictEqual(r.tier, 'REASONING');
  // non-harness, structured → NOT fails → legacy
  r = await decisions.evaluate(ctx({ payload: { messages: [{ role: 'user', content: 'x' }], output_format: { type: 'json_object' } }, analysis: { anchorScore: 80 } }), CFG);
  assert.strictEqual(r.decision, 'legacy'); assert.strictEqual(r.tier, 'MEDIUM');
  assert.ok(r.trace.considered.length === 5);
});

test('prev_outcome signal drives escalation decision', async () => {
  const r = await decisions.evaluate(ctx({ payload: { messages: [{ role: 'user', content: HARNESS('do x') }] }, analysis: { anchorScore: 30 }, prevTurns: [{ outcome: 'regression', attributable: true, streak: 2 }] }), CFG);
  assert.strictEqual(r.decision, 'escalate_on_regression'); assert.strictEqual(r.tier, 'COMPLEX');
});

test('headerSummary is compact and header-safe', async () => {
  const r = await decisions.evaluate(ctx({ payload: { messages: [{ role: 'user', content: HARNESS('do x') }] }, analysis: { anchorScore: 30 } }), CFG);
  const h = decisions.headerSummary(r);
  assert.strictEqual(h['X-Lynkr-Decision'], 'easy');
  assert.ok(/harness=/.test(h['X-Lynkr-Signals']));
  assert.ok(h['X-Lynkr-Signals'].length <= 500);
});

test('testCondition semantics', () => {
  const s = { a: { matched: true, value: 7, confidence: 0.8, band: 'COMPLEX', tier: 'COMPLEX' }, b: { matched: false, value: null } };
  assert.ok(signals.testCondition({ signal: 'a' }, s));
  assert.ok(!signals.testCondition({ signal: 'b' }, s));
  assert.ok(signals.testCondition({ signal: 'a', min: 5, max: 7 }, s));
  assert.ok(!signals.testCondition({ signal: 'a', min: 8 }, s));
  assert.ok(signals.testCondition({ signal: 'a', min_confidence: 0.8 }, s));
  assert.ok(signals.testCondition({ signal: 'a', min_tier: 'MEDIUM' }, s));
  assert.ok(!signals.testCondition({ signal: 'a', min_tier: 'REASONING' }, s));
  assert.ok(!signals.testCondition({ signal: 'zzz' }, s));
});

test('outcome classifier: progress, retry→regression, same-cmd no_progress, env/tool/provider errors', () => {
  outcomes._clear();
  const sid = 's1';
  const u0 = { role: 'user', content: HARNESS('list files') };
  const a0 = { role: 'assistant', content: '{"commands":[{"keystrokes":"ls\\n"}],"is_task_complete":false}' };
  // request 1 has no assistant turn → nothing to classify
  assert.strictEqual(outcomes.classifyPrevious({ sessionId: sid, payload: { messages: [u0] } }), null);
  // request 2: new output → progress
  let r = outcomes.classifyPrevious({ sessionId: sid, payload: { messages: [u0, a0, { role: 'user', content: 'a.txt b.txt' }] } });
  assert.strictEqual(r.outcome, 'progress'); assert.strictEqual(r.attributable, true);
  // request 3: identical resend of request 2 (parse retry) → regression
  r = outcomes.classifyPrevious({ sessionId: sid, payload: { messages: [u0, a0, { role: 'user', content: 'a.txt b.txt' }] } });
  assert.strictEqual(r.outcome, 'regression'); assert.strictEqual(r.evidence.reason, 'identical_conversation_retry'); assert.strictEqual(r.streak, 1);
  // request 4: same command batch, same output → no_progress, streak grows
  const a1 = { role: 'assistant', content: '{"commands":[{"keystrokes":"ls\\n"}],"is_task_complete":false}' };
  r = outcomes.classifyPrevious({ sessionId: sid, payload: { messages: [u0, a0, { role: 'user', content: 'a.txt b.txt' }, a1, { role: 'user', content: 'a.txt b.txt' }] } });
  assert.strictEqual(r.outcome, 'no_progress'); assert.strictEqual(r.streak, 2);
  // environment error is not attributable and does not break the streak
  r = outcomes.classifyPrevious({ sessionId: sid, payload: { messages: [u0, a0, { role: 'user', content: 'bash: foo: command not found' }] } });
  assert.strictEqual(r.outcome, 'tool_error'); assert.strictEqual(r.attributable, false);
  // provider error from the gateway record wins over content
  r = outcomes.classifyPrevious({ sessionId: sid, payload: { messages: [u0, a0, { role: 'user', content: 'fine' }] }, prevRecord: { statusCode: 504, errorType: 'UPSTREAM_TIMEOUT' } });
  assert.strictEqual(r.outcome, 'provider_error'); assert.strictEqual(r.attributable, false);
  // tool_result is_error
  r = outcomes.classifyPrevious({ sessionId: sid, payload: { messages: [u0, a0, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', is_error: true, content: 'boom' }] }] } });
  assert.strictEqual(r.outcome, 'tool_error');
  assert.strictEqual(outcomes.rewardFor('progress'), 1);
  assert.strictEqual(outcomes.rewardFor('provider_error'), null);
  assert.ok(outcomes.ring(sid).length <= 8);
});

test('harness patterns come from config and carry a name', () => {
  rc._resetForTests({ ...rc.DEFAULT_CONFIG, harness: { patterns: [{ name: 'mini-swe', preamble: 'You are a helpful assistant that can interact with a computer', instruction: 'Task:\\s*\\n([\\s\\S]*?)\\n\\n' }] } });
  const he = require('../src/routing/harness-envelope');
  const ask = he.harnessAskFromPayload({ messages: [{ role: 'user', content: 'You are a helpful assistant that can interact with a computer.\nTask:\nfix the build\n\nRespond in JSON.' }] });
  assert.ok(ask); assert.strictEqual(ask.name, 'mini-swe'); assert.strictEqual(ask.text, 'fix the build');
  rc._resetForTests();
});
