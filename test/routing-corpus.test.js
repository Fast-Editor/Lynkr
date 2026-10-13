/**
 * Routing corpus regression gate.
 *
 * Fixtures under test/fixtures/routing-corpus/ store, per recorded request,
 * the SIGNAL SNAPSHOT the engine saw and the decision/tier it produced under
 * the named config. Replaying the pure decision step over the snapshot is
 * deterministic (no embeddings, no judge call), so any change to the rule
 * engine, condition semantics, or the referenced config that alters a
 * decision fails here with the task name and both decisions printed.
 *
 * Regenerate deliberately with: node scripts/build-routing-corpus.js
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

process.env.LYNKR_KNN_DIR = process.env.LYNKR_KNN_DIR || '/tmp/lynkr-test-knn';

const rc = require('../src/routing/routing-config');
const decisions = require('../src/routing/decisions');

const DIR = path.join(__dirname, 'fixtures', 'routing-corpus');

for (const file of fs.existsSync(DIR) ? fs.readdirSync(DIR).filter((f) => f.endsWith('.json')) : []) {
  const corpus = JSON.parse(fs.readFileSync(path.join(DIR, file), 'utf8'));
  const raw = JSON.parse(fs.readFileSync(path.join(__dirname, '..', corpus.config), 'utf8'));
  const cfg = { ...rc.DEFAULT_CONFIG, ...raw, signals: { ...rc.DEFAULT_CONFIG.signals, ...(raw.signals || {}) } };
  cfg.decisions = [...cfg.decisions].sort((a, b) => b.priority - a.priority);

  test(`routing corpus ${file}: config validates`, () => {
    assert.deepStrictEqual(rc.validate(cfg), []);
  });

  test(`routing corpus ${file}: ${corpus.fixtures.length} decisions unchanged`, () => {
    const diffs = [];
    for (const fx of corpus.fixtures) {
      const r = decisions.decideFromSignals(fx.signals, { legacy: { tier: fx.legacyTier } }, cfg);
      if (r.decision !== fx.expected.decision || r.tier !== fx.expected.tier || (r.effort ?? null) !== (fx.expected.effort ?? null)) {
        diffs.push(`${fx.task}: expected ${fx.expected.decision}/${fx.expected.tier}/${fx.expected.effort ?? '-'} got ${r.decision}/${r.tier}/${r.effort ?? '-'}`);
      }
    }
    assert.deepStrictEqual(diffs, [], `routing decisions changed:\n  ${diffs.join('\n  ')}`);
  });
}
