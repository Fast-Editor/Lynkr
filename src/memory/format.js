const logger = require("../logger");
const config = require("../config");

/**
 * Format memories for injection into context
 */
function formatMemoriesForContext(memories, format = 'compact') {
  if (!memories || memories.length === 0) {
    return '';
  }

  // Get format from config if not specified
  format = format || config.memory?.format || 'compact';

  if (format === 'verbose' || format === 'xml') {
    return formatVerbose(memories);
  }

  // Compact format (default)
  return formatCompact(memories);
}

/**
 * Compact memory format - 75% fewer tokens
 */
function formatCompact(memories) {
  const items = memories
    .map(mem => `- ${mem.content}`)
    .join('\n');

  return `# Context\n${items}`;
}

/**
 * Verbose XML format (original)
 */
function formatVerbose(memories) {
  const items = memories.map((mem, idx) => {
    const age = formatAge(mem.createdAt);
    const type = mem.type ? `[${mem.type}] ` : '';
    return `${idx + 1}. ${type}${mem.content} (${age})`;
  }).join('\n');

  return `<long_term_memory>
The following are relevant facts from previous conversations:
${items}
</long_term_memory>`;
}

/**
 * Format age in human-readable form
 */
function formatAge(timestamp) {
  const ageMs = Date.now() - timestamp;
  const days = Math.floor(ageMs / (24 * 60 * 60 * 1000));
  const hours = Math.floor(ageMs / (60 * 60 * 1000));

  if (days > 0) return `${days}d ago`;
  if (hours > 0) return `${hours}h ago`;
  return 'recent';
}

/**
 * Deduplicate memories that are already in recent conversation
 */
function filterRedundantMemories(memories, recentMessages) {
  if (!memories || memories.length === 0) {
    return [];
  }

  if (!recentMessages || recentMessages.length === 0) {
    return memories;
  }

  // Get last N messages content (configurable)
  const lookbackCount = config.memory?.dedupLookback || 5;
  const recentContent = recentMessages
    .slice(-lookbackCount)
    .map(m => extractMessageContent(m))
    .join(' ')
    .toLowerCase();

  // Filter out memories that appear in recent context
  const filtered = memories.filter(mem => {
    const memSnippet = mem.content.toLowerCase().slice(0, 50);
    return !recentContent.includes(memSnippet);
  });

  const dedupedCount = memories.length - filtered.length;
  if (dedupedCount > 0) {
    logger.debug({
      original: memories.length,
      filtered: filtered.length,
      deduped: dedupedCount
    }, 'Deduplicated redundant memories from recent conversation');
  }

  return filtered;
}

/**
 * Extract text content from a message
 */
function extractMessageContent(message) {
  if (!message || !message.content) return '';

  if (typeof message.content === 'string') {
    return message.content;
  }

  if (Array.isArray(message.content)) {
    return message.content
      .filter(block => block.type === 'text')
      .map(block => block.text || '')
      .join(' ');
  }

  return '';
}

/**
 * Calculate token savings from compact format
 */
function calculateFormatSavings(memories, originalFormat = 'verbose', newFormat = 'compact') {
  if (!memories || memories.length === 0) {
    return { original: 0, optimized: 0, saved: 0, percentage: 0 };
  }

  const originalTokens = estimateTokens(formatMemoriesForContext(memories, originalFormat));
  const optimizedTokens = estimateTokens(formatMemoriesForContext(memories, newFormat));
  const saved = originalTokens - optimizedTokens;
  const percentage = originalTokens > 0 ? ((saved / originalTokens) * 100).toFixed(1) : 0;

  return {
    original: originalTokens,
    optimized: optimizedTokens,
    saved,
    percentage: parseFloat(percentage)
  };
}

/**
 * Rough token estimate (4 chars ≈ 1 token)
 */
function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

module.exports = {
  formatMemoriesForContext,
  filterRedundantMemories,
  formatCompact,
  formatVerbose,
  calculateFormatSavings
};
