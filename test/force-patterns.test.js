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
