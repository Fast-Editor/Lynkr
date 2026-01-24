/**
 * Headroom Sidecar HTTP Client
 *
 * HTTP client for communicating with the Headroom compression sidecar.
 * Provides message compression, CCR retrieval, and metrics collection.
 */

const logger = require("../logger");
const config = require("../config");

// Metrics tracking
const metrics = {
  totalCalls: 0,
  successfulCompressions: 0,
  skippedCompressions: 0,
  failures: 0,
  totalTokensSaved: 0,
  totalLatencyMs: 0,
  ccrRetrievals: 0,
  ccrSearches: 0,
};

/**
 * Get Headroom configuration
 */
function getConfig() {
  return config.headroom;
}

/**
 * Check if Headroom is enabled
 */
function isEnabled() {
  return config.headroom?.enabled === true;
}

/**
 * Check if Headroom sidecar is healthy
 */
async function checkHealth() {
  const headroomConfig = getConfig();

  if (!isEnabled()) {
    return { available: false, reason: "disabled" };
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);

    const response = await fetch(`${headroomConfig.endpoint}/health`, {
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (response.ok) {
      const data = await response.json();
      return {
        available: data.headroom_loaded === true,
        status: data.status,
        ccrEnabled: data.ccr_enabled,
        llmlinguaEnabled: data.llmlingua_enabled,
        entriesCached: data.entries_cached,
      };
    }
    return { available: false, reason: "unhealthy", status: response.status };
  } catch (err) {
    return { available: false, reason: err.message };
  }
}

/**
 * Estimate tokens in messages (rough approximation: ~4 chars per token)
 */
function estimateTokens(messages) {
  const text = JSON.stringify(messages);
  return Math.ceil(text.length / 4);
}

/**
 * Compress messages using Headroom sidecar
 *
 * @param {Array} messages - Chat messages in Anthropic format
 * @param {Array} tools - Tool definitions
 * @param {Object} options - Compression options
 * @returns {Object} { messages, tools, compressed, stats }
 */
async function compressMessages(messages, tools = [], options = {}) {
  const headroomConfig = getConfig();
  metrics.totalCalls++;

  if (!isEnabled()) {
    return {
      messages,
      tools,
      compressed: false,
      stats: { skipped: true, reason: "disabled" },
    };
  }

  // Estimate tokens - skip if below threshold
  const estimatedTokens = estimateTokens(messages);
  if (estimatedTokens < headroomConfig.minTokens) {
    metrics.skippedCompressions++;
    return {
      messages,
      tools,
      compressed: false,
      stats: {
        skipped: true,
        reason: `Below threshold (${estimatedTokens} < ${headroomConfig.minTokens})`,
      },
    };
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), headroomConfig.timeoutMs);

    const response = await fetch(`${headroomConfig.endpoint}/compress`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages,
        tools,
        model: options.model || "claude-3-5-sonnet-20241022",
        model_limit: options.modelLimit || 200000,
        mode: options.mode || headroomConfig.mode,
        token_budget: options.tokenBudget,
        query_context: options.queryContext,
        preserve_recent_turns: options.preserveRecentTurns,
        target_ratio: options.targetRatio,
      }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Headroom returned ${response.status}: ${errorText}`);
    }

    const result = await response.json();

    // Update metrics
    if (result.compressed) {
      metrics.successfulCompressions++;
      metrics.totalTokensSaved += result.stats?.tokens_saved || 0;
      metrics.totalLatencyMs += result.stats?.latency_ms || 0;

      logger.info(
        {
          tokensBefore: result.stats?.tokens_before,
          tokensAfter: result.stats?.tokens_after,
          savingsPercent: result.stats?.savings_percent,
          latencyMs: result.stats?.latency_ms,
          transforms: result.stats?.transforms_applied,
        },
        "Headroom compression applied"
      );
    } else {
      metrics.skippedCompressions++;
      logger.debug({ reason: result.stats?.reason }, "Headroom compression skipped");
    }

    return {
      messages: result.messages,
      tools: result.tools,
      compressed: result.compressed,
      stats: result.stats,
    };
  } catch (err) {
    metrics.failures++;

    if (err.name === "AbortError") {
      logger.warn({ timeoutMs: headroomConfig.timeoutMs }, "Headroom compression timed out");
    } else {
      logger.warn({ error: err.message }, "Headroom compression failed, using original");
    }

    return {
      messages,
      tools,
      compressed: false,
      stats: { skipped: true, reason: err.message },
    };
  }
}

/**
 * Retrieve original content from CCR store
 *
 * @param {string} hash - Hash key from compression marker
 * @param {string} query - Optional search query to filter results
 * @param {number} maxResults - Maximum results for search (default 20)
 * @returns {Object} { success, content, itemsRetrieved, wasSearch, error }
 */
async function ccrRetrieve(hash, query = null, maxResults = 20) {
  const headroomConfig = getConfig();

  if (!isEnabled()) {
    return { success: false, error: "Headroom disabled" };
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), headroomConfig.timeoutMs);

    const response = await fetch(`${headroomConfig.endpoint}/ccr/retrieve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hash, query, max_results: maxResults }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!response.ok) {
      throw new Error(`CCR retrieve returned ${response.status}`);
    }

    const result = await response.json();

    if (result.success) {
      if (result.was_search) {
        metrics.ccrSearches++;
        logger.debug({ hash, query, items: result.items_retrieved }, "CCR search completed");
      } else {
        metrics.ccrRetrievals++;
        logger.debug({ hash, items: result.items_retrieved }, "CCR retrieval completed");
      }
    }

    return {
      success: result.success,
      content: result.content,
      itemsRetrieved: result.items_retrieved || 0,
      wasSearch: result.was_search || false,
      error: result.error,
    };
  } catch (err) {
    logger.error({ error: err.message, hash }, "CCR retrieval failed");
    return { success: false, error: err.message };
  }
}

