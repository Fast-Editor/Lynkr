/**
 * Tests for lynkr wrap command
 */

process.env.DATABRICKS_API_KEY = process.env.DATABRICKS_API_KEY || "test-key";
process.env.DATABRICKS_API_BASE = process.env.DATABRICKS_API_BASE || "http://test.com";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("child_process");
const { existsSync } = require("fs");

describe("lynkr wrap command", () => {
  it("shows help when no target specified", async () => {
    const { stdout, exitCode } = await run(['wrap']);
    assert.match(stdout, /Usage: lynkr wrap <target>/);
    assert.equal(exitCode, 1);
  });

  it("errors on unsupported target", async () => {
    const { stdout, exitCode } = await run(['wrap', 'bogus']);
    assert.match(stdout, /not supported/);
    assert.equal(exitCode, 1);
  });

  it("detects claude binary", () => {
    const { execSync } = require('child_process');
    try {
      const result = execSync('which claude', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] });
      const claudePath = result.trim();
      assert.ok(existsSync(claudePath), 'Claude Code binary should exist');
    } catch {
      // If not installed, skip test
      console.log('  ℹ Claude Code not installed, skipping binary detection test');
    }
  });

  it("wrap.js has valid syntax", () => {
    // Just verify the file can be checked
    const { execSync } = require('child_process');
    try {
      execSync('node --check bin/wrap.js', { cwd: __dirname + '/..' });
      assert.ok(true, 'wrap.js syntax is valid');
    } catch (err) {
      assert.fail('wrap.js has syntax errors: ' + err.message);
    }
  });

  it("shows all supported targets in help", async () => {
    const { stdout } = await run(['wrap']);
    assert.match(stdout, /claude/);
    assert.match(stdout, /copilot/);
    assert.match(stdout, /aider/);
    assert.match(stdout, /cursor/);
    assert.match(stdout, /codex/);
  });

  it("accepts all supported targets", async () => {
    const targets = ['copilot', 'aider', 'cursor', 'codex'];
    for (const target of targets) {
      // These may find the binary or not, we're just verifying they're recognized
      const { stdout, exitCode } = await run(['wrap', target]);
      // Should NOT show "not supported" error
      assert.ok(!stdout.includes('not supported'), `Target ${target} should be supported`);
      // Either exits with 2 (not found) or tries to start (exit code varies)
      assert.ok(exitCode === 2 || exitCode === 1 || exitCode === 0,
        `Exit code should be 0, 1, or 2, got ${exitCode}`);
    }
  });
});

// Helper to run lynkr CLI
function run(args, input = null) {
  return new Promise((resolve) => {
    const child = spawn('node', ['bin/cli.js', ...args], {
      cwd: __dirname + '/..',
      env: { ...process.env, NODE_ENV: 'test' },
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data) => { stdout += data.toString(); });
    child.stderr.on('data', (data) => { stderr += data.toString(); });

    if (input) {
      child.stdin.write(input);
      child.stdin.end();
    }

    child.on('close', (code) => {
      resolve({
        exitCode: code,
        stdout: stdout + stderr, // combine for easier matching
      });
    });
  });
}
