const assert = require('assert');
const { describe, it, beforeEach, afterEach } = require('node:test');
const os = require('os');

function loadPreflight() {
  delete require.cache[require.resolve('../src/config')];
  delete require.cache[require.resolve('../src/orchestrator/preflight')];
  return require('../src/orchestrator/preflight');
}

describe('tryPreflight', () => {
  let originalEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    process.env.DATABRICKS_API_KEY = 'test';
    process.env.DATABRICKS_API_BASE = 'http://test.example';
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('feature gating', () => {
    it('returns null when feature is disabled (default)', () => {
      delete process.env.LYNKR_PREFLIGHT_ENABLED;
      const { tryPreflight } = loadPreflight();
      const r = tryPreflight({
        payload: { preflight_commands: ['true'] },
        cwd: os.tmpdir(),
      });
      assert.strictEqual(r, null);
    });

    it('returns null when commands list is empty', () => {
      process.env.LYNKR_PREFLIGHT_ENABLED = 'true';
      const { tryPreflight } = loadPreflight();
      const r = tryPreflight({
        payload: { preflight_commands: [] },
        cwd: os.tmpdir(),
      });
      assert.strictEqual(r, null);
    });

    it('returns null when cwd is missing', () => {
      process.env.LYNKR_PREFLIGHT_ENABLED = 'true';
      const { tryPreflight } = loadPreflight();
      const r = tryPreflight({
        payload: { preflight_commands: ['true'] },
      });
      assert.strictEqual(r, null);
    });

    it('returns null when cwd is relative', () => {
      process.env.LYNKR_PREFLIGHT_ENABLED = 'true';
      const { tryPreflight } = loadPreflight();
      const r = tryPreflight({
        payload: { preflight_commands: ['true'] },
        cwd: 'relative/path',
      });
      assert.strictEqual(r, null);
    });
  });

  describe('execution', () => {
    beforeEach(() => {
      process.env.LYNKR_PREFLIGHT_ENABLED = 'true';
    });

    it('marks satisfied when every command exits 0', () => {
      const { tryPreflight } = loadPreflight();
      const r = tryPreflight({
        payload: { preflight_commands: ['true', 'echo ok'] },
        cwd: os.tmpdir(),
      });
      assert.strictEqual(r.satisfied, true);
      assert.strictEqual(r.results.length, 2);
      assert.strictEqual(r.failedCommand, null);
    });

    it('marks unsatisfied on a non-zero exit', () => {
      const { tryPreflight } = loadPreflight();
      const r = tryPreflight({
        payload: { preflight_commands: ['true', 'false'] },
        cwd: os.tmpdir(),
      });
      assert.strictEqual(r.satisfied, false);
      assert.strictEqual(r.failedCommand, 'false');
      // Should stop at the failing command; second/third commands not run.
      assert.strictEqual(r.results.length, 2);
    });

    it('truncates large stdout', () => {
      const { tryPreflight } = loadPreflight();
      const r = tryPreflight({
        payload: { preflight_commands: ['yes hello | head -c 100000'] },
        cwd: os.tmpdir(),
      });
      assert.strictEqual(r.satisfied, true);
      // Output is truncated to MAX_OUTPUT_BYTES (4000).
      assert.ok(r.results[0].stdout.length <= 4000);
    });

    it('accepts commands via metadata.lynkr_preflight_commands', () => {
      const { tryPreflight } = loadPreflight();
      const r = tryPreflight({
        payload: { metadata: { lynkr_preflight_commands: ['true'] } },
        cwd: os.tmpdir(),
      });
      assert.strictEqual(r.satisfied, true);
    });

    it('caps the number of commands', () => {
      const { tryPreflight, extractCommands } = loadPreflight();
      // 15 commands → cap is 10
      const cmds = Array(15).fill('true');
      const extracted = extractCommands({ preflight_commands: cmds });
      assert.strictEqual(extracted.length, 10);
      const r = tryPreflight({
        payload: { preflight_commands: cmds },
        cwd: os.tmpdir(),
      });
      assert.strictEqual(r.results.length, 10);
    });
  });

  describe('buildSatisfiedResponse', () => {
    beforeEach(() => {
      process.env.LYNKR_PREFLIGHT_ENABLED = 'true';
    });

    it('produces a complete Anthropic-shaped response', () => {
      const { buildSatisfiedResponse } = loadPreflight();
      const body = buildSatisfiedResponse({
        model: 'claude-test',
        preflightResult: {
          satisfied: true,
          results: [{ command: 'true', exit_code: 0, stdout: '', stderr: '', timed_out: false }],
          reason: 'All preflight commands passed.',
        },
      });
      assert.strictEqual(body.terminationReason, 'preflight_satisfied');
      assert.strictEqual(body.response.status, 200);
      assert.strictEqual(body.response.json.type, 'message');
      assert.strictEqual(body.response.json.model, 'claude-test');
      assert.strictEqual(body.response.json.lynkr_preflight.satisfied, true);
      assert.strictEqual(body.steps, 0);
    });
  });
});
