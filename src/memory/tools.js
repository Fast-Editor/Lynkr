const store = require("./store");
const search = require("./search");
const retriever = require("./retriever");
const logger = require("../logger");

// ============================================================================
// VALIDATION CONSTANTS
// ============================================================================

const VALID_TYPES = ['fact', 'preference', 'decision', 'entity', 'relationship'];
const VALID_CATEGORIES = ['code', 'user', 'project', 'general'];
const MAX_QUERY_LENGTH = 1000;
const MAX_CONTENT_LENGTH = 5000;

// ============================================================================
// MEMORY TOOLS (UPDATED WITH VALIDATION)
// ============================================================================

/**
 * Tool: memory_search
 * Search long-term memories for relevant facts
 * 
 * UPDATED: Added input validation to prevent FTS5 errors and injection
 */
async function memory_search(args, context = {}) {
  const { query, limit = 10, type, category } = args;

  // ✅ Validate query exists and is string
  if (!query || typeof query !== 'string') {
    return {
      ok: false,
      content: JSON.stringify({ 
        error: 'Query parameter is required and must be a string' 
      }),
    };
  }

  // ✅ Validate query length
  if (query.length > MAX_QUERY_LENGTH) {
    return {
      ok: false,
      content: JSON.stringify({ 
        error: `Query too long (max ${MAX_QUERY_LENGTH} characters)`,
        provided: query.length
      }),
    };
  }

  // ✅ Validate type if provided
  if (type && !VALID_TYPES.includes(type)) {
    return {
      ok: false,
      content: JSON.stringify({ 
        error: `Invalid type. Must be one of: ${VALID_TYPES.join(', ')}`,
        provided: type
      }),
    };
  }

  // ✅ Validate category if provided
  if (category && !VALID_CATEGORIES.includes(category)) {
    return {
      ok: false,
      content: JSON.stringify({ 
        error: `Invalid category. Must be one of: ${VALID_CATEGORIES.join(', ')}`,
        provided: category
      }),
    };
  }

  // ✅ Validate limit
  if (typeof limit !== 'number' || limit < 1 || limit > 100) {
    return {
      ok: false,
      content: JSON.stringify({ 
        error: 'Limit must be a number between 1 and 100',
        provided: limit
      }),
    };
  }

  try {
    const results = search.searchMemories({
      query,  // Will be sanitized by prepareFTS5Query in search.js
      limit,
      types: type ? [type] : undefined,
      categories: category ? [category] : undefined,
      sessionId: context.session?.id,
    });

    const formatted = results.map((mem, idx) => ({
      index: idx + 1,
      type: mem.type,
      content: mem.content,
      importance: mem.importance,
      age: retriever.formatAge(Date.now() - mem.createdAt),
      category: mem.category,
    }));

    return {
      ok: true,
      content: JSON.stringify({
        query,
        resultCount: results.length,
        memories: formatted,
      }, null, 2),
      metadata: { resultCount: results.length },
    };
  } catch (err) {
    logger.error({ err, query: query.substring(0, 100) }, 'Memory search failed');
    return {
      ok: false,
      content: JSON.stringify({ 
        error: 'Memory search failed', 
        message: err.message 
      }),
    };
  }
}

/**
 * Tool: memory_add
 * Manually add a fact to long-term memory
 * 
 * UPDATED: Enhanced validation
 */
async function memory_add(args, context = {}) {
  const {
    content,
    type = 'fact',
    category = 'general',
    importance = 0.5,
  } = args;

  // ✅ Validate content
  if (!content || typeof content !== 'string') {
    return {
      ok: false,
      content: JSON.stringify({ 
        error: 'Content parameter is required and must be a string' 
      }),
    };
  }

  // ✅ Validate content length
  if (content.length > MAX_CONTENT_LENGTH) {
    return {
      ok: false,
      content: JSON.stringify({ 
        error: `Content too long (max ${MAX_CONTENT_LENGTH} characters)`,
        provided: content.length
      }),
    };
  }

  if (content.length < 10) {
    return {
      ok: false,
      content: JSON.stringify({ 
        error: 'Content too short (min 10 characters)',
        provided: content.length
      }),
    };
  }

  // ✅ Validate type
  if (!VALID_TYPES.includes(type)) {
    return {
      ok: false,
      content: JSON.stringify({
        error: `Invalid type. Must be one of: ${VALID_TYPES.join(', ')}`,
        provided: type
      }),
    };
  }

  // ✅ Validate category
  if (!VALID_CATEGORIES.includes(category)) {
    return {
      ok: false,
      content: JSON.stringify({
        error: `Invalid category. Must be one of: ${VALID_CATEGORIES.join(', ')}`,
        provided: category
      }),
    };
  }

  // ✅ Validate importance
  if (typeof importance !== 'number' || importance < 0 || importance > 1) {
    return {
      ok: false,
      content: JSON.stringify({ 
        error: 'Importance must be a number between 0 and 1',
        provided: importance
      }),
    };
  }

  try {
    const memory = store.createMemory({
      content,
      type,
      category,
      sessionId: context.session?.id,
      importance,
      surpriseScore: 0.5, // Manual additions get moderate surprise
      metadata: {
        manual: true,
        addedBy: 'user',
        timestamp: Date.now(),
      },
    });

    return {
      ok: true,
      content: JSON.stringify({
        message: 'Memory stored successfully',
        memoryId: memory.id,
        memory: {
          id: memory.id,
          type: memory.type,
          content: memory.content,
          importance: memory.importance,
          category: memory.category,
        },
      }, null, 2),
      metadata: { memoryId: memory.id },
    };
  } catch (err) {
    logger.error({ err, content: content.substring(0, 100) }, 'Memory add failed');
    return {
      ok: false,
      content: JSON.stringify({ 
        error: 'Failed to add memory', 
        message: err.message 
      }),
    };
  }
}

