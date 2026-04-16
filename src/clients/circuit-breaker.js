/**
 * Circuit Breaker Pattern — backed by Cockatiel
 *
 * This module re-exports Cockatiel-backed adapters from resilience.js
 * while preserving the same API surface for all consumers.
 */
const {
  CockatielCircuitBreaker: CircuitBreaker,
  CircuitBreakerError,
  CockatielRegistry: CircuitBreakerRegistry,
  getCockatielRegistry: getCircuitBreakerRegistry,
  STATE,
} = require("./resilience");

module.exports = {
  CircuitBreaker,
  CircuitBreakerError,
  CircuitBreakerRegistry,
  getCircuitBreakerRegistry,
  STATE,
};
