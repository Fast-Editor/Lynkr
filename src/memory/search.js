const db = require("../db");
const logger = require("../logger");
const store = require("./store");

/**
 * Search memories using FTS5 full-text search
 */
function searchMemories(options) {
  const {
    query,
    limit = 10,
    types = null,      // Filter by memory types
    categories = null, // Filter by categories
    sessionId = null,  // Filter by session
    minImportance = null,
  } = options;

  if (!query || typeof query !== "string") {
    logger.warn("Search query must be a non-empty string");
    return [];
  }

  // Build FTS5 query - escape special characters
  const ftsQuery = prepareFTS5Query(query);

  // Build SQL with filters
  let sql = `
    SELECT m.id, m.session_id, m.content, m.type, m.category,
           m.importance, m.surprise_score, m.access_count, m.decay_factor,
           m.source_turn_id, m.created_at, m.updated_at, m.last_accessed_at, m.metadata,
           fts.rank
    FROM memories_fts fts
    JOIN memories m ON m.id = fts.rowid
    WHERE memories_fts MATCH ?
  `;

  const params = [ftsQuery];

  // Add filters
  if (sessionId) {
    sql += ` AND (m.session_id = ? OR m.session_id IS NULL)`;
    params.push(sessionId);
  }

  if (types && Array.isArray(types) && types.length > 0) {
    const placeholders = types.map(() => "?").join(",");
    sql += ` AND m.type IN (${placeholders})`;
    params.push(...types);
  }

  if (categories && Array.isArray(categories) && categories.length > 0) {
    const placeholders = categories.map(() => "?").join(",");
    sql += ` AND m.category IN (${placeholders})`;
    params.push(...categories);
  }

  if (minImportance !== null && typeof minImportance === "number") {
    sql += ` AND m.importance >= ?`;
    params.push(minImportance);
  }

  // Order by FTS5 rank and importance
  sql += ` ORDER BY fts.rank, m.importance DESC LIMIT ?`;
  params.push(limit);

  try {
    const stmt = db.prepare(sql);
    const rows = stmt.all(...params);

    return rows.map((row) => ({
      id: row.id,
      sessionId: row.session_id ?? null,
      content: row.content,
      type: row.type,
      category: row.category ?? null,
      importance: row.importance ?? 0.5,
      surpriseScore: row.surprise_score ?? 0.0,
      accessCount: row.access_count ?? 0,
      decayFactor: row.decay_factor ?? 1.0,
      sourceTurnId: row.source_turn_id ?? null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastAccessedAt: row.last_accessed_at ?? null,
      metadata: row.metadata ? JSON.parse(row.metadata) : {},
      rank: row.rank, // FTS5 relevance score
    }));
  } catch (err) {
    logger.error({ err, query: ftsQuery }, "FTS5 search failed");
    return [];
  }
}

/**
 * Prepare FTS5 query - handle special characters and phrases
 */
function prepareFTS5Query(query) {
  // Remove or escape FTS5 special characters: " * ( ) AND OR NOT
  // For simple queries, just escape quotes and use phrase matching
  let cleaned = query.trim();

  // Check if query contains FTS5 operators (AND, OR, NOT)
  const hasFTS5Operators = /\b(AND|OR|NOT)\b/i.test(cleaned);

  // If query looks like a phrase (multi-word but no operators), wrap in quotes for exact matching
  if (!cleaned.includes('"') && cleaned.split(/\s+/).length > 1 && !hasFTS5Operators) {
    // Multi-word query without operators - use phrase search
    cleaned = `"${cleaned.replace(/"/g, '""')}"`;
  } else if (!hasFTS5Operators) {
    // Single word or already has quotes - just escape
    cleaned = cleaned.replace(/"/g, '""');
  }
  // If it has FTS5 operators, leave as-is to let FTS5 parse them

  return cleaned;
}

/**
 * Search with keyword expansion (extract key terms)
 */
function searchWithExpansion(options) {
  const { query, limit = 10 } = options;

  // Extract keywords from query
  const keywords = extractKeywords(query);

  // Search with original query
  const results = searchMemories({ ...options, limit: limit * 2 });

  // If not enough results, try individual keywords
  if (results.length < limit && keywords.length > 1) {
    const seen = new Set(results.map((r) => r.id));

    for (const keyword of keywords) {
      if (results.length >= limit) break;

      const kwResults = searchMemories({
        ...options,
        query: keyword,
        limit: limit - results.length,
      });

      for (const result of kwResults) {
        if (!seen.has(result.id)) {
          results.push(result);
          seen.add(result.id);
        }
      }
    }
  }

  return results.slice(0, limit);
}

/**
 * Extract keywords from text (simple tokenization)
 */
function extractKeywords(text) {
  if (!text) return [];

  // Simple keyword extraction:
  // - Split on whitespace
  // - Remove stopwords
  // - Keep words > 3 characters
  // - Lowercase

  const stopwords = new Set([
    "the",
    "is",
    "at",
    "which",
    "on",
    "and",
    "or",
    "not",
    "this",
    "that",
    "with",
    "from",
    "for",
    "to",
    "in",
    "of",
    "a",
    "an",
  ]);

  return text
    .toLowerCase()
    .split(/\s+/)
    .map((word) => word.replace(/[^\w]/g, ""))
    .filter((word) => word.length > 3 && !stopwords.has(word));
}

/**
 * Find similar memories by keyword overlap
 */
function findSimilar(memoryId, limit = 5) {
  const memory = store.getMemory(memoryId);
  if (!memory) {
    throw new Error(`Memory with id ${memoryId} not found`);
  }

  const keywords = extractKeywords(memory.content);
  if (keywords.length === 0) return [];

  // Build OR query for keywords
  const query = keywords.join(" OR ");

  const results = searchMemories({
    query,
    limit: limit + 1, // +1 to exclude self
  });

  // Filter out the original memory
  return results.filter((r) => r.id !== memoryId).slice(0, limit);
}

/**
 * Search by content similarity (simple keyword-based)
 */
function searchByContent(content, options = {}) {
  const keywords = extractKeywords(content);
  if (keywords.length === 0) return [];

  const query = keywords.slice(0, 5).join(" OR "); // Top 5 keywords
  return searchMemories({ ...options, query });
}

/**
 * Count search results without fetching them
 */
function countSearchResults(options) {
  const results = searchMemories({ ...options, limit: 1000 });
  return results.length;
}

module.exports = {
  searchMemories,
  searchWithExpansion,
  extractKeywords,
  findSimilar,
  searchByContent,
  countSearchResults,
  prepareFTS5Query,
};
