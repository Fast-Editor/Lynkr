/**
 * Token Budget Management
 *
 * Enforces token budgets and applies adaptive compression
 * when payloads approach or exceed limits.
 *
 */

const logger = require('../logger');
const config = require('../config');
const tokens = require('../utils/tokens');
const historyCompression = require('./compression');
const systemPrompt = require('../prompts/system');

/**
 * Check if payload exceeds token budget
 *
 * @param {Object} payload - Request payload
 * @param {number} warningThreshold - Warning threshold (tokens)
 * @param {number} maxThreshold - Maximum threshold (tokens)
 * @returns {Object} Budget check result
 */
function checkBudget(payload, warningThreshold = null, maxThreshold = null) {
  warningThreshold = warningThreshold ?? config.tokenBudget?.warning ?? 100000;
  maxThreshold = maxThreshold ?? config.tokenBudget?.max ?? 180000;

  const estimated = tokens.countPayloadTokens(payload);
  const totalTokens = estimated.total;

  const warningLevel = totalTokens / warningThreshold;
  const maxLevel = totalTokens / maxThreshold;

  return {
    estimated,
    totalTokens,
    warningThreshold,
    maxThreshold,
    atWarning: totalTokens >= warningThreshold,
    overMax: totalTokens >= maxThreshold,
    warningLevel: warningLevel.toFixed(2),
    maxLevel: maxLevel.toFixed(2),
    needsCompression: totalTokens >= warningThreshold
  };
}

/**
 * Enforce token budget with adaptive compression
 *
 * Applies progressively aggressive compression strategies
 * until payload fits within budget.
 *
 * @param {Object} payload - Request payload
 * @param {Object} options - Budget options
 * @returns {Object} Optimized payload and statistics
 */
function enforceBudget(payload, options = {}) {
  const opts = {
    warningThreshold: options.warningThreshold ?? config.tokenBudget?.warning ?? 100000,
    maxThreshold: options.maxThreshold ?? config.tokenBudget?.max ?? 180000,
    enforcement: options.enforcement ?? config.tokenBudget?.enforcement ?? true,
  };

  if (!opts.enforcement) {
    return { payload, compressed: false, strategy: 'none' };
  }

  const initialCheck = checkBudget(payload, opts.warningThreshold, opts.maxThreshold);

  if (!initialCheck.needsCompression) {
    return {
      payload,
      compressed: false,
      strategy: 'none',
      budget: initialCheck
    };
  }

  // Clone payload only when compression is needed (avoids unnecessary allocation)
  let optimized = JSON.parse(JSON.stringify(payload));
  let strategy = [];

  logger.info({
    initialTokens: initialCheck.totalTokens,
    warningThreshold: opts.warningThreshold,
    maxThreshold: opts.maxThreshold,
    overBudget: initialCheck.totalTokens - opts.maxThreshold
  }, 'Token budget exceeded, applying adaptive compression');

  // Strategy 1: Compress history more aggressively
  if (optimized.messages && optimized.messages.length > 10) {
    const originalMessages = optimized.messages;
    optimized.messages = historyCompression.compressHistory(originalMessages, {
      keepRecentTurns: 5, // More aggressive: keep only 5 recent
      summarizeOlder: true,
      enabled: true
    });
    strategy.push('aggressive_history_compression');

    const afterHistory = checkBudget(optimized, opts.warningThreshold, opts.maxThreshold);
    if (!afterHistory.overMax) {
      return finalizeBudgetEnforcement(payload, optimized, strategy, initialCheck, afterHistory);
    }
  }

  // Strategy 2: Further compress history (keep only 3 turns)
  if (optimized.messages && optimized.messages.length > 5) {
    const originalMessages = optimized.messages;
    optimized.messages = historyCompression.compressHistory(originalMessages, {
      keepRecentTurns: 3, // Very aggressive: keep only 3
      summarizeOlder: true,
      enabled: true
    });
    strategy.push('extreme_history_compression');

    const afterExtreme = checkBudget(optimized, opts.warningThreshold, opts.maxThreshold);
    if (!afterExtreme.overMax) {
      return finalizeBudgetEnforcement(payload, optimized, strategy, initialCheck, afterExtreme);
    }
  }

  // Strategy 3: Compress system prompt aggressively
  if (optimized.system) {
    const originalSystem = optimized.system;
    optimized.system = compressSystemPromptAggressively(originalSystem, optimized);
    strategy.push('aggressive_system_compression');

    const afterSystem = checkBudget(optimized, opts.warningThreshold, opts.maxThreshold);
    if (!afterSystem.overMax) {
      return finalizeBudgetEnforcement(payload, optimized, strategy, initialCheck, afterSystem);
    }
  }

  // Strategy 4: Remove tool descriptions entirely (keep only names/schemas)
  if (optimized.tools && optimized.tools.length > 0) {
    optimized.tools = optimized.tools.map(tool => ({
      name: tool.name,
      input_schema: tool.input_schema
      // Remove description entirely
    }));
    strategy.push('remove_tool_descriptions');

    const afterTools = checkBudget(optimized, opts.warningThreshold, opts.maxThreshold);
    if (!afterTools.overMax) {
      return finalizeBudgetEnforcement(payload, optimized, strategy, initialCheck, afterTools);
    }
  }

  // Strategy 5: Reduce tools to essential only
  if (optimized.tools && optimized.tools.length > 5) {
    const essentialTools = ['Read', 'Write', 'Edit', 'Bash', 'Grep'];
    optimized.tools = optimized.tools.filter(t => essentialTools.includes(t.name));
    strategy.push('reduce_to_essential_tools');

    const afterToolReduction = checkBudget(optimized, opts.warningThreshold, opts.maxThreshold);
    if (!afterToolReduction.overMax) {
      return finalizeBudgetEnforcement(payload, optimized, strategy, initialCheck, afterToolReduction);
    }
  }

  // Strategy 6: Last resort - truncate system prompt
  if (optimized.system) {
    const systemText = typeof optimized.system === 'string'
      ? optimized.system
      : systemPrompt.flattenBlocks(optimized.system);

    optimized.system = systemText.substring(0, 5000) + '\n\n[System prompt truncated due to token budget]';
    strategy.push('truncate_system_prompt');

    const afterTruncate = checkBudget(optimized, opts.warningThreshold, opts.maxThreshold);
    if (!afterTruncate.overMax) {
      return finalizeBudgetEnforcement(payload, optimized, strategy, initialCheck, afterTruncate);
    }
  }

  // Final check
  const finalCheck = checkBudget(optimized, opts.warningThreshold, opts.maxThreshold);

  if (finalCheck.overMax) {
    logger.error({
      initialTokens: initialCheck.totalTokens,
      finalTokens: finalCheck.totalTokens,
      maxThreshold: opts.maxThreshold,
      strategiesApplied: strategy
    }, 'Failed to compress payload within token budget');
  }

  return finalizeBudgetEnforcement(payload, optimized, strategy, initialCheck, finalCheck);
}

