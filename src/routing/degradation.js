/**
 * Degradation Registry
 *
 * Tracks silent-fallback occurrences across the routing pipeline. Every catch
 * block in the routing path that used to `logger.debug` and fall through now
 * calls `record(component, err)` here instead, giving us:
 *
 *   - A counter per subsystem (visible via getRoutingStats)
 *   - A warn-once-per-hour policy per component (so the first failure surfaces
 *     in ops, but a wedged subsystem doesn't spam)
 *   - The last error message and timestamp for postmortem
 *
 * @module routing/degradation
 */

const logger = require("../logger");

// TODO(prometheus): expose these counters as Prometheus gauges once the
// project ships a prom-client registry (no such registry today; the WS0 plan
// authorised skipping this — getRoutingStats().degradation is the interim
// signal).

const KNOWN_COMPONENTS = new Set([
  "risk",
  "embeddings",
  "agentic",
  "tier_select",
  "cost_optimize",
  "context_validate",
  "vision_guard",
  "knn",
  "bandit",
  "deadline",
  "tenant",
  "feedback",
  "calibration",
]);

const WARN_INTERVAL_MS = 60 * 60 * 1000;

/** @type {Map<string, {count:number, lastError:string|null, lastAt:number, lastWarnedAt:number}>} */
const counters = new Map();

function _entry(component) {
  let e = counters.get(component);
  if (!e) {
    e = { count: 0, lastError: null, lastAt: 0, lastWarnedAt: 0 };
    counters.set(component, e);
  }
  return e;
}

/**
 * Record a degradation event. Warns once per hour per component, otherwise
 * increments the counter silently at debug level.
 *
 * @param {string} component - One of KNOWN_COMPONENTS. Unknown names are
 *   accepted (kept for forward compatibility) but log a debug notice.
 * @param {Error|{message?:string}|string} err
 */
function record(component, err) {
  if (!component) return;
  if (!KNOWN_COMPONENTS.has(component)) {
    logger.debug({ component }, "[Degradation] Unknown component recorded");
  }

  const message = err == null
    ? "unknown"
    : typeof err === "string"
      ? err
      : (err.message || String(err));

  const now = Date.now();
  const e = _entry(component);
  e.count += 1;
  e.lastError = message;
  e.lastAt = now;

  if (now - e.lastWarnedAt >= WARN_INTERVAL_MS) {
    e.lastWarnedAt = now;
    logger.warn({ component, err: message, count: e.count }, "[Degradation] Subsystem failed, falling through");
  } else {
    logger.debug({ component, err: message, count: e.count }, "[Degradation] Subsystem failed, falling through");
  }
}

/**
 * Snapshot of per-component counters, safe to serialize into stats responses.
 * @returns {Object<string, {count:number, lastError:string|null, lastAt:number}>}
 */
function getCounts() {
  const out = {};
  for (const [name, e] of counters.entries()) {
    out[name] = { count: e.count, lastError: e.lastError, lastAt: e.lastAt };
  }
  return out;
}

/** Test helper — reset all counters. */
function _clear() {
  counters.clear();
}

module.exports = {
  record,
  getCounts,
  KNOWN_COMPONENTS,
  _clear,
};
