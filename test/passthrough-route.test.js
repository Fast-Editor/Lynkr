const assert = require('assert');
const { describe, it, beforeEach, afterEach } = require('node:test');

const route = require('../src/routing/passthrough-route');

const HAIKU = 'claude-haiku-4-5-20251001';
const SONNET = 'claude-sonnet-4-5';
const OPUS = 'claude-opus-4-5';

describe('passthrough-route family ranking', () => {
  it('ranks short, dated and prefixed ids', () => {
    assert.strictEqual(route.familyRank(HAIKU), 1);
    assert.strictEqual(route.familyRank('claude-haiku-4-5'), 1);
    assert.strictEqual(route.familyRank(SONNET), 2);
    assert.strictEqual(route.familyRank('claude-sonnet-4-5-20250929'), 2);
    assert.strictEqual(route.familyRank(OPUS), 3);
    assert.strictEqual(route.familyRank('anthropic/claude-opus-4-5'), 3);
  });

  it('returns null for unknown models (fail-closed)', () => {
    assert.strictEqual(route.familyRank(null), null);
    assert.strictEqual(route.familyRank(''), null);
    assert.strictEqual(route.familyRank('gpt-5.6-sol'), null);
    assert.strictEqual(route.familyRank('glm-5.2'), null);
  });
});

