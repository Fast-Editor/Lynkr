const dns = require('dns');
const { AsyncLocalStorage } = require('async_hooks');
const logger = require('../logger');

/**
 * AsyncLocalStorage for storing DNS resolution context.
 * Used by audit logger to retrieve resolved IP addresses.
 */
const dnsContext = new AsyncLocalStorage();

/**
 * Creates a custom DNS lookup function with logging for http/https agents.
 * Logs DNS resolution timing and results at debug level.
 * Stores resolved IPs in AsyncLocalStorage for audit logging.
 *
 * @param {string} providerLabel - Label for the provider (e.g., 'HTTP', 'HTTPS', 'Undici')
 * @returns {Function} Custom lookup function for agent configuration
 *
 * @example
 * const httpsAgent = new https.Agent({
 *   keepAlive: true,
 *   lookup: createDnsLogger('HTTPS')
 * });
 */
function createDnsLogger(providerLabel) {
  return function customLookup(hostname, options, callback) {
    const startTime = Date.now();

    // Handle both callback and options-only signatures
    // dns.lookup(hostname, callback) vs dns.lookup(hostname, options, callback)
    const actualCallback = typeof options === 'function' ? options : callback;
    const actualOptions = typeof options === 'function' ? {} : options;

    dns.lookup(hostname, actualOptions, (err, address, family) => {
      const duration = Date.now() - startTime;

      if (err) {
        logger.warn({
          provider: providerLabel,
          hostname,
          duration,
          error: err.message,
          msg: 'DNS resolution failed'
        });
      } else {
        logger.debug({
          provider: providerLabel,
          hostname,
          resolvedIp: address,
          ipFamily: family,
          duration,
          msg: 'DNS resolution completed'
        });

        // Store resolved IP in AsyncLocalStorage for audit logging
        const store = dnsContext.getStore();
        if (store) {
          if (!store.resolvedIps) {
            store.resolvedIps = {};
          }
          store.resolvedIps[hostname] = {
            ip: address,
            family: family,
            timestamp: Date.now(),
          };
        }
      }

      actualCallback(err, address, family);
    });
  };
}

/**
 * Get resolved IP address for a hostname from AsyncLocalStorage.
 * Returns null if not found or if outside AsyncLocalStorage context.
 *
 * @param {string} hostname - Hostname to look up
 * @returns {Object|null} { ip, family, timestamp } or null
 */
function getResolvedIp(hostname) {
  const store = dnsContext.getStore();
  if (!store || !store.resolvedIps) {
    return null;
  }
  return store.resolvedIps[hostname] || null;
}

/**
 * Run a function within DNS context storage.
 * This enables storing DNS resolutions for the duration of the function.
 *
 * @param {Function} fn - Function to run within context
 * @returns {*} Result of the function
 */
function runWithDnsContext(fn) {
  return dnsContext.run({ resolvedIps: {} }, fn);
}

module.exports = {
  createDnsLogger,
  getResolvedIp,
  runWithDnsContext,
  dnsContext,
};