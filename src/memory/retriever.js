const store = require("./store");
const search = require("./search");
const logger = require("../logger");
const format = require("./format");

/**
 * Retrieve relevant memories using multi-signal ranking
 *
 * Scoring algorithm:
 * - 30% Recency: Exponential decay based on last access
 * - 40% Importance: Stored importance value
 * - 30% Relevance: Keyword overlap with query
 */
function retrieveRelevantMemories(query, options = {}) {
  const {
    limit = 10,
    sessionId = null,
    includeGlobal = true,
    recencyWeight = 0.3,
    importanceWeight = 0.4,
    relevanceWeight = 0.3,
  } = options;

  try {
    // 1. FTS5 search for keyword relevance
    const ftsResults = search.searchMemories({
      query,
      limit: limit * 3, // Get more candidates
      sessionId: includeGlobal ? null : sessionId,
    });

    // 2. Get recent memories (recency bias)
    const recentMemories = store.getRecentMemories({
      limit: limit * 2,
      sessionId: includeGlobal ? null : sessionId,
    });

    // 3. Get high-importance memories
    const importantMemories = store.getMemoriesByImportance({
      limit: limit * 2,
      sessionId: includeGlobal ? null : sessionId,
    });

    // 4. Merge and deduplicate
    const candidates = mergeUnique([ftsResults, recentMemories, importantMemories]);

    // 5. Score and rank
    const scored = candidates.map(memory => ({
      memory,
      score: calculateRetrievalScore(memory, query, {
        recencyWeight,
        importanceWeight,
        relevanceWeight,
      }),
    }));

    // 6. Sort by score and return top K
    const topMemories = scored
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(s => s.memory);

    // 7. Update access counts asynchronously
    setImmediate(() => {
      for (const memory of topMemories) {
        try {
          store.incrementAccessCount(memory.id);
        } catch (err) {
          logger.warn({ err, memoryId: memory.id }, 'Failed to increment access count');
        }
      }
    });

    return topMemories;
  } catch (err) {
    logger.error({ err, query }, 'Memory retrieval failed');
    return [];
  }
}

/**
 * Calculate retrieval score for a memory
 */
function calculateRetrievalScore(memory, query, weights) {
  // Recency score: exponential decay based on last access
  const ageMs = Date.now() - (memory.lastAccessedAt || memory.createdAt);
  const halfLifeMs = 7 * 24 * 60 * 60 * 1000; // 7 days
  const recencyScore = Math.exp(-ageMs / halfLifeMs);

  // Importance score: direct from stored value
  const importanceScore = memory.importance ?? 0.5;

  // Relevance score: keyword overlap with query
  const relevanceScore = calculateKeywordOverlap(memory.content, query);

  // Weighted combination
  return (
    weights.recencyWeight * recencyScore +
    weights.importanceWeight * importanceScore +
    weights.relevanceWeight * relevanceScore
  );
}

/**
 * Calculate keyword overlap between content and query
 */
function calculateKeywordOverlap(content, query) {
  const contentKeywords = new Set(search.extractKeywords(content));
  const queryKeywords = search.extractKeywords(query);

  if (queryKeywords.length === 0 || contentKeywords.size === 0) {
    return 0.0;
  }

  let overlapCount = 0;
  for (const keyword of queryKeywords) {
    if (contentKeywords.has(keyword)) {
      overlapCount++;
    }
  }

  return overlapCount / queryKeywords.length;
}

/**
 * Merge arrays and remove duplicates by memory ID
 */
function mergeUnique(arrays) {
  const seen = new Set();
  const merged = [];

  for (const arr of arrays) {
    for (const item of arr) {
      if (!seen.has(item.id)) {
        seen.add(item.id);
        merged.push(item);
      }
    }
  }

  return merged;
}

/**
 * Extract query from message (handle different formats)
 */
function extractQueryFromMessage(message) {
  if (!message) return '';

  if (typeof message === 'string') return message;

  if (message.content) {
    if (typeof message.content === 'string') return message.content;

    if (Array.isArray(message.content)) {
      return message.content
        .filter(block => block?.type === 'text' || typeof block === 'string')
        .map(block => typeof block === 'string' ? block : block.text)
        .filter(Boolean)
        .join(' ');
    }
  }

  return '';
}

