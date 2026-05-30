const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const STATE_PATH = path.join(__dirname, '../data/bandit-state.json');
// Backup any existing state so tests are deterministic
const _backupPath = STATE_PATH + '.test-backup';
test.before(() => {
  if (fs.existsSync(STATE_PATH)) fs.renameSync(STATE_PATH, _backupPath);
});
test.after(() => {
  if (fs.existsSync(STATE_PATH)) fs.unlinkSync(STATE_PATH);
  if (fs.existsSync(_backupPath)) fs.renameSync(_backupPath, STATE_PATH);
});

const { LinUCBBandit } = require('../src/routing/bandit');

test('bandit picks an arm from candidates', () => {
  const b = new LinUCBBandit({ dim: 4 });
  const candidates = [
    { provider: 'anthropic', model: 'claude-opus-4-7' },
    { provider: 'anthropic', model: 'claude-sonnet-4-6' },
  ];
  const ctx = [1, 0, 0.5, 0.2];
  const chosen = b.pick('COMPLEX', candidates, ctx);
  assert.ok(chosen);
  assert.ok(['claude-opus-4-7', 'claude-sonnet-4-6'].includes(chosen.model));
});

test('bandit updates arm and learns', () => {
  const b = new LinUCBBandit({ dim: 4 });
  const ctx = [1, 0, 0.5, 0.2];
  // Reward sonnet much higher than opus
  for (let i = 0; i < 50; i++) {
    b.update('COMPLEX', 'anthropic', 'claude-sonnet-4-6', ctx, 90);
    b.update('COMPLEX', 'anthropic', 'claude-opus-4-7', ctx, 30);
  }
  // After enough updates, sonnet should be preferred (mostly — there's 5% random exploration)
  let sonnetWins = 0;
  for (let i = 0; i < 100; i++) {
    const chosen = b.pick('COMPLEX', [
      { provider: 'anthropic', model: 'claude-opus-4-7' },
      { provider: 'anthropic', model: 'claude-sonnet-4-6' },
    ], ctx);
    if (chosen.model === 'claude-sonnet-4-6') sonnetWins++;
  }
  assert.ok(sonnetWins > 70, `expected >70 sonnet wins out of 100, got ${sonnetWins}`);
});

test('bandit handles dim mismatch by padding', () => {
  const b = new LinUCBBandit({ dim: 8 });
  const chosen = b.pick('SIMPLE', [{ provider: 'ollama', model: 'llama3.2' }], [1, 0, 1]);
  assert.ok(chosen);
});