/**
 * Track compression for proactive CCR expansion
 */
async function ccrTrack(hashKey, turnNumber, toolName, sample) {
  const headroomConfig = getConfig();

  if (!isEnabled()) {
    return { tracked: false };
  }

  try {
    const params = new URLSearchParams({
      hash_key: hashKey,
      turn_number: String(turnNumber),
      tool_name: toolName,
      sample: sample.substring(0, 500),
    });

    const response = await fetch(`${headroomConfig.endpoint}/ccr/track?${params}`, {
      method: "POST",
      signal: AbortSignal.timeout(2000),
    });

    if (response.ok) {
      return await response.json();
    }
    return { tracked: false };
  } catch (err) {
    logger.debug({ error: err.message }, "CCR tracking failed");
    return { tracked: false };
  }
}

/**
 * Analyze query for proactive CCR expansion
 */
async function ccrAnalyze(query, turnNumber) {
  const headroomConfig = getConfig();

  if (!isEnabled()) {
    return { expansions: [] };
  }

  try {
    const response = await fetch(`${headroomConfig.endpoint}/ccr/analyze`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, turn_number: turnNumber }),
      signal: AbortSignal.timeout(2000),
    });

    if (response.ok) {
      return await response.json();
    }
    return { expansions: [] };
  } catch (err) {
    logger.debug({ error: err.message }, "CCR analysis failed");
    return { expansions: [] };
  }
}

/**
 * Compress text using LLMLingua-2 ML compression
 * (Optional - requires LLMLingua enabled in sidecar)
 */
async function llmlinguaCompress(text, targetRatio = 0.5, forceTokens = null) {
  const headroomConfig = getConfig();

  if (!isEnabled()) {
    return { success: false, error: "Headroom disabled" };
  }

  try {
    const params = new URLSearchParams({
      text,
      target_ratio: String(targetRatio),
    });

    if (forceTokens && Array.isArray(forceTokens)) {
      params.append("force_tokens", JSON.stringify(forceTokens));
    }

    const response = await fetch(`${headroomConfig.endpoint}/compress/llmlingua?${params}`, {
      method: "POST",
      signal: AbortSignal.timeout(30000), // LLMLingua can be slow
    });

    if (!response.ok) {
      const error = await response.text();
      return { success: false, error };
    }

    const result = await response.json();
    return {
      success: true,
      compressed: result.compressed,
      originalTokens: result.original_tokens,
      compressedTokens: result.compressed_tokens,
      ratio: result.ratio,
    };
  } catch (err) {
    logger.error({ error: err.message }, "LLMLingua compression failed");
    return { success: false, error: err.message };
  }
}

/**
 * Get client-side metrics
 */
function getMetrics() {
  return {
    ...metrics,
    averageLatencyMs:
      metrics.successfulCompressions > 0
        ? Math.round(metrics.totalLatencyMs / metrics.successfulCompressions)
        : 0,
    compressionRate:
      metrics.totalCalls > 0
        ? Math.round((metrics.successfulCompressions / metrics.totalCalls) * 100)
        : 0,
    failureRate:
      metrics.totalCalls > 0 ? Math.round((metrics.failures / metrics.totalCalls) * 100) : 0,
  };
}

/**
 * Get server-side metrics from sidecar
 */
async function getServerMetrics() {
  const headroomConfig = getConfig();

  if (!isEnabled()) {
    return null;
  }

  try {
    const response = await fetch(`${headroomConfig.endpoint}/metrics`, {
      signal: AbortSignal.timeout(2000),
    });

    if (response.ok) {
      return await response.json();
    }
    return null;
  } catch (err) {
    logger.debug({ error: err.message }, "Failed to fetch server metrics");
    return null;
  }
}

/**
 * Get combined metrics (client + server)
 */
async function getCombinedMetrics() {
  const clientMetrics = getMetrics();
  const serverMetrics = await getServerMetrics();

  return {
    enabled: isEnabled(),
    endpoint: getConfig().endpoint,
    client: clientMetrics,
    server: serverMetrics,
  };
}

/**
 * Reset client-side metrics
 */
function resetMetrics() {
  Object.keys(metrics).forEach((key) => {
    metrics[key] = 0;
  });
}

module.exports = {
  isEnabled,
  checkHealth,
  compressMessages,
  ccrRetrieve,
  ccrTrack,
  ccrAnalyze,
  llmlinguaCompress,
  getMetrics,
  getServerMetrics,
  getCombinedMetrics,
  resetMetrics,
  estimateTokens,
};
