const test = require('node:test');
const assert = require('node:assert');

process.env.LYNKR_KNN_DIR = process.env.LYNKR_KNN_DIR || '/tmp/lynkr-test-knn';
process.env.LYNKR_NLI_LIB_PATH = '/nonexistent'; // grounding must fail open without the runtime

const rc = require('../src/routing/routing-config');
const gate = require('../src/routing/switch-gate');
const grounding = require('../src/routing/grounding');
const decisions = require('../src/routing/decisions');

const T = (outcome, attributable = true) => ({ outcome, attributable });

test('switch gate: hysteresis, noise skipping, budget, cooldown', () => {
  gate._clear();
  rc._resetForTests({ ...rc.DEFAULT_CONFIG, switch_gate: { mode: 'enforce', escalate_after_regressions: 2, downgrade_after_recoveries: 3, min_turns_before_switch: 2, max_switches_per_session: 1, cooldown_turns: 2 } });
  // too early
  let g = gate.evaluate({ sessionId: 's', currentTier: 'MEDIUM', ring: [T('regression'), T('regression')], turn: 1 });
  assert.strictEqual(g.action, 'stay'); assert.strictEqual(g.reason, 'too_early');
  // one regression + noise does not escalate
  g = gate.evaluate({ sessionId: 's', currentTier: 'MEDIUM', ring: [T('progress'), T('regression'), T('provider_error', false)], turn: 4 });
  assert.strictEqual(g.action, 'stay'); assert.ok(/below_threshold/.test(g.reason));
  // two attributable regressions with noise in between → escalate to COMPLEX
  g = gate.evaluate({ sessionId: 's', currentTier: 'MEDIUM', ring: [T('progress'), T('regression'), T('tool_error', false), T('no_progress')], turn: 5 });
  assert.strictEqual(g.action, 'escalate'); assert.strictEqual(g.target, 'COMPLEX'); assert.strictEqual(g.enforced, true); assert.strictEqual(g.streak, 2);
  gate.commit('s', g, 5);
  assert.strictEqual(gate.floor('s'), 'COMPLEX');
  // budget exhausted (max 1 switch)
  g = gate.evaluate({ sessionId: 's', currentTier: 'COMPLEX', ring: [T('regression'), T('regression'), T('regression')], turn: 9 });
  assert.strictEqual(g.action, 'stay'); assert.strictEqual(g.reason, 'switch_budget_exhausted');
  // top tier cannot escalate
  gate._clear();
  g = gate.evaluate({ sessionId: 't', currentTier: 'REASONING', ring: [T('regression'), T('regression')], turn: 3 });
  assert.strictEqual(g.action, 'stay'); assert.strictEqual(g.reason, 'already_top_tier');
  // downgrade only above the base tier after recoveries
  g = gate.evaluate({ sessionId: 'u', currentTier: 'COMPLEX', ring: [T('progress'), T('progress'), T('progress')], turn: 6, baseTier: 'MEDIUM' });
  assert.strictEqual(g.action, 'downgrade'); assert.strictEqual(g.target, 'MEDIUM');
  g = gate.evaluate({ sessionId: 'v', currentTier: 'MEDIUM', ring: [T('progress'), T('progress'), T('progress')], turn: 6, baseTier: 'MEDIUM' });
  assert.strictEqual(g.action, 'stay');
  // observe mode never enforces
  rc._resetForTests({ ...rc.DEFAULT_CONFIG, switch_gate: { mode: 'observe', escalate_after_regressions: 1, min_turns_before_switch: 0 } });
  g = gate.evaluate({ sessionId: 'w', currentTier: 'MEDIUM', ring: [T('regression')], turn: 2 });
  assert.strictEqual(g.action, 'escalate'); assert.strictEqual(g.enforced, false);
  rc._resetForTests();
});

test('grounding: claim extraction for structured and prose replies, evidence tail', async () => {
  let c = grounding.extractClaims('{"state_analysis":"File written and verified.","explanation":"Done.","commands":[],"is_task_complete":true}');
  assert.strictEqual(c.claimsDone, true); assert.deepStrictEqual(c.claims, ['File written and verified.', 'Done.']);
  c = grounding.extractClaims('{"state_analysis":"Still exploring.","commands":[{"keystrokes":"ls\\n"}],"is_task_complete":false}');
  assert.strictEqual(c.claimsDone, false);
  c = grounding.extractClaims('I ran the tests and all tests pass. The task is complete now.');
  assert.strictEqual(c.claimsDone, true); assert.ok(c.claims.length >= 1);
  const ev = grounding.extractEvidence([{ role: 'user', content: 'x' }, { role: 'assistant', content: 'y' }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'OUTPUT ' + 'z'.repeat(5000) }] }]);
  assert.ok(ev.length <= 4000 && ev.endsWith('z'));
  // without the runtime: skipped, never throws
  const r = await grounding.check({ replyText: '{"is_task_complete":true,"state_analysis":"done"}', messages: [{ role: 'user', content: 'root@box# ls' }] });
  assert.ok(['skipped', 'unverified'].includes(r.verdict));
  const r2 = await grounding.check({ replyText: '{"is_task_complete":false}', messages: [] });
  assert.strictEqual(r2.verdict, 'skipped'); assert.strictEqual(r2.reason, 'no_completion_claim');
});

test('cascade trigger fires on an ambiguous judge and records the margin', async () => {
  const cfg = { ...rc.DEFAULT_CONFIG, cascade: { trigger_margin: 0.15, mode: 'observe' } };
  const base = { payload: { messages: [{ role: 'user', content: 'x' }] }, legacy: { tier: 'MEDIUM' }, risk: null, agenticResult: null, prevTurns: [] };
  let r = await decisions.evaluate({ ...base, analysis: { anchorScore: 40, jev: { tier: 'MEDIUM', confidence: 0.47, probabilities: { MEDIUM: 0.47, COMPLEX: 0.43, SIMPLE: 0.1 } } } }, cfg);
  assert.ok(r.cascade); assert.strictEqual(r.cascade.triggered, true); assert.ok(Math.abs(r.cascade.margin - 0.04) < 1e-6);
  r = await decisions.evaluate({ ...base, analysis: { anchorScore: 40, jev: { tier: 'COMPLEX', confidence: 0.9, probabilities: { COMPLEX: 0.9, MEDIUM: 0.1 } } } }, cfg);
  assert.strictEqual(r.cascade.triggered, false);
  r = await decisions.evaluate({ ...base, analysis: { anchorScore: 40 } }, cfg);
  assert.strictEqual(r.cascade, null);
});
