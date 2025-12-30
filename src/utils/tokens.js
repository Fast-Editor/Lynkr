const logger = require("../logger");

/**
 * Estimate token count (rough approximation: 4 chars ≈ 1 token)
 * For production, consider using @anthropic-ai/tokenizer for exact counts
 */
function estimateTokens(text) {
  if (!text) return 0;
  if (typeof text !== 'string') {
    text = JSON.stringify(text);
  }
  return Math.ceil(text.length / 4);
}

/**
 * Count tokens in a full API payload
 */
function countPayloadTokens(payload) {
  const breakdown = {
    system: 0,
    tools: 0,
    messages: 0,
    total: 0
  };

  // System prompt
  if (payload.system) {
    if (Array.isArray(payload.system)) {
      breakdown.system = payload.system.reduce((sum, block) =>
        sum + estimateTokens(block.text || block), 0);
    } else {
      breakdown.system = estimateTokens(payload.system);
    }
  }

  // Tools
  if (payload.tools && Array.isArray(payload.tools)) {
    breakdown.tools = estimateTokens(JSON.stringify(payload.tools));
  }

  // Messages
  if (payload.messages && Array.isArray(payload.messages)) {
    for (const msg of payload.messages) {
      // Message content
      if (typeof msg.content === 'string') {
        breakdown.messages += estimateTokens(msg.content);
      } else if (Array.isArray(msg.content)) {
        breakdown.messages += msg.content.reduce((sum, block) => {
          if (block.type === 'text') {
            return sum + estimateTokens(block.text || '');
          } else if (block.type === 'tool_result') {
            return sum + estimateTokens(block.content || '');
          } else if (block.type === 'image') {
            // Images: rough estimate based on source length
            return sum + estimateTokens(JSON.stringify(block.source || {}));
          }
          return sum + estimateTokens(JSON.stringify(block));
        }, 0);
      }

      // Tool calls
      if (msg.tool_calls) {
        breakdown.messages += estimateTokens(JSON.stringify(msg.tool_calls));
      }
    }
  }

  breakdown.total = breakdown.system + breakdown.tools + breakdown.messages;
  return breakdown;
}

/**
 * Extract token usage from API response
 */
function extractUsageFromResponse(response) {
  if (!response || !response.usage) {
    return null;
  }

  return {
    inputTokens: response.usage.input_tokens || 0,
    outputTokens: response.usage.output_tokens || 0,
    cacheCreationTokens: response.usage.cache_creation_input_tokens || 0,
    cacheReadTokens: response.usage.cache_read_input_tokens || 0,
    totalTokens: (response.usage.input_tokens || 0) + (response.usage.output_tokens || 0)
  };
}

/**
 * Calculate cost based on token usage
 * Prices as of 2025 (update as needed)
 */
function calculateCost(usage, model = 'claude-sonnet-4-5') {
  const PRICES = {
    'claude-opus-4-5': { input: 15, output: 75, cache_write: 18.75, cache_read: 1.5 },
    'claude-sonnet-4-5': { input: 3, output: 15, cache_write: 3.75, cache_read: 0.3 },
    'claude-haiku-4': { input: 0.8, output: 4, cache_write: 1, cache_read: 0.08 },
    'databricks-claude-sonnet-4-5': { input: 3, output: 15, cache_write: 3.75, cache_read: 0.3 },
    'databricks-claude-haiku-4': { input: 0.8, output: 4, cache_write: 1, cache_read: 0.08 },
  };

  const price = PRICES[model] || PRICES['claude-sonnet-4-5'];

  const inputCost = (usage.inputTokens / 1_000_000) * price.input;
  const outputCost = (usage.outputTokens / 1_000_000) * price.output;
  const cacheWriteCost = ((usage.cacheCreationTokens || 0) / 1_000_000) * price.cache_write;
  const cacheReadCost = ((usage.cacheReadTokens || 0) / 1_000_000) * price.cache_read;

  return {
    input: inputCost,
    output: outputCost,
    cacheWrite: cacheWriteCost,
    cacheRead: cacheReadCost,
    total: inputCost + outputCost + cacheWriteCost + cacheReadCost
  };
}

/**
 * Log token usage with breakdown
 */
function logTokenUsage(context, estimated, actual) {
  const efficiency = actual ? ((actual.totalTokens / estimated.total) * 100).toFixed(1) : 'N/A';

  logger.info({
    context,
    estimated: {
      system: estimated.system,
      tools: estimated.tools,
      messages: estimated.messages,
      total: estimated.total
    },
    actual: actual || 'not available',
    estimateAccuracy: efficiency + '%'
  }, 'Token usage tracked');
}

/**
 * Store token usage in session metadata
 */
function recordTokenUsage(session, turnId, estimated, actual, model) {
  if (!session || !actual) return;

  session.metadata = session.metadata || {};
  session.metadata.tokenUsage = session.metadata.tokenUsage || [];

  const cost = calculateCost(actual, model);

  session.metadata.tokenUsage.push({
    turn: turnId,
    timestamp: Date.now(),
    estimated,
    actual,
    cost,
    model
  });

  // Track cumulative totals
  session.metadata.totalTokens = (session.metadata.totalTokens || 0) + actual.totalTokens;
  session.metadata.totalCost = (session.metadata.totalCost || 0) + cost.total;
}

/**
 * Get token statistics for a session
 */
function getSessionTokenStats(session) {
  if (!session || !session.metadata || !session.metadata.tokenUsage) {
    return {
      turns: 0,
      totalTokens: 0,
      totalCost: 0,
      averageTokensPerTurn: 0,
      breakdown: []
    };
  }

  const usage = session.metadata.tokenUsage;
  const totalTokens = session.metadata.totalTokens || 0;
  const totalCost = session.metadata.totalCost || 0;

  return {
    turns: usage.length,
    totalTokens,
    totalCost,
    averageTokensPerTurn: usage.length > 0 ? Math.round(totalTokens / usage.length) : 0,
    cacheHitRate: calculateCacheHitRate(usage),
    breakdown: usage
  };
}

/**
 * Calculate cache hit rate from usage history
 */
function calculateCacheHitRate(usageHistory) {
  if (!usageHistory || usageHistory.length === 0) return 0;

  const totalCacheableTokens = usageHistory.reduce((sum, turn) => {
    return sum + (turn.actual.inputTokens || 0);
  }, 0);

  const cachedTokens = usageHistory.reduce((sum, turn) => {
    return sum + (turn.actual.cacheReadTokens || 0);
  }, 0);

  return totalCacheableTokens > 0
    ? ((cachedTokens / totalCacheableTokens) * 100).toFixed(1)
    : 0;
}

module.exports = {
  estimateTokens,
  countPayloadTokens,
  extractUsageFromResponse,
  calculateCost,
  logTokenUsage,
  recordTokenUsage,
  getSessionTokenStats
};
