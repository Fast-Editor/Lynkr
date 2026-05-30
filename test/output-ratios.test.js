const test = require('node:test');
const assert = require('node:assert/strict');
const { ratioFor, DEFAULT_RATIOS, reload } = require('../src/routing/output-ratios');

test('ratioFor returns default ratio for unknown task', () => {
  reload();
  assert.equal(ratioFor('totally-unknown-task'), DEFAULT_RATIOS.default);
});

test('ratioFor returns expected ratios for known tasks', () => {
  reload();
  assert.ok(ratioFor('code_gen') > 1.0);
  assert.ok(ratioFor('summarization') < 0.5);
});

test('ratioFor is case-insensitive', () => {
  reload();
  assert.equal(ratioFor('CODE_GEN'), ratioFor('code_gen'));
});