/**
 * Tool: memory_forget
 * Remove memories matching a query
 * 
 * UPDATED: Enhanced validation
 */
async function memory_forget(args, context = {}) {
  const { query, confirm = false } = args;

  // ✅ Validate query
  if (!query || typeof query !== 'string') {
    return {
      ok: false,
      content: JSON.stringify({ 
        error: 'Query parameter is required and must be a string' 
      }),
    };
  }

  // ✅ Validate query length
  if (query.length > MAX_QUERY_LENGTH) {
    return {
      ok: false,
      content: JSON.stringify({ 
        error: `Query too long (max ${MAX_QUERY_LENGTH} characters)`,
        provided: query.length
      }),
    };
  }

  // ✅ Validate confirm is boolean
  if (typeof confirm !== 'boolean') {
    return {
      ok: false,
      content: JSON.stringify({ 
        error: 'Confirm parameter must be a boolean',
        provided: typeof confirm
      }),
    };
  }

  try {
    // Search for matching memories
    const matches = search.searchMemories({
      query,
      limit: 50, // Check up to 50 matches
      sessionId: context.session?.id,
    });

    if (matches.length === 0) {
      return {
        ok: true,
        content: JSON.stringify({
          message: 'No memories found matching the query',
          query,
        }),
      };
    }

    if (!confirm) {
      const preview = matches.slice(0, 5).map((mem, idx) => ({
        index: idx + 1,
        type: mem.type,
        content: mem.content.substring(0, 100) + (mem.content.length > 100 ? '...' : ''),
        age: retriever.formatAge(Date.now() - mem.createdAt),
      }));

      return {
        ok: false,
        content: JSON.stringify({
          message: 'Found memories matching query. Set confirm=true to delete them.',
          query,
          matchCount: matches.length,
          preview,
          warning: 'This action cannot be undone',
        }, null, 2),
        metadata: { requiresConfirmation: true, matchCount: matches.length },
      };
    }

    // Delete all matching memories
    let deletedCount = 0;
    for (const memory of matches) {
      const deleted = store.deleteMemory(memory.id);
      if (deleted) deletedCount++;
    }

    return {
      ok: true,
      content: JSON.stringify({
        message: `Deleted ${deletedCount} memories`,
        query,
        deletedCount,
      }, null, 2),
      metadata: { deletedCount },
    };
  } catch (err) {
    logger.error({ err, query: query.substring(0, 100) }, 'Memory forget failed');
    return {
      ok: false,
      content: JSON.stringify({ 
        error: 'Failed to delete memories', 
        message: err.message 
      }),
    };
  }
}

/**
 * Tool: memory_stats
 * Get statistics about stored memories
 */
async function memory_stats(args, context = {}) {
  try {
    const stats = retriever.getMemoryStats({ sessionId: context.session?.id });

    if (!stats) {
      return {
        ok: false,
        content: JSON.stringify({ error: 'Failed to retrieve memory statistics' }),
      };
    }

    return {
      ok: true,
      content: JSON.stringify({
        total: stats.total,
        byType: stats.byType,
        byCategory: stats.byCategory,
        avgImportance: stats.avgImportance?.toFixed(2),
        recentCount: stats.recentCount,
        importantCount: stats.importantCount,
        sessionId: stats.sessionId || 'global',
      }, null, 2),
    };
  } catch (err) {
    logger.error({ err }, 'Memory stats failed');
    return {
      ok: false,
      content: JSON.stringify({ 
        error: 'Failed to get statistics', 
        message: err.message 
      }),
    };
  }
}

// ============================================================================
// TOOL DEFINITIONS (UPDATED)
// ============================================================================

const MEMORY_TOOLS = {
  memory_search: {
    name: 'memory_search',
    description: 'Search long-term memories for relevant facts and information from previous conversations',
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query to find relevant memories (max 1000 characters)',
        },
        limit: {
          type: 'integer',
          description: 'Maximum number of results to return (default: 10, max: 100)',
          minimum: 1,
          maximum: 100,
        },
        type: {
          type: 'string',
          description: 'Filter by memory type',
          enum: VALID_TYPES,
        },
        category: {
          type: 'string',
          description: 'Filter by category',
          enum: VALID_CATEGORIES,
        },
      },
      required: ['query'],
    },
    handler: memory_search,
  },

  memory_add: {
    name: 'memory_add',
    description: 'Manually add a fact or piece of information to long-term memory',
    input_schema: {
      type: 'object',
      properties: {
        content: {
          type: 'string',
          description: 'The fact or information to remember (10-5000 characters)',
        },
        type: {
          type: 'string',
          description: 'Type of memory',
          enum: VALID_TYPES,
        },
        category: {
          type: 'string',
          description: 'Category',
          enum: VALID_CATEGORIES,
        },
        importance: {
          type: 'number',
          description: 'Importance score between 0 and 1 (default: 0.5)',
          minimum: 0,
          maximum: 1,
        },
      },
      required: ['content'],
    },
    handler: memory_add,
  },

  memory_forget: {
    name: 'memory_forget',
    description: 'Remove memories matching a search query',
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Query to match memories to delete (max 1000 characters)',
        },
        confirm: {
          type: 'boolean',
          description: 'Set to true to confirm deletion (required for safety)',
        },
      },
      required: ['query'],
    },
    handler: memory_forget,
  },

  memory_stats: {
    name: 'memory_stats',
    description: 'Get statistics about stored memories',
    input_schema: {
      type: 'object',
      properties: {},
    },
    handler: memory_stats,
  },
};

module.exports = {
  memory_search,
  memory_add,
  memory_forget,
  memory_stats,
  MEMORY_TOOLS,
};