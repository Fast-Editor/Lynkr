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
const config = require('../config');

// Synchronous version for benchmarking/tests
// (when tiers are disabled, routing is purely static)
function determineProviderSync(payload) {
  const primaryProvider = config.modelProvider?.type || 'databricks';
  const defaultModel = config.modelProvider?.defaultModel || 'databricks-claude-sonnet-4-5';

  return {
    provider: primaryProvider,
    model: defaultModel,
    reason: 'static_provider'
  };
}

// Re-export all functions from smart routing
module.exports = {
  determineProviderSmart: smartRouting.determineProviderSmart,
  determineProviderSync,
  isFallbackEnabled: smartRouting.isFallbackEnabled,
  getFallbackProvider: smartRouting.getFallbackProvider,
  getRoutingHeaders: smartRouting.getRoutingHeaders,
  getRoutingStats: smartRouting.getRoutingStats,
  analyzeComplexity: smartRouting.analyzeComplexity,
};