describe('decidePassthroughModel', () => {
  const ENV_KEY = 'LYNKR_PASSTHROUGH_MODEL_ROUTING';
  let saved;
  beforeEach(() => { saved = process.env[ENV_KEY]; delete process.env[ENV_KEY]; });
  afterEach(() => {
    if (saved === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = saved;
  });

  it('upgrades when the tier model outranks the client model', () => {
    const r = route.decidePassthroughModel({ tierModel: SONNET, clientModel: HAIKU });
    assert.strictEqual(r.action, 'upgrade');
    assert.strictEqual(r.model, SONNET);
  });

  it('upgrades haiku straight to opus on REASONING tiers', () => {
    const r = route.decidePassthroughModel({ tierModel: OPUS, clientModel: HAIKU });
    assert.strictEqual(r.action, 'upgrade');
    assert.strictEqual(r.model, OPUS);
  });

  it('never downgrades: client opus + haiku tier stays verbatim', () => {
    const r = route.decidePassthroughModel({ tierModel: HAIKU, clientModel: OPUS });
    assert.strictEqual(r.action, 'verbatim');
    assert.strictEqual(r.model, OPUS);
  });

  it('is a no-op when tier and client agree', () => {
    const r = route.decidePassthroughModel({ tierModel: HAIKU, clientModel: HAIKU });
    assert.strictEqual(r.action, 'verbatim');
    assert.strictEqual(r.model, HAIKU);
  });

  it('downgrades when no cache state exists (nothing warm to protect)', () => {
    const r = route.decidePassthroughModel({ tierModel: HAIKU, clientModel: HAIKU, pinModel: SONNET, cacheState: null });
    assert.strictEqual(r.action, 'verbatim');
    assert.strictEqual(r.model, HAIKU);
    assert.strictEqual(r.reason, 'downgrade_no_cache_state');
  });

  it('fresh tier upgrade still fires', () => {
    const r = route.decidePassthroughModel({ tierModel: OPUS, clientModel: HAIKU, pinModel: SONNET });
    assert.strictEqual(r.action, 'upgrade');
    assert.strictEqual(r.model, OPUS);
  });

  it('side-channel tiers never upgrade', () => {
    const r = route.decidePassthroughModel({
      tierModel: OPUS, clientModel: HAIKU, tierMethod: 'side_request_suggestion', tierPinned: false,
    });
    assert.strictEqual(r.action, 'verbatim');
    assert.strictEqual(r.reason, 'side_request');
  });

  it('fails closed on unknown client or tier models', () => {
    const a = route.decidePassthroughModel({ tierModel: SONNET, clientModel: 'custom-model-9z' });
    assert.strictEqual(a.action, 'verbatim');
    assert.strictEqual(a.model, 'custom-model-9z');
    const b = route.decidePassthroughModel({ tierModel: 'glm-5.2', clientModel: HAIKU });
    assert.strictEqual(b.action, 'verbatim');
    assert.strictEqual(b.model, HAIKU);
    const c = route.decidePassthroughModel({ tierModel: null, clientModel: HAIKU });
    assert.strictEqual(c.action, 'verbatim');
  });

  it('kill-switch restores pure verbatim', () => {
    process.env[ENV_KEY] = 'false';
    const r = route.decidePassthroughModel({ tierModel: OPUS, clientModel: HAIKU });
    assert.strictEqual(r.action, 'verbatim');
    assert.strictEqual(r.reason, 'routing_disabled');
    assert.strictEqual(r.model, HAIKU);
  });
});
describe('downgrade gate (dollar break-even, normal-flow math)', () => {
  const warm = (tokens, extra = {}) => ({
    warmPrefixTokens: tokens, provider: 'azure-anthropic', model: OPUS,
    lastRequestAt: Date.now(), ttlMs: 300000, cold: false, ...extra,
  });
  const args = (cacheState, extra = {}) => ({
    tierModel: HAIKU, clientModel: HAIKU, pinModel: OPUS, cacheState, ...extra,
  });

  it('downgrades on a warm prefix when sessions remain (Opus premium dwarfs one re-read)', () => {
    // Real registry prices: break-even clears in a fraction of a turn.
    const r = route.decidePassthroughModel(args(warm(12500)));
    assert.strictEqual(r.action, 'verbatim');
    assert.strictEqual(r.reason, 'downgrade_break_even_cleared');
  });

  it('holds when the session is nearly over (nothing to amortize over)', () => {
    const r = route.decidePassthroughModel(args(warm(12500), { remainingTurns: 0.2 }));
    assert.strictEqual(r.action, 'pin_hold');
    assert.strictEqual(r.model, OPUS);
    assert.strictEqual(r.reason, 'hold_break_even_blocked');
  });

  it('downgrades on a TTL-cold prefix', () => {
    const r = route.decidePassthroughModel(args(warm(12500, { cold: true })));
    assert.strictEqual(r.action, 'verbatim');
    assert.strictEqual(r.reason, 'downgrade_cache_cold');
  });

  it('downgrades on stale-model cache state', () => {
    const r = route.decidePassthroughModel(args(warm(12500, { model: SONNET })));
    assert.strictEqual(r.action, 'verbatim');
    assert.strictEqual(r.reason, 'downgrade_cache_stale');
  });

  it('downgrades on a small warm prefix without running the math', () => {
    let called = false;
    const r = route.decidePassthroughModel(args(warm(300), {
      evaluateSwitch: (...a) => { called = true; return null; },
    }));
    assert.strictEqual(r.action, 'verbatim');
    assert.strictEqual(r.reason, 'downgrade_prefix_small');
    assert.strictEqual(called, false);
  });

  it('upgrades always fire, even on a warm prefix (correctness beats cache)', () => {
    const r = route.decidePassthroughModel({
      tierModel: OPUS, clientModel: HAIKU, pinModel: HAIKU, cacheState: warm(20000),
    });
    assert.strictEqual(r.action, 'upgrade');
    assert.strictEqual(r.model, OPUS);
  });

  it('downgrades at the boundary (below 2000 warm tokens)', () => {
    const r = route.decidePassthroughModel(args(warm(1999)));
    assert.strictEqual(r.action, 'verbatim');
    assert.strictEqual(r.reason, 'downgrade_prefix_small');
  });

  it('evaluator failure fails toward the hold (never strand on an error)', () => {
    const r = route.decidePassthroughModel(args(warm(9000), {
      evaluateSwitch: () => { throw new Error('econ down'); },
    }));
    assert.strictEqual(r.action, 'pin_hold');
    assert.strictEqual(r.reason, 'hold_evaluator_failed');
  });

  it('unpriced target holds (economics unknown, fail toward pin)', () => {
    const r = route.decidePassthroughModel(args(warm(9000), {
      evaluateSwitch: () => ({ switchAllowed: false, reason: 'never_profitable', breakEvenTurns: Infinity }),
    }));
    assert.strictEqual(r.action, 'pin_hold');
  });
});

describe('decidePassthroughModel rule 4a (pin→tier step-down consults the gate)', () => {
  const warmOpus = (tokens, extra = {}) => ({
    warmPrefixTokens: tokens, provider: 'azure-anthropic', model: OPUS,
    lastRequestAt: Date.now(), ttlMs: 300000, cold: false, ...extra,
  });

  it('holds Opus on a Sonnet verdict while break-even blocks', () => {
    const r = route.decidePassthroughModel({
      tierModel: SONNET, clientModel: HAIKU, pinModel: OPUS,
      cacheState: warmOpus(12500), remainingTurns: 0.2,
    });
    assert.strictEqual(r.action, 'pin_hold');
    assert.strictEqual(r.model, OPUS);
    assert.strictEqual(r.reason, 'hold_break_even_blocked');
  });

  it('steps pin Opus down to Sonnet when the gate clears (no cliff to Haiku)', () => {
    const r = route.decidePassthroughModel({
      tierModel: SONNET, clientModel: HAIKU, pinModel: OPUS,
      cacheState: warmOpus(12500),
    });
    assert.strictEqual(r.action, 'upgrade');
    assert.strictEqual(r.model, SONNET);
  });

  it('genuine upgrades still skip the gate (no higher pin)', () => {
    let called = false;
    const r = route.decidePassthroughModel({
      tierModel: SONNET, clientModel: HAIKU, pinModel: HAIKU,
      cacheState: warmOpus(20000),
      evaluateSwitch: (...a) => { called = true; return null; },
    });
    assert.strictEqual(r.action, 'upgrade');
    assert.strictEqual(r.model, SONNET);
    assert.strictEqual(called, false);
  });

  it('threads sessionBurnPressure into the gate', () => {
    let seen = null;
    const r = route.decidePassthroughModel({
      tierModel: HAIKU, clientModel: HAIKU, pinModel: OPUS,
      cacheState: warmOpus(9000), sessionBurnPressure: 0.8,
      evaluateSwitch: (a) => { seen = a.sessionBurnPressure; return { switchAllowed: true, reason: 'break_even_cleared', breakEvenTurns: 1 }; },
    });
    assert.strictEqual(r.action, 'verbatim');
    assert.strictEqual(seen, 0.8);
  });
});

describe('buildPassthroughBadge', () => {
  const { buildPassthroughBadge } = route;

  it('marks upgrades +route', () => {
    const b = buildPassthroughBadge({ action: 'upgrade', model: undefined, routeModel: OPUS, clientModel: HAIKU, tierName: 'REASONING' });
    assert.ok(b.includes('+route'), b);
    assert.ok(b.includes(OPUS), b);
    assert.ok(b.includes('REASONING'), b);
  });

  it('marks holds +hold with the gate reason', () => {
    const b = buildPassthroughBadge({ action: 'pin_hold', reason: 'hold_break_even_blocked', routeModel: OPUS, clientModel: HAIKU, tierName: 'SIMPLE' });
    assert.ok(b.includes('+hold'), b);
    assert.ok(b.includes('hold_break_even_blocked'), b);
  });

  it('marks descents −stepdown with the gate reason', () => {
    const b = buildPassthroughBadge({ action: 'verbatim', reason: 'downgrade_break_even_cleared', servedModel: HAIKU, tierName: 'SIMPLE' });
    assert.ok(b.includes('−stepdown'), b);
    assert.ok(b.includes('downgrade_break_even_cleared'), b);
  });

  it('leaves true no-ops plain', () => {
    for (const reason of ['no_upgrade', 'side_request', 'unknown_client_model', 'routing_disabled', 'not_evaluated']) {
      const b = buildPassthroughBadge({ action: 'verbatim', reason, servedModel: HAIKU, tierName: 'SIMPLE' });
      assert.ok(!b.includes('+route') && !b.includes('+hold') && !b.includes('stepdown'), `${reason}: ${b}`);
      assert.ok(b.includes('subscription-passthrough →'), b);
    }
  });

  it('fail-safes missing models to plain', () => {
    const b = buildPassthroughBadge({ action: 'upgrade' });
    assert.ok(b.includes('subscription-passthrough →'), b);
  });
});

describe('resolveTierModel (label wins ties)', () => {
  const sel = (t) => ({ COMPLEX: { model: SONNET }, SIMPLE: { model: HAIKU } }[t] || null);

  it('resolves null tier models to configured', () => {
    assert.deepStrictEqual(
      route.resolveTierModel({ tierName: 'COMPLEX', tierModel: null, selectModelFn: sel }),
      { model: SONNET, resolved: true }
    );
  });

  it('vetoes weaker-than-label models (stale swaps, poisoned pins)', () => {
    assert.deepStrictEqual(
      route.resolveTierModel({ tierName: 'COMPLEX', tierModel: HAIKU, selectModelFn: sel }),
      { model: SONNET, resolved: true }
    );
  });

  it('keeps stronger-than-label models (held upgrades survive)', () => {
    assert.deepStrictEqual(
      route.resolveTierModel({ tierName: 'COMPLEX', tierModel: OPUS, selectModelFn: sel }),
      { model: OPUS, resolved: false }
    );
  });

  it('keeps agreeing models untouched', () => {
    assert.deepStrictEqual(
      route.resolveTierModel({ tierName: 'SIMPLE', tierModel: HAIKU, selectModelFn: sel }),
      { model: HAIKU, resolved: false }
    );
  });

  it('fail-closed without selector or tier', () => {
    assert.deepStrictEqual(
      route.resolveTierModel({ tierName: 'COMPLEX', tierModel: null, selectModelFn: null }),
      { model: null, resolved: false }
    );
    assert.deepStrictEqual(
      route.resolveTierModel({ tierName: null, tierModel: HAIKU, selectModelFn: sel }),
      { model: HAIKU, resolved: false }
    );
  });
});
