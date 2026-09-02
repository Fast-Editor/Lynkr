/**
 * Synthetic circuit-breaker health probing (ROUTING-NOTES §1 gap audit).
 *
 * Pins the core contract: an OPEN circuit recovers via a background
 * synthetic probe — no live user request has to pay for testing a dead
 * provider — and healthy (CLOSED) breakers are never probed at all.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.DATABRICKS_API_KEY = process.env.DATABRICKS_API_KEY || 'test-key';
process.env.DATABRICKS_API_BASE = process.env.DATABRICKS_API_BASE || 'http://test.com';
process.env.LOG_FILE_ENABLED = 'false';

const { getCircuitBreakerRegistry } = require('../src/clients/circuit-breaker');
const { getHealthProber, registerHealthProbe } = require('../src/clients/health-probe');

const FAILURE_THRESHOLD = 3;
const HALF_OPEN_AFTER_MS = 60;

async function forceOpen(breaker) {
  for (let i = 0; i < FAILURE_THRESHOLD; i++) {
    await breaker.execute(() => Promise.reject(new Error('provider down'))).catch(() => {});
  }
  assert.equal(breaker.state, 'OPEN', 'breaker should be open after threshold failures');
}

test('open circuit recovers via synthetic probe once the provider is healthy again', async () => {
  const registry = getCircuitBreakerRegistry();
  const breaker = registry.get('probe-test-recovers', {
    failureThreshold: FAILURE_THRESHOLD,
    timeout: HALF_OPEN_AFTER_MS,
  });
  await forceOpen(breaker);

  let providerHealthy = false;
  let probeDials = 0;
  registerHealthProbe('probe-test-recovers', async () => {
    probeDials += 1;
    if (!providerHealthy) throw new Error('still down');
  });

  const prober = getHealthProber();

  // Sweep while the provider is still down and the circuit is inside its
  // halfOpenAfter window: execute() rejects without dialing the probe.
  await prober.sweep();
  assert.equal(breaker.state, 'OPEN');

  // Provider comes back; after halfOpenAfter elapses, a sweep's probe runs
  // through the half-open circuit and closes it — no live request involved.
  providerHealthy = true;
  await new Promise((r) => setTimeout(r, HALF_OPEN_AFTER_MS + 20));
  await prober.sweep();
  assert.equal(breaker.state, 'CLOSED', 'synthetic probe should close the recovered circuit');
  assert.ok(probeDials >= 1, 'probe function actually dialed the provider');
});

test('probe failure while provider is down re-opens (keeps open) the circuit', async () => {
  const registry = getCircuitBreakerRegistry();
  const breaker = registry.get('probe-test-stays-open', {
    failureThreshold: FAILURE_THRESHOLD,
    timeout: HALF_OPEN_AFTER_MS,
  });
  await forceOpen(breaker);

  registerHealthProbe('probe-test-stays-open', async () => {
    throw new Error('still down');
  });

  await new Promise((r) => setTimeout(r, HALF_OPEN_AFTER_MS + 20));
  await getHealthProber().sweep();
  assert.equal(breaker.state, 'OPEN', 'failed probe must leave the circuit open');
});

test('healthy (CLOSED) breakers are never probed — zero cost when everything is up', async () => {
  const registry = getCircuitBreakerRegistry();
  const breaker = registry.get('probe-test-healthy', {
    failureThreshold: FAILURE_THRESHOLD,
    timeout: HALF_OPEN_AFTER_MS,
  });
  assert.equal(breaker.state, 'CLOSED');

  let probeDials = 0;
  registerHealthProbe('probe-test-healthy', async () => {
    probeDials += 1;
  });

  await getHealthProber().sweep();
  assert.equal(probeDials, 0, 'closed breakers must not be probed');
});

test('providers without a registered breaker are skipped', async () => {
  let probeDials = 0;
  registerHealthProbe('probe-test-no-breaker-exists', async () => {
    probeDials += 1;
  });
  await getHealthProber().sweep();
  assert.equal(probeDials, 0);
});

test('getStatus reports registered providers and sweep counters', async () => {
  const status = getHealthProber().getStatus();
  assert.ok(status.sweeps >= 1, 'sweeps counted');
  assert.ok(status.registeredProviders.includes('probe-test-recovers'));
  assert.equal(typeof status.intervalMs, 'number');
});
