const assert = require('assert');
const { describe, it } = require('node:test');

// Contract tests for the deterministic escalation table: these patterns
// bypass scoring, pins and shortfall, so a silent edit here reroutes
// production traffic with no score trail. Pin every trigger and its
// near-misses.
const {
  shouldForceReasoning,
  shouldForceCloud,
  shouldForceLocal,
  scoreTaskType,
} = require('../src/routing/complexity-analyzer');

const msg = (content) => ({ messages: [{ role: 'user', content }] });

describe('force_reasoning patterns', () => {
  const fires = [
    'Ultrathink: summarize this file',
    'prove the retry helper terminates',
    'Security audit the OAuth path',
    'think hard about this edge case',
    'reason from first principles about caching',
    // Frontier planning (plan word + technical scope, either order)
    'How to refactor databricks.js give me a plan',
    'Give me a migration plan for the database layer',
    'Draft an RFC to redesign the routing service',
    'Propose a rollout strategy for the new pipeline',
    'I need a refactoring plan for the 4300-line client',
    'Plan the redesign of the retry system',
    // Frontier planning across lines — the removed (?=.*A)(?=.*B) lookahead
    // could only fire when both words sat on ONE line (`.` never crosses a
    // newline). The documented intent is co-occurrence anywhere in the ask.
    'I need a plan\nto refactor the whole codebase',
    'Give me a roadmap\ncovering the migration\nof the billing system',
  ];
  for (const text of fires) {
    it(`fires: ${text.slice(0, 52)}`, () => {
      assert.strictEqual(shouldForceReasoning(msg(text)), true, text);
    });
  }

  const quiet = [
    'Plan my vacation for next month',
    'Give me a lesson plan for module 3',
    'Write a business plan for the bakery',
    'What is the plan?',
    'Hi',
    'Explain this regex',
    'Do an architecture review of the router',
  ];
  for (const text of quiet) {
    it(`stays quiet: ${text.slice(0, 52)}`, () => {
      assert.strictEqual(shouldForceReasoning(msg(text)), false, text);
    });
  }
});

describe('force_cloud patterns', () => {
  const fires = [
    'Do an architecture review of the orchestrator',
    'Can you do a architectural review of the routing layer',
    'Give me an architectural design for the cache subsystem',
    'Refactor the entire ingestion pipeline',
    'Production incident: 502s under load',
    'Debug this tricky race condition',
    'Please do a code review of this diff',
  ];
  for (const text of fires) {
    it(`fires: ${text.slice(0, 52)}`, () => {
      assert.strictEqual(shouldForceCloud(msg(text)), true, text);
    });
  }
});

describe('force_local patterns', () => {
  it('fires on greetings', () => {
    assert.strictEqual(shouldForceLocal(msg('Hi')), true);
    assert.strictEqual(shouldForceLocal(msg('thanks!')), true);
  });
  it('stays quiet on real asks', () => {
    assert.strictEqual(shouldForceLocal(msg('How to refactor databricks.js give me a plan')), false);
  });
});

// Regression (live incident 2026-10-15): the frontier-planning trigger used
// to be a single (?=.*A)(?=.*B) lookahead regex. On long lines every start
// position rescanned `.*` to end-of-line — O(n²). A 200KB single-line
// payload spent 61s per shouldForceReasoning call, ×2 calls per request
// via determineProviderSmart → 150s+ end-to-end on /v1/messages. The
// two-regex implementation must stay linear even on pathological inputs.
describe('force_reasoning long-line performance guard', () => {
  it('200KB single-line content completes in < 1s', () => {
    const chunk = 'The quick zebra vaulted over the lazy turnstile while countingquills diligently. ';
    const content = chunk.repeat(4000).slice(0, 200_000) + '\n\nFINAL QUESTION';
    const payload = { messages: [{ role: 'user', content }] };
    const t0 = process.hrtime.bigint();
    const fired = shouldForceReasoning(payload);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.strictEqual(fired, false);
    assert.ok(ms < 1000, `shouldForceReasoning took ${ms.toFixed(1)}ms on 200KB single-line (regression: quadratic lookahead is back?)`);
  });
});

// The scoreTaskType hook added with the fix must keep its contract: a
// frontier-planning ask (plan word + technical scope, any line) short-circuits
// scoring with the two-sided pattern marker, matching the shouldForceReasoning
// fallback above.
describe('frontier planning two-sided scoring', () => {
  it('scoreTaskType short-circuits with frontier_planning_two_sided on a cross-line ask', () => {
    const r = scoreTaskType('I need a plan\nto refactor the whole codebase');
    assert.strictEqual(r.reason, 'force_reasoning');
    assert.strictEqual(r.pattern, 'frontier_planning_two_sided');
    assert.strictEqual(r.score, 100);
  });

  it('scoreTaskType does NOT short-circuit when only the plan word is present', () => {
    const r = scoreTaskType('I need a plan\nfor my vacation next month');
    assert.notStrictEqual(r.pattern, 'frontier_planning_two_sided');
  });
});
