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

describe('cleanUserText', () => {
  it('extracts user-authored text, skips tool_result-only messages', () => {
    assert.strictEqual(jev.cleanUserText({ role: 'user', content: 'fix the parser' }), 'fix the parser');
    assert.strictEqual(
      jev.cleanUserText({ role: 'user', content: [{ type: 'tool_result', tool_use_id: '1', content: 'huge payload' }] }),
      null
    );
    assert.strictEqual(jev.cleanUserText({ role: 'user', content: 42 }), null);
  });

  it('strips harness wrappers and suggestion frames', () => {
    assert.strictEqual(
      jev.cleanUserText({ content: 'do X <system-reminder>secret noise</system-reminder>' }),
      'do X'
    );
    assert.strictEqual(jev.cleanUserText({ content: '[SUGGESTION MODE: complete this] Review the auth' }), null);
  });

  it('a command-tag-wrapped message cleans to null', () => {
    const msg = {
      role: 'user',
      content: '<command-name>/dex</command-name>\n<command-message>dex</command-message>\n<command-args>check new alerts</command-args>',
    };
    assert.strictEqual(jev.cleanUserText(msg), null);
  });

  it('strips paired local-command-stdout, keeps the ask', () => {
    assert.strictEqual(
      jev.cleanUserText({ content: 'summarize this run\n<local-command-stdout>massive dump</local-command-stdout>' }),
      'summarize this run'
    );
  });

  it('unclosed tag at line start strips to end of string', () => {
    const cleaned = jev.cleanUserText({
      content: 'fix parser.js first\n<local-command-stdout>dump line one\ndump line two with more text',
    });
    assert.strictEqual(cleaned, 'fix parser.js first');
  });

  it('unclosed tag mid-line is preserved (no truncation primitive)', () => {
    const text = 'why does "<command-args>" break my tokenizer after foo';
    assert.strictEqual(jev.cleanUserText({ content: text }), text);
  });
});

