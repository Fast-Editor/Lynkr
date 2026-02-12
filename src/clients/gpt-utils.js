/**
 * GPT-specific utilities for handling tool calls and responses
 * All settings are hardcoded - no env vars required
 *
 * This module addresses GPT model compatibility issues when using Azure OpenAI
 * through Lynkr proxy with Claude Code:
 * - GPT doesn't interpret "0 files found" as a final answer
 * - GPT retries the same tool expecting different results
 * - GPT needs explicit guidance on tool result interpretation
 */

const logger = require("../logger");

// Hardcoded GPT settings - optimized for GPT model behavior
const GPT_SETTINGS = {
  toolLoopThreshold: 2,        // Lower than Claude's 3 to catch loops earlier
  enhancedFormatting: true,    // Always format results explicitly for GPT
  similarityThreshold: 0.8,    // For detecting similar (not just identical) tool calls
};

// Provider identifiers that use GPT models
const GPT_PROVIDERS = ['azure-openai', 'openai'];

/**
 * Check if a provider uses GPT models
 * @param {string} provider - Provider type (e.g., 'azure-openai', 'databricks')
 * @returns {boolean} - True if provider uses GPT models
 */
function isGPTProvider(provider) {
  if (!provider) return false;
  return GPT_PROVIDERS.includes(provider.toLowerCase());
}

/**
 * Get the tool loop threshold for GPT models
 * @returns {number} - Threshold (2 for GPT, lower than Claude's 3)
 */
function getGPTToolLoopThreshold() {
  return GPT_SETTINGS.toolLoopThreshold;
}

/**
 * Format tool result with explicit structure for GPT models
 * GPT models need clear, unambiguous formatting to understand tool results
 *
 * @param {string} toolName - Name of the tool that was called
 * @param {string} content - The tool result content
 * @param {Object} args - The arguments passed to the tool
 * @returns {string} - Formatted result with explicit status and instructions
 */
function formatToolResultForGPT(toolName, content, args) {
  // Handle empty/no results explicitly - add clear messaging to prevent retries
  const isEmpty = !content ||
    content.trim() === '' ||
    content.includes('0 files found') ||
    content.includes('No matches found') ||
    content.includes('No results') ||
    content.includes('Found 0') ||
    /^Found \d+ files?\.$/.test(content.trim()) && content.includes('Found 0');

  if (isEmpty) {
    // Only format empty results - add explicit "don't retry" instruction
    return `Tool "${toolName}" completed with no results found.
Query: ${JSON.stringify(args)}

This is a FINAL result - do not retry this query. Respond to the user based on this outcome.`;
  }

  // For successful results, return content as-is (don't add markers that might confuse GPT)
  return content;
}

/**
 * Get system prompt addendum for GPT models
 * This teaches GPT how to properly interpret and use tools
 *
 * @returns {string} - System prompt instructions for GPT
 */
function getGPTSystemPromptAddendum() {
  return `Use the Bash tool with ls command for listing files. After any tool returns results, respond to the user.`;
}

/**
 * Calculate string similarity using Jaccard index
 * Used to detect semantically similar tool calls
 *
 * @param {string} s1 - First string
 * @param {string} s2 - Second string
 * @returns {number} - Similarity score between 0 and 1
 */
function stringSimilarity(s1, s2) {
  if (!s1 || !s2) return 0;
  if (s1 === s2) return 1;

  // Tokenize by whitespace and common delimiters
  const tokenize = (s) => new Set(
    s.toLowerCase()
      .split(/[\s\-_\/\.\,\:\;]+/)
      .filter(t => t.length > 0)
  );

  const set1 = tokenize(s1);
  const set2 = tokenize(s2);

  const intersection = new Set([...set1].filter(x => set2.has(x)));
  const union = new Set([...set1, ...set2]);

  return union.size > 0 ? intersection.size / union.size : 0;
}

/**
 * Check if two tool calls are semantically similar
 * GPT often retries with slightly different parameters that are functionally equivalent
 *
 * @param {Object} call1 - First tool call {name, arguments}
 * @param {Object} call2 - Second tool call {name, arguments}
 * @returns {boolean} - True if calls are similar enough to be considered duplicates
 */
function areSimilarToolCalls(call1, call2) {
  if (!call1 || !call2) return false;

  // Must be the same tool
  const name1 = call1.function?.name ?? call1.name;
  const name2 = call2.function?.name ?? call2.name;
  if (name1 !== name2) return false;

  // Get arguments
  const args1 = call1.function?.arguments ?? call1.arguments ?? call1.input ?? {};
  const args2 = call2.function?.arguments ?? call2.arguments ?? call2.input ?? {};

  // Stringify for comparison
  const argsStr1 = typeof args1 === 'string' ? args1 : JSON.stringify(args1);
  const argsStr2 = typeof args2 === 'string' ? args2 : JSON.stringify(args2);

  // Exact match
  if (argsStr1 === argsStr2) return true;

  // For search-related tools, check semantic similarity
  const searchTools = ['grep', 'glob', 'search', 'find', 'read', 'bash', 'shell'];
  const toolName = (name1 || '').toLowerCase();
  const isSearchTool = searchTools.some(t => toolName.includes(t));

  if (isSearchTool) {
    const similarity = stringSimilarity(argsStr1, argsStr2);
    if (similarity >= GPT_SETTINGS.similarityThreshold) {
      logger.debug({
        tool: name1,
        similarity,
        threshold: GPT_SETTINGS.similarityThreshold,
        args1: argsStr1.substring(0, 100),
        args2: argsStr2.substring(0, 100),
      }, "GPT similar tool call detected");
      return true;
    }
  }

  return false;
}

/**
 * Get a signature for a tool call (for tracking in history)
 * @param {Object} call - Tool call object
 * @returns {string} - Unique signature for the call
 */
function getToolCallSignature(call) {
  const name = call.function?.name ?? call.name ?? 'unknown';
  const args = call.function?.arguments ?? call.arguments ?? call.input ?? {};
  const argsStr = typeof args === 'string' ? args : JSON.stringify(args);
  return `${name}:${argsStr}`;
}

module.exports = {
  GPT_SETTINGS,
  isGPTProvider,
  getGPTToolLoopThreshold,
  formatToolResultForGPT,
  getGPTSystemPromptAddendum,
  stringSimilarity,
  areSimilarToolCalls,
  getToolCallSignature,
};
