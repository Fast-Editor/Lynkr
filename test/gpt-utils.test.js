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
