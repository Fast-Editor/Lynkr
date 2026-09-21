const assert = require('assert');
const { describe, it, beforeEach } = require('node:test');

const jev = require('../src/routing/jev-router');

const okFetch = (answers, model = 'jev-1.13.0') => async () => ({
  ok: true,
  json: async () => ({ model, answers }),
});

const TIER_ANSWERS = {
  tier: {
    type: 'choice', choice: 'COMPLEX',
    probabilities: { SIMPLE: 0.01, MEDIUM: 0.02, COMPLEX: 0.97, REASONING: 0.0 },
    confidence: 0.97,
  },
  risky: { type: 'noul', noul: 0.12 },
};

describe('jev-router state builder', () => {
  it('strips system-reminders and caps lengths', () => {
    const s = jev.buildJevState({
      text: 'do X <system-reminder>secret noise that should never reach a judge</system-reminder>',
      context: 'y'.repeat(900),
      signals: { message_count: 5, tools_attached: 11, effective_tools: 0, has_tool_history: true, session_turn: 3 },
    });
    assert.ok(!JSON.stringify(s).includes('system-reminder'));
    assert.ok(s.conversation_context.length <= 500);
    assert.strictEqual(s.signals.tools_attached, 11);
    assert.strictEqual(s.signals.has_tool_history, true);
  });

  it('truncates pathological inputs with the shape intact', () => {
    const s = jev.buildJevState({ text: 'z'.repeat(9000) });
    assert.ok(s.current_request.length <= 4000);
    assert.ok(!('conversation_context' in s) || s.conversation_context === undefined);
  });

  it('criteria hash is a stable 12-hex fingerprint', () => {
    assert.match(jev.CRITERIA_HASH, /^[0-9a-f]{12}$/);
  });
});

describe('evaluateJev', () => {
  it('parses tier + risk + model from a good response', async () => {
    const r = await jev.evaluateJev({ current_request: 'x' }, { fetchFn: okFetch(TIER_ANSWERS), apiKey: 'k' });
    assert.strictEqual(r.tier, 'COMPLEX');
    assert.strictEqual(r.confidence, 0.97);
    assert.strictEqual(r.risky, 0.12);
    assert.strictEqual(r.model, 'jev-1.13.0');
    assert.strictEqual(r.criteriaHash, jev.CRITERIA_HASH);
    assert.ok(typeof r.latencyMs === 'number');
  });

  it('normalizes tier casing, rejects unknown tiers', async () => {
    const lower = await jev.evaluateJev({}, {
      fetchFn: okFetch({ tier: { choice: 'reasoning', confidence: 0.9 } }), apiKey: 'k',
    });
    assert.strictEqual(lower.tier, 'REASONING');
    const bogus = await jev.evaluateJev({}, {
      fetchFn: okFetch({ tier: { choice: 'GALAXY', confidence: 1 } }), apiKey: 'k',
    });
    assert.strictEqual(bogus, null);
  });

  it('fail-soft: non-ok, throw, malformed, missing key', async () => {
    assert.strictEqual(await jev.evaluateJev({}, { fetchFn: async () => ({ ok: false, status: 429 }), apiKey: 'k' }), null);
    assert.strictEqual(await jev.evaluateJev({}, { fetchFn: async () => { throw new Error('down'); }, apiKey: 'k' }), null);
    assert.strictEqual(await jev.evaluateJev({}, { fetchFn: okFetch(null), apiKey: 'k' }), null);
    assert.strictEqual(await jev.evaluateJev({}, { fetchFn: okFetch({ tier: null }), apiKey: 'k' }), null);
    const saved = process.env.TYPESAFE_API_KEY;
    delete process.env.TYPESAFE_API_KEY;
    try {
      assert.strictEqual(await jev.evaluateJev({}, { fetchFn: okFetch(TIER_ANSWERS) }), null);
    } finally {
      if (saved !== undefined) process.env.TYPESAFE_API_KEY = saved;
    }
  });

  it('sends one batched body (tier + risky sharing state)', async () => {
    let seen = null;
    const r = await jev.evaluateJev({ current_request: 'hi' }, {
      apiKey: 'k',
      fetchFn: async (url, opts) => {
        seen = { url, body: JSON.parse(opts.body), auth: opts.headers.Authorization };
        return okFetch(TIER_ANSWERS)();
      },
    });
    assert.strictEqual(seen.url, jev.JEV_ENDPOINT);
    assert.strictEqual(seen.auth, 'Bearer k');
    assert.strictEqual(seen.body.model, jev.JEV_MODEL);
    assert.ok(seen.body.questions.tier && seen.body.questions.risky);
    assert.strictEqual(r.tier, 'COMPLEX');
  });
});

describe('classifyJev LRU', () => {
  beforeEach(() => jev._clearCache());

  it('caches repeat asks (fetch once)', async () => {
    let calls = 0;
    const fetchFn = async () => { calls++; return okFetch(TIER_ANSWERS)(); };
    const a = await jev.classifyJev('same ask', { fetchFn, signals: {} });
    const b = await jev.classifyJev('same ask', { fetchFn, signals: {} });
    assert.strictEqual(calls, 1);
    assert.strictEqual(a.tier, 'COMPLEX');
    assert.strictEqual(b.cached, true);
  });

  it('empty text short-circuits without fetching', async () => {
    let calls = 0;
    const r = await jev.classifyJev('   ', { fetchFn: async () => { calls++; return {}; } });
    assert.strictEqual(r, null);
    assert.strictEqual(calls, 0);
  });
});
