/**
 * Request Routing Module
 *
 * Determines the optimal provider for handling requests based on
 * complexity analysis and configuration.
 *
 * This module re-exports the smart routing system for backward compatibility.
 * All routing logic is now in src/routing/index.js
 *
 * @module clients/routing
 */

const smartRouting = require('../routing');

// Re-export all functions from smart routing
module.exports = {
  determineProviderSmart: smartRouting.determineProviderSmart,
  isFallbackEnabled: smartRouting.isFallbackEnabled,
  getFallbackProvider: smartRouting.getFallbackProvider,
  getRoutingHeaders: smartRouting.getRoutingHeaders,
  getRoutingStats: smartRouting.getRoutingStats,
  analyzeComplexity: smartRouting.analyzeComplexity,
};