/**
 * Format memories for injection into context
 */
function formatMemoriesForContext(memories) {
  if (!memories || memories.length === 0) return '';

  return memories
    .map((memory, index) => {
      const age = formatAge(Date.now() - memory.createdAt);
      const typeLabel = memory.type || 'memory';
      return `${index + 1}. [${typeLabel}] ${memory.content} (${age})`;
    })
    .join('\n');
}

/**
 * Format age in human-readable form
 */
function formatAge(ageMs) {
  const seconds = Math.floor(ageMs / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  const weeks = Math.floor(days / 7);

  if (weeks > 0) return `${weeks} week${weeks > 1 ? 's' : ''} ago`;
  if (days > 0) return `${days} day${days > 1 ? 's' : ''} ago`;
  if (hours > 0) return `${hours} hour${hours > 1 ? 's' : ''} ago`;
  if (minutes > 0) return `${minutes} minute${minutes > 1 ? 's' : ''} ago`;
  return 'just now';
}

/**
 * Inject memories into system prompt
 */
function injectMemoriesIntoSystem(existingSystem, memories, injectionFormat = 'system', recentMessages = null) {
  if (!memories || memories.length === 0) return existingSystem;

  // Apply deduplication if recent messages provided
  const dedupedMemories = recentMessages
    ? format.filterRedundantMemories(memories, recentMessages)
    : memories;

  if (dedupedMemories.length === 0) {
    logger.debug('All memories filtered out as redundant');
    return existingSystem;
  }

  // Use compact format (or configured format)
  const config = require("../config");
  const formatType = config.memory?.format || 'compact';
  const formattedMemories = format.formatMemoriesForContext(dedupedMemories, formatType);

  // Log token savings
  const savings = format.calculateFormatSavings(dedupedMemories, 'verbose', formatType);
  if (savings.saved > 0) {
    logger.debug({
      memories: dedupedMemories.length,
      tokensSaved: savings.saved,
      percentage: savings.percentage
    }, 'Memory format optimization applied');
  }

  if (injectionFormat === 'system') {
    return existingSystem
      ? `${existingSystem}\n\n${formattedMemories}`
      : formattedMemories;
  }

  if (injectionFormat === 'assistant_preamble') {
    return {
      system: existingSystem,
      memoryPreamble: formattedMemories,
    };
  }

  return existingSystem;
}

/**
 * Get memory statistics
 */
function getMemoryStats(options = {}) {
  try {
    const { sessionId = null } = options;
    const total = store.countMemories({ sessionId });

    const byType = {};
    const byCategory = {};
    const types = ['preference', 'decision', 'fact', 'entity', 'relationship'];
    const categories = ['user', 'code', 'project', 'general'];

    // Count by type
    for (const type of types) {
      const memories = store.getMemoriesByType(type, 10000);
      // Filter by session if needed
      const filtered = sessionId
        ? memories.filter(m => m.sessionId === sessionId || m.sessionId === null)
        : memories;
      byType[type] = filtered.length;
    }

    // Count by category
    const allMemories = store.getRecentMemories({ limit: 10000, sessionId });
    for (const category of categories) {
      byCategory[category] = allMemories.filter(m => m.category === category).length;
    }

    // Calculate average importance
    const avgImportance = allMemories.length > 0
      ? allMemories.reduce((sum, m) => sum + (m.importance || 0), 0) / allMemories.length
      : 0;

    const recent = store.getRecentMemories({ limit: 10, sessionId });
    const important = store.getMemoriesByImportance({ limit: 10, sessionId });

    return {
      total,
      byType,
      byCategory,
      avgImportance,
      recentCount: recent.length,
      importantCount: important.length,
      sessionId,
    };
  } catch (err) {
    logger.error({ err }, 'Failed to get memory stats');
    return null;
  }
}

module.exports = {
  retrieveRelevantMemories,
  calculateRetrievalScore,
  calculateKeywordOverlap,
  extractQueryFromMessage,
  formatMemoriesForContext,
  injectMemoriesIntoSystem,
  formatAge,
  getMemoryStats,
};
