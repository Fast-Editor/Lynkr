/**
 * First-party-only subscription classification + passthrough gating.
 *
 * Policy (2026-09): the api.anthropic.com subscription passthrough is for
 * first-party Anthropic clients (Claude Code / Claude Desktop family)
 * wrapping their OWN traffic. Third-party harnesses (Cursor, Codex CLI,
 * Copilot, Antigravity, opencode…) must never classify as 'subscription' —
 * they route through the orchestrator with the operator's configured
 * providers via token-shape classification instead.
 *
 * Also pins two removals as source-level tripwires:
 *   - the passthrough never mutates bodies (memory injection removed)
 *   - the "stealth" routing-method naming is gone
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

process.env.DATABRICKS_API_KEY = process.env.DATABRICKS_API_KEY || 'test-key';
process.env.DATABRICKS_API_BASE = process.env.DATABRICKS_API_BASE || 'http://test.com';
process.env.LOG_FILE_ENABLED = 'false';

const {
  classifyAuthMode,
  isFirstPartyAnthropicClient,
  SUBSCRIPTION_UA_PREFIXES,
} = require('../src/auth-mode');

const FIRST_PARTY_UAS = [
  'claude-cli/1.0.119 (external, cli)',
  'claude-code/2.1.0',
  'claude-vscode/0.3.4',
  'anthropic-cli/0.9.1',
];

const THIRD_PARTY_UAS = [
  'codex-cli/0.48.0',
  'cursor/1.6.2',
  'github-copilot/1.250.0',
  'antigravity/0.2.1',
  'opencode/1.18.29 ai-sdk/provider-utils/4',
  'Mozilla/5.0 some-random-agent',
];

test('first-party UAs classify as subscription', () => {
  for (const ua of FIRST_PARTY_UAS) {
    assert.equal(classifyAuthMode({ 'user-agent': ua }), 'subscription', ua);
    assert.equal(isFirstPartyAnthropicClient({ 'user-agent': ua }), true, ua);
  }
});

test('third-party harness UAs NEVER classify as subscription — token shape decides', () => {
  for (const ua of THIRD_PARTY_UAS) {
    // With a subscription OAuth token: 'oauth' (orchestrator path), not 'subscription'.
    const withOat = classifyAuthMode({
      'user-agent': ua,
      authorization: 'Bearer sk-ant-oat01-abc',
    });
    assert.equal(withOat, 'oauth', `${ua} with oat token`);
    // With an API key: 'payg'.
    const withKey = classifyAuthMode({
      'user-agent': ua,
      authorization: 'Bearer sk-ant-api03-abc',
    });
    assert.equal(withKey, 'payg', `${ua} with api key`);
    assert.equal(isFirstPartyAnthropicClient({ 'user-agent': ua }), false, ua);
  }
});

test('the prefix list contains ONLY first-party Anthropic clients', () => {
  assert.deepEqual(SUBSCRIPTION_UA_PREFIXES.sort(), [
    'anthropic-cli/',
    'claude-cli/',
    'claude-code/',
    'claude-vscode/',
  ].sort());
  for (const banned of ['codex-cli/', 'cursor/', 'github-copilot/', 'antigravity/']) {
    assert.ok(!SUBSCRIPTION_UA_PREFIXES.includes(banned),
      `${banned} must never re-enter the subscription classification`);
  }
});

test('missing/empty UA is never first-party', () => {
  assert.equal(isFirstPartyAnthropicClient({}), false);
  assert.equal(isFirstPartyAnthropicClient({ 'user-agent': '' }), false);
});

// --- Source tripwires (behavioral absence can't be black-box-proven cheaply) ---

const routerSource = fs.readFileSync(path.join(__dirname, '../src/api/router.js'), 'utf8');

test('the passthrough never mutates bodies: memory injection is gone', () => {
  // Match the functional patterns, not historical mentions in comments.
  assert.ok(!routerSource.includes('process.env.LYNKR_OAUTH_MEMORY_INJECTION'),
    'memory-injection flag re-entered the passthrough — its contract is byte-for-byte');
  assert.ok(!/maybeInjectMemoryIntoUserTail\s*\(/.test(routerSource),
    'memory-injection call re-entered router.js');
});

test('the "stealth" naming is gone; the passthrough is gated on first-party clients', () => {
  assert.ok(!routerSource.includes('oauth-subscription-stealth'),
    'stealth routing-method name must stay removed');
  assert.ok(routerSource.includes('oauth-subscription-passthrough'),
    'renamed routing-method header missing');
  assert.match(routerSource, /&&\s*_firstParty\)/,
    'dispatch-fork first-party gate missing');
});
