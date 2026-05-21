const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const TENANTS_DIR = path.join(__dirname, '../data/tenants');
const TEST_TENANT = path.join(TENANTS_DIR, 'test-co.json');

test.before(() => {
  fs.mkdirSync(TENANTS_DIR, { recursive: true });
  fs.writeFileSync(TEST_TENANT, JSON.stringify({
    blockedModels: ['claude-opus-4-7'],
    maxLatencyMs: 5000,
    preferredProviders: ['anthropic', 'openai'],
  }));
});
test.after(() => {
  if (fs.existsSync(TEST_TENANT)) fs.unlinkSync(TEST_TENANT);
});

const { getTenantId, getPolicy, reloadCache } = require('../src/routing/tenant-policy');

test('getTenantId reads from headers', () => {
  reloadCache();
  const req = { headers: { 'lynkr-tenant-id': 'test-co' } };
  assert.equal(getTenantId(req), 'test-co');
});

test('getPolicy returns null for unknown tenant', () => {
  reloadCache();
  assert.equal(getPolicy('nonexistent'), null);
});

test('getPolicy returns config for known tenant', () => {
  reloadCache();
  const policy = getPolicy('test-co');
  assert.ok(policy);
  assert.ok(policy.blockedModels.has('claude-opus-4-7'));
  assert.equal(policy.maxLatencyMs, 5000);
});

test('getTenantId returns null when header absent', () => {
  assert.equal(getTenantId({ headers: {} }), null);
});
