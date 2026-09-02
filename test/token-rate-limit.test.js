/**
 * Token-aware (TPM) rate limiting (ROUTING-NOTES §1 gap audit).
 *
 * Off unless LYNKR_TPM_LIMIT is set. Estimate → true-up pattern: pre-flight
 * gates on the window's recorded actual consumption plus this request's
 * estimate; actual usage lands post-response via recordTokenUsage.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATABRICKS_API_KEY = process.env.DATABRICKS_API_KEY || 'test-key';
process.env.DATABRICKS_API_BASE = process.env.DATABRICKS_API_BASE || 'http://test.com';
process.env.LOG_FILE_ENABLED = 'false';

// BudgetManager's constructor resolves its DB path from process.cwd()/data —
// run the whole test from a temp cwd so nothing touches the repo's live DB.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lynkr-tpm-test-'));
const originalCwd = process.cwd();
process.chdir(tmpDir);

const { BudgetManager } = require('../src/budget');

let mgr;

test.before(() => {
  mgr = new BudgetManager({});
});

test.after(() => {
  process.chdir(originalCwd);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test.beforeEach(() => {
  delete process.env.LYNKR_TPM_LIMIT;
  try { mgr.db.prepare('DELETE FROM token_rate').run(); } catch { /* fresh db */ }
});

test('TPM limiting is off unless LYNKR_TPM_LIMIT is set', () => {
  const check = mgr.checkTokenRate('user-a', 1_000_000_000);
  assert.equal(check.allowed, true);
});

test('a request whose estimate alone exceeds the limit is rejected', () => {
  process.env.LYNKR_TPM_LIMIT = '10000';
  const check = mgr.checkTokenRate('user-a', 50_000);
  assert.equal(check.allowed, false);
  assert.equal(check.reason, 'token_rate_limit_minute');
  assert.equal(check.limit, 10000);
  assert.ok(check.resetInMs > 0 && check.resetInMs <= 60_000);
});

test('recorded actual usage gates subsequent requests (true-up pattern)', () => {
  process.env.LYNKR_TPM_LIMIT = '10000';
  assert.equal(mgr.checkTokenRate('user-b', 2000).allowed, true);
  mgr.recordTokenUsage('user-b', 9000);
  // Window now holds 9000 actual; a 2000-token estimate would breach 10000.
  const check = mgr.checkTokenRate('user-b', 2000);
  assert.equal(check.allowed, false);
  assert.equal(check.current, 9000);
  // A tiny request still fits.
  assert.equal(mgr.checkTokenRate('user-b', 500).allowed, true);
});

test('windows are per-user — one user\'s consumption never gates another', () => {
  process.env.LYNKR_TPM_LIMIT = '10000';
  mgr.recordTokenUsage('user-c', 9999);
  assert.equal(mgr.checkTokenRate('user-c', 5000).allowed, false);
  assert.equal(mgr.checkTokenRate('user-d', 5000).allowed, true);
});

test('the window resets after a minute', () => {
  process.env.LYNKR_TPM_LIMIT = '10000';
  mgr.recordTokenUsage('user-e', 9999);
  assert.equal(mgr.checkTokenRate('user-e', 5000).allowed, false);
  // Age the window artificially.
  mgr.db.prepare('UPDATE token_rate SET minute_window_start = ? WHERE user_id = ?')
    .run(Date.now() - 61_000, 'user-e');
  assert.equal(mgr.checkTokenRate('user-e', 5000).allowed, true);
});

test('recordTokenUsage is a no-op when limiting is disabled', () => {
  mgr.recordTokenUsage('user-f', 5000);
  const row = mgr.db.prepare('SELECT * FROM token_rate WHERE user_id = ?').get('user-f');
  assert.equal(row, undefined);
});