/**
 * Finalize budget enforcement and return results
 */
function finalizeBudgetEnforcement(original, optimized, strategy, initialCheck, finalCheck) {
  const saved = initialCheck.totalTokens - finalCheck.totalTokens;
  const percentage = initialCheck.totalTokens > 0
    ? ((saved / initialCheck.totalTokens) * 100).toFixed(1)
    : '0.0';

  logger.info({
    strategiesApplied: strategy,
    initialTokens: initialCheck.totalTokens,
    finalTokens: finalCheck.totalTokens,
    saved,
    percentage,
    nowWithinBudget: !finalCheck.overMax
  }, 'Budget enforcement completed');

  return {
    payload: optimized,
    compressed: true,
    strategy: strategy.join(' -> '),
    initialBudget: initialCheck,
    finalBudget: finalCheck,
    stats: {
      initialTokens: initialCheck.totalTokens,
      finalTokens: finalCheck.totalTokens,
      saved,
      percentage
    }
  };
}

/**
 * Compress system prompt aggressively for budget enforcement
 */
function compressSystemPromptAggressively(systemPromptContent, payload) {
  let text = typeof systemPromptContent === 'string'
    ? systemPromptContent
    : systemPrompt.flattenBlocks(systemPromptContent);

  // Remove all examples
  text = text.replace(/<example>[\s\S]*?<\/example>/g, '');

  // Remove verbose sections
  text = text.replace(/# (Background|Context|Examples|Notes|Tips|Guidelines)[\s\S]*?(?=\n#|\n\n[A-Z]|$)/gi, '');

  // Remove excessive whitespace
  text = text.replace(/\n{3,}/g, '\n\n');
  text = text.replace(/[ \t]+\n/g, '\n');

  // Remove comments
  text = text.replace(/<!--[\s\S]*?-->/g, '');

  return text;
}

/**
 * Get budget allocation for different sections
 *
 * Helps prioritize token allocation across system/tools/messages
 *
 * @param {number} totalBudget - Total token budget
 * @returns {Object} Allocation breakdown
 */
function getAllocation(totalBudget = 180000) {
  return {
    system: Math.floor(totalBudget * 0.15), // 15% for system prompt
    tools: Math.floor(totalBudget * 0.10),  // 10% for tool definitions
    messages: Math.floor(totalBudget * 0.60), // 60% for message history
    output: Math.floor(totalBudget * 0.15),   // 15% reserved for output
  };
}

/**
 * Analyze budget usage breakdown
 *
 * @param {Object} payload - Request payload
 * @returns {Object} Budget breakdown analysis
 */
function analyzeBudgetUsage(payload) {
  const breakdown = tokens.countPayloadTokens(payload);

  const total = breakdown.total;
  const allocation = getAllocation(config.tokenBudget?.max ?? 180000);

  return {
    usage: breakdown,
    allocation,
    percentages: {
      system: total > 0 ? ((breakdown.system / total) * 100).toFixed(1) : '0.0',
      tools: total > 0 ? ((breakdown.tools / total) * 100).toFixed(1) : '0.0',
      messages: total > 0 ? ((breakdown.messages / total) * 100).toFixed(1) : '0.0',
    },
    recommendations: generateRecommendations(breakdown, allocation)
  };
}

/**
 * Generate recommendations based on budget usage
 */
function generateRecommendations(breakdown, allocation) {
  const recommendations = [];

  if (breakdown.system > allocation.system) {
    recommendations.push({
      section: 'system',
      issue: 'System prompt exceeds recommended allocation',
      suggestion: 'Enable dynamic system prompts (SYSTEM_PROMPT_MODE=dynamic)'
    });
  }

  if (breakdown.tools > allocation.tools) {
    recommendations.push({
      section: 'tools',
      issue: 'Tool definitions exceed recommended allocation',
      suggestion: 'Enable minimal tool descriptions (TOOL_DESCRIPTIONS=minimal)'
    });
  }

  if (breakdown.messages > allocation.messages) {
    recommendations.push({
      section: 'messages',
      issue: 'Message history exceeds recommended allocation',
      suggestion: 'Enable history compression (HISTORY_COMPRESSION_ENABLED=true)'
    });
  }

  return recommendations;
}

module.exports = {
  checkBudget,
  enforceBudget,
  getAllocation,
  analyzeBudgetUsage,
};
