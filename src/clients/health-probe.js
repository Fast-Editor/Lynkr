/**
 * Synthetic circuit-breaker health probe (ROUTING-NOTES §1 gap audit).
 *
 * Problem: cockatiel's halfOpenAfter is a pure timer — after it elapses, the
 * NEXT LIVE USER REQUEST is the recovery probe. A user pays the latency/cost
 * of testing a dead provider, and a provider with no traffic never recovers.
 *
 * Fix (the pattern LiteLLM ships as health-check-driven routing): a
 * background loop that, for every breaker currently OPEN or HALF_OPEN, runs
 * a cheap synthetic request *through the breaker* (`breaker.execute(probe)`)
 * on a schedule. A success closes the circuit via cockatiel's normal
 * half-open transition; a failure re-opens it. Healthy breakers are never
 * probed — the loop is zero-cost when everything is up.
 *
 * Probes are registered per provider name (the breaker registry key).
 * Built-in probes cover the local providers (ollama / llamacpp / lmstudio),
 * whose cheap GET endpoints are well-known, free, and exactly where the
 * dead-upstream-hang problem historically lived. Cloud providers can be
 * added via registerHealthProbe(name, fn); without one, their recovery
 * stays as before (next live request) — no behavior regression.
 */

const config = require('../config');
const logger = require('../logger');
const { getCockatielRegistry } = require('./resilience');

const PROBE_INTERVAL_MS = Number.parseInt(process.env.LYNKR_HEALTH_PROBE_INTERVAL_MS, 10) || 30_000;
const PROBE_TIMEOUT_MS = Number.parseInt(process.env.LYNKR_HEALTH_PROBE_TIMEOUT_MS, 10) || 5_000;
const ENABLED = process.env.LYNKR_HEALTH_PROBE_ENABLED !== 'false';

/** @type {Map<string, () => Promise<void>>} providerName → probe fn (throws on unhealthy) */
const probes = new Map();

async function _cheapGet(url, headers = {}) {
  const response = await fetch(url, {
    method: 'GET',
    headers,
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`health probe ${url} → ${response.status}`);
  }
  // Drain the (small) body so the socket is released cleanly.
  await response.arrayBuffer().catch(() => {});
}

function _registerBuiltins() {
  if (config.ollama?.endpoint) {
    probes.set('ollama', () => _cheapGet(`${config.ollama.endpoint}/api/tags`));
  }
  if (config.llamacpp?.endpoint) {
    const headers = config.llamacpp.apiKey
      ? { Authorization: `Bearer ${config.llamacpp.apiKey}` }
      : {};
    probes.set('llamacpp', () => _cheapGet(`${config.llamacpp.endpoint}/v1/models`, headers));
  }
  if (config.lmstudio?.endpoint) {
    const headers = config.lmstudio.apiKey
      ? { Authorization: `Bearer ${config.lmstudio.apiKey}` }
      : {};
    probes.set('lmstudio', () => _cheapGet(`${config.lmstudio.endpoint}/v1/models`, headers));
  }
}

/**
 * Register (or override) a synthetic probe for a provider. The function must
 * resolve when the provider is healthy and throw/reject when it is not.
 * @param {string} providerName — must match the circuit breaker registry key
 * @param {() => Promise<void>} probeFn
 */
function registerHealthProbe(providerName, probeFn) {
  probes.set(providerName, probeFn);
}

class HealthProber {
  constructor() {
    this.timer = null;
    this.stats = { sweeps: 0, probesSent: 0, recoveries: 0, failures: 0, lastSweepAt: null };
  }

  start() {
    if (this.timer || !ENABLED) return;
    _registerBuiltins();
    this.timer = setInterval(() => {
      this.sweep().catch((err) => {
        logger.debug({ error: err.message }, '[HealthProbe] sweep error');
      });
    }, PROBE_INTERVAL_MS);
    // Never keep the process alive just to probe.
    this.timer.unref?.();
    logger.info(
      { intervalMs: PROBE_INTERVAL_MS, providers: [...probes.keys()] },
      '[HealthProbe] Synthetic circuit-breaker probing started'
    );
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * One probing pass: probe every registered provider whose breaker is not
   * closed. Runs probes through the breaker itself so state transitions use
   * cockatiel's own half-open machinery.
   */
  async sweep() {
    this.stats.sweeps += 1;
    this.stats.lastSweepAt = Date.now();
    const registry = getCockatielRegistry();
    const work = [];
    for (const [providerName, probeFn] of probes) {
      const breaker = registry.breakers.get(providerName);
      if (!breaker || breaker.state === 'CLOSED') continue;
      work.push(
        (async () => {
          this.stats.probesSent += 1;
          try {
            await breaker.execute(probeFn);
            this.stats.recoveries += 1;
            logger.info({ provider: providerName }, '[HealthProbe] Provider recovered via synthetic probe — circuit closed without a live request paying for the test');
          } catch (err) {
            // Expected while the provider is still down (or the circuit is
            // OPEN and not yet past halfOpenAfter, where execute rejects
            // immediately without dialing). Stay quiet; the breaker's own
            // state logging covers transitions.
            this.stats.failures += 1;
            logger.debug({ provider: providerName, error: err.message }, '[HealthProbe] probe failed');
          }
        })()
      );
    }
    await Promise.all(work);
  }

  getStatus() {
    return {
      enabled: ENABLED,
      running: !!this.timer,
      intervalMs: PROBE_INTERVAL_MS,
      registeredProviders: [...probes.keys()],
      ...this.stats,
    };
  }
}

let prober = null;

/** @returns {HealthProber} singleton */
function getHealthProber() {
  if (!prober) prober = new HealthProber();
  return prober;
}

module.exports = { getHealthProber, registerHealthProbe };
