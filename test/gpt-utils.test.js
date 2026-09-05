const assert = require('assert');
const { describe, it } = require('node:test');
const { areSimilarToolCalls } = require('../src/clients/gpt-utils');

describe('areSimilarToolCalls', () => {
  describe('read-tool same-file detection', () => {
    it('flags re-reads of the SAME file at different offsets as similar', () => {
      // Mirrors the live transcript: repeated Read of types.go at
      // overlapping offsets, none of which matched exactly, so the loop
      // guard never fired.
      const a = { name: 'Read', input: { file_path: '/tmp/ollama/api/types.go', offset: 390, limit: 90 } };
      const b = { name: 'Read', input: { file_path: '/tmp/ollama/api/types.go', offset: 410, limit: 80 } };
      assert.equal(areSimilarToolCalls(a, b), true);
    });

    it('does NOT flag reads of DIFFERENT files as similar', () => {
      // The original false-positive this whole exclusion was built to avoid
      // (server.js / openai-router.js / orchestrator/index.js all read in
      // one code-trace) — must stay refuted.
      const a = { name: 'Read', input: { file_path: '/repo/src/server.js', offset: 0, limit: 100 } };
      const b = { name: 'Read', input: { file_path: '/repo/src/api/openai-router.js', offset: 0, limit: 100 } };
      assert.equal(areSimilarToolCalls(a, b), false);
    });

    it('handles OpenAI-shape calls (function.arguments as a JSON string)', () => {
      const a = { function: { name: 'read', arguments: JSON.stringify({ path: '/a/b.go', offset: 1 }) } };
      const b = { function: { name: 'read', arguments: JSON.stringify({ path: '/a/b.go', offset: 200 }) } };
      assert.equal(areSimilarToolCalls(a, b), true);
    });

    it('does not merge when the path argument is missing entirely', () => {
      const a = { name: 'Read', input: { offset: 1 } };
      const b = { name: 'Read', input: { offset: 2 } };
      assert.equal(areSimilarToolCalls(a, b), false);
    });
  });

  describe('existing behavior, unaffected', () => {
    it('still treats identical args as similar regardless of tool', () => {
      const a = { name: 'bash', input: { command: 'ls -la' } };
      const b = { name: 'bash', input: { command: 'ls -la' } };
      assert.equal(areSimilarToolCalls(a, b), true);
    });

    it('still fuzzy-matches near-identical search-tool args', () => {
      // 9/11 shared tokens (~0.82 Jaccard) — above the 0.8 threshold.
      const a = { name: 'grep', input: { pattern: 'alpha beta gamma delta epsilon zeta eta theta iota kappa' } };
      const b = { name: 'grep', input: { pattern: 'alpha beta gamma delta epsilon zeta eta theta iota lambda' } };
      assert.equal(areSimilarToolCalls(a, b), true);
    });

    it('does not match calls with different tool names', () => {
      const a = { name: 'Read', input: { file_path: '/a.js' } };
      const b = { name: 'Write', input: { file_path: '/a.js' } };
      assert.equal(areSimilarToolCalls(a, b), false);
    });
  });
});

describe('read-window overlap (loop-guard fix: paging a large file is not a loop)', () => {
  const { extractReadWindow } = require('../src/clients/gpt-utils');

  it('does NOT flag DISJOINT windows of the same file (paging through a big file)', () => {
    // Mirrors the live uv incident: settings.rs (4,000 lines) read at
    // offsets 975/3485/3800 — three distinct regions needed to fix a bug
    // spanning two structs. The old same-path rule counted these toward the
    // loop threshold and the injected STOP order killed the work turn.
    const a = { name: 'read', input: { filePath: '/tmp/uv/crates/uv/src/settings.rs', offset: 975, limit: 210 } };
    const b = { name: 'read', input: { filePath: '/tmp/uv/crates/uv/src/settings.rs', offset: 3485, limit: 145 } };
    const c = { name: 'read', input: { filePath: '/tmp/uv/crates/uv/src/settings.rs', offset: 3800, limit: 205 } };
    assert.equal(areSimilarToolCalls(a, b), false);
    assert.equal(areSimilarToolCalls(b, c), false);
    assert.equal(areSimilarToolCalls(a, c), false);
  });

  it('still flags OVERLAPPING windows of the same file (true re-read)', () => {
    const a = { name: 'read', input: { filePath: '/x/settings.rs', offset: 3485, limit: 145 } }; // [3485, 3630)
    const b = { name: 'read', input: { filePath: '/x/settings.rs', offset: 3488, limit: 30 } };  // [3488, 3518)
    assert.equal(areSimilarToolCalls(a, b), true);
  });

  it('still flags repeated whole-file reads (no offset/limit → open window)', () => {
    const a = { name: 'Read', input: { file_path: '/x/big.rs' } };
    const b = { name: 'Read', input: { file_path: '/x/big.rs' } };
    // identical args → exact match; and with one paged read it still overlaps:
    const paged = { name: 'Read', input: { file_path: '/x/big.rs', offset: 100, limit: 50 } };
    assert.equal(areSimilarToolCalls(a, b), true);
    assert.equal(areSimilarToolCalls(a, paged), true);
  });

  it('extractReadWindow: defaults and edge shapes', () => {
    assert.deepEqual(extractReadWindow({ offset: 10, limit: 5 }), { start: 10, end: 15 });
    assert.deepEqual(extractReadWindow({}), { start: 0, end: Infinity });
    assert.deepEqual(extractReadWindow('{"offset":3,"limit":2}'), { start: 3, end: 5 });
    assert.deepEqual(extractReadWindow('not json'), { start: 0, end: Infinity });
    assert.deepEqual(extractReadWindow({ offset: 7, limit: 0 }), { start: 7, end: Infinity });
  });
});