describe('jev-router state builder', () => {
  it('strips system-reminders and caps context at MAX_CONTEXT_CHARS', () => {
    const s = jev.buildJevState({
      text: 'do X <system-reminder>secret noise that should never reach a judge</system-reminder>',
      context: 'y'.repeat(900),
      signals: { message_count_bucket: 5, tools_attached: 11, has_tool_history: true, is_continuation: 1, task_open: 1 },
    });
    assert.ok(!JSON.stringify(s).includes('system-reminder'));
    assert.strictEqual(jev.MAX_CONTEXT_CHARS, 360);
    assert.strictEqual(s.conversation_context.length, 360);
    assert.strictEqual(s.signals.message_count_bucket, 5);
    assert.strictEqual(s.signals.tools_attached, 11);
    assert.strictEqual(s.signals.has_tool_history, 1);
    assert.strictEqual(s.signals.is_continuation, 1);
    assert.strictEqual(s.signals.task_open, 1);
  });

  it('passes through the flat signal set, missing fields → 0', () => {
    const s = jev.buildJevState({ text: 'x', signals: {} });
    assert.deepStrictEqual(s.signals, {
      message_count_bucket: 0,
      tools_attached: 0,
      effective_tools: 0,
      has_tool_history: 0,
      session_turn_bucket: 0,
      is_continuation: 0,
      inherited_floor: 0,
      task_open: 0,
      last_turn_tools_bucket: 0,
      last_turn_errors_bucket: 0,
    });
  });

  it('truncates pathological inputs with the shape intact', () => {
    const s = jev.buildJevState({ text: 'z'.repeat(9000) });
    assert.ok(s.current_request.length <= 4000);
    assert.ok(!('conversation_context' in s) || s.conversation_context === undefined);
  });

  it('criteria hash is a stable 12-hex fingerprint', () => {
    assert.match(jev.CRITERIA_HASH, /^[0-9a-f]{12}$/);
  });

  it('CRITERIA_HASH folds SIGNALS_SCHEMA_VERSION (bump flushes the cache)', () => {
    assert.strictEqual(jev._deriveCriteriaHash(jev.SIGNALS_SCHEMA_VERSION), jev.CRITERIA_HASH);
    assert.notStrictEqual(jev._deriveCriteriaHash(jev.SIGNALS_SCHEMA_VERSION + 1), jev.CRITERIA_HASH);
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

  it('sends one batched body with the continuation advisory in the criteria question', async () => {
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
    assert.ok(seen.body.questions.tier.instructions.includes('latest user message always wins'));
    assert.strictEqual(r.tier, 'COMPLEX');
  });
});

describe('jevTierOverride cap', () => {
  it('caps upward override at one band above capBaseTier', () => {
    assert.deepStrictEqual(
      jev.jevTierOverride({ jevTier: 'COMPLEX', jevConfidence: 0.4 }, 'SIMPLE', 'SIMPLE'),
      { tier: 'MEDIUM', score: 35 }
    );
  });

  it('capBase COMPLEX lets a REASONING verdict through', () => {
    assert.deepStrictEqual(
      jev.jevTierOverride({ jevTier: 'REASONING', jevConfidence: 0.4 }, 'MEDIUM', 'COMPLEX'),
      { tier: 'REASONING', score: 88 }
    );
  });

  it('missing capBaseTier falls back to baseTier (one band up)', () => {
    assert.deepStrictEqual(
      jev.jevTierOverride({ baseTier: 'SIMPLE', jevTier: 'COMPLEX', jevConfidence: 0.97 }),
      { tier: 'MEDIUM', score: 35 }
    );
  });

  it('downward overrides unchanged and uncapped', () => {
    assert.deepStrictEqual(
      jev.jevTierOverride({ baseTier: 'COMPLEX', jevTier: 'SIMPLE', jevConfidence: 0.95 }, null, 'SIMPLE'),
      { tier: 'SIMPLE', score: 10 }
    );
  });

  it('abstains when the cap collapses the move to the base tier', () => {
    assert.strictEqual(jev.jevTierOverride({ jevTier: 'REASONING', jevConfidence: 0.9 }, 'MEDIUM', 'SIMPLE'), null);
  });

  it('abstains on agreement, low confidence, or unknown tiers', () => {
    assert.strictEqual(jev.jevTierOverride({ baseTier: 'MEDIUM', jevTier: 'MEDIUM', jevConfidence: 0.99 }), null);
    assert.strictEqual(jev.jevTierOverride({ jevTier: 'COMPLEX', jevConfidence: 0.29 }, 'SIMPLE', 'COMPLEX'), null);
    assert.strictEqual(jev.jevTierOverride({ baseTier: 'SIMPLE', jevTier: 'GALAXY', jevConfidence: 0.99 }), null);
    assert.strictEqual(jev.jevTierOverride({}), null);
  });
});

describe('jevFloorTarget cap', () => {
  it('caps the floor at one band above capBaseTier', () => {
    assert.strictEqual(
      jev.jevFloorTarget({ selectedTier: 'SIMPLE', legacyTier: 'MEDIUM', jevTier: 'REASONING', jevConfidence: 0.9 }, 'SIMPLE'),
      'MEDIUM'
    );
  });

  it('missing capBaseTier leaves the floor uncapped', () => {
    assert.strictEqual(
      jev.jevFloorTarget({ selectedTier: 'SIMPLE', legacyTier: 'MEDIUM', jevTier: 'COMPLEX', jevConfidence: 0.97 }),
      'COMPLEX'
    );
  });

  it('capped floor already covered by the selection → null', () => {
    assert.strictEqual(
      jev.jevFloorTarget({ selectedTier: 'MEDIUM', legacyTier: 'SIMPLE', jevTier: 'REASONING', jevConfidence: 0.9 }, 'SIMPLE'),
      null
    );
  });

  it('no floor when confidence is low or tiers unknown', () => {
    assert.strictEqual(jev.jevFloorTarget({ selectedTier: 'SIMPLE', legacyTier: 'MEDIUM', jevTier: 'COMPLEX', jevConfidence: 0.29 }), null);
    assert.strictEqual(jev.jevFloorTarget({ selectedTier: 'SIMPLE', legacyTier: 'MEDIUM', jevTier: 'GALAXY', jevConfidence: 0.99 }), null);
    assert.strictEqual(jev.jevFloorTarget({}), null);
  });
});

describe('classifyJev LRU', () => {
  beforeEach(() => jev._clearCache());

  it('caches repeat asks (fetch once) and counts hits/misses', async () => {
    let calls = 0;
    const fetchFn = async () => { calls++; return okFetch(TIER_ANSWERS)(); };
    const a = await jev.classifyJev('same ask', { fetchFn, signals: {} });
    const b = await jev.classifyJev('same ask', { fetchFn, signals: {} });
    assert.strictEqual(calls, 1);
    assert.strictEqual(a.tier, 'COMPLEX');
    assert.strictEqual(b.cached, true);
    assert.deepStrictEqual(jev.getJevCacheStats(), { hits: 1, misses: 1 });
  });

  it('empty text short-circuits without fetching or counting', async () => {
    let calls = 0;
    const r = await jev.classifyJev('   ', { fetchFn: async () => { calls++; return {}; } });
    assert.strictEqual(r, null);
    assert.strictEqual(calls, 0);
    assert.deepStrictEqual(jev.getJevCacheStats(), { hits: 0, misses: 0 });
  });
});
