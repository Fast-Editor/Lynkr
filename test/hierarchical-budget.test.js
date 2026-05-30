const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

// Write a test budget config
const CONFIG = path.join(__dirname, '../data/budgets.json');
const BACKUP = CONFIG + '.bak';
test.before(() => {
  if (fs.existsSync(CONFIG)) fs.renameSync(CONFIG, BACKUP);
  fs.writeFileSync(CONFIG, JSON.stringify({
    defaults: { periodMs: 60000 },
    limits: {
      virtual_key: { 'test-key': 1.0 },
      team: { 'test-team': 5.0 },
    },
  }));
});
test.after(() => {
  fs.unlinkSync(CONFIG);
  if (fs.existsSync(BACKUP)) fs.renameSync(BACKUP, CONFIG);
});

const { HierarchicalBudget, MapBudgetStore } = require('../src/budget/hierarchical-budget');

test('check passes when under limit', () => {
  const b = new HierarchicalBudget(new MapBudgetStore());
  const r = b.check({ virtual_key: 'test-key' }, 0.5);
  assert.equal(r.ok, true);
});

test('check fails when amount would exceed limit', () => {
  const b = new HierarchicalBudget(new MapBudgetStore());
  b.record({ virtual_key: 'test-key' }, 0.9);
  const r = b.check({ virtual_key: 'test-key' }, 0.5);
  assert.equal(r.ok, false);
  assert.equal(r.exceeded.level, 'virtual_key');
});

test('record accumulates across calls', () => {
  const b = new HierarchicalBudget(new MapBudgetStore());
  b.record({ team: 'test-team' }, 1.0);
  b.record({ team: 'test-team' }, 2.0);
  const status = b.status({ team: 'test-team' });
  assert.equal(status.team.spent, 3.0);
});

test('missing context level is ignored', () => {
  const b = new HierarchicalBudget(new MapBudgetStore());
  const r = b.check({ team: null, customer: null }, 100);
  assert.equal(r.ok, true);
});
