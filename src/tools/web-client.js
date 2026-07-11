const { Agent, fetch: undiciFetch, setGlobalDispatcher } = require("undici");
const logger = require("../logger");

/**
 * Create an optimized HTTP agent for web search and fetch operations
 * with connection pooling and keep-alive enabled
 */
function createWebAgent() {
  const agent = new Agent({
    // Connection pooling settings
    connections: 50, // Max concurrent connections per origin
    pipelining: 10, // Max pipelined requests per connection

    // Keep-alive settings
    keepAliveTimeout: 60000, // Keep connections alive for 60s
    keepAliveMaxTimeout: 600000, // Maximum keep-alive time (10 minutes)

    // Connection timeouts
    connectTimeout: 10000, // 10s to establish connection
    bodyTimeout: 30000, // 30s to receive response body
    headersTimeout: 10000, // 10s to receive headers

    // Connection reuse
    maxRedirections: 5,

    // Performance optimizations
    strictContentLength: false, // Don't require Content-Length header
  });

  logger.info({
    connections: 50,
    keepAliveTimeout: 60000,
    pipelining: 10,
  }, "Web HTTP agent initialized with connection pooling");

  return agent;
}

/**
 * Global web agent instance - reused across all web search/fetch calls
 */
const webAgent = createWebAgent();

/**
 * Fetch with the optimized agent (uses undici.fetch for dispatcher support)
 */
async function fetchWithAgent(url, options = {}) {
  return undiciFetch(url, {
    ...options,
    dispatcher: webAgent,
  });
}

/**
 * Get connection pool statistics
 */
function getAgentStats() {
  // Undici doesn't expose detailed stats easily, but we can log connection info
  return {
    agent: "undici",
    keepAlive: true,
    maxConnections: 50,
    pipelining: 10,
  };
}

module.exports = {
  webAgent,
  fetchWithAgent,
  getAgentStats,
};
