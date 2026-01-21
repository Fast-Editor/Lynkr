const db = require("../db");
const logger = require("../logger");
const store = require("./store");

// ============================================================================
// CONFIGURATION
// ============================================================================

const MAX_QUERY_LENGTH = 1000;
const MAX_OR_TERMS = 50;

// ============================================================================
// KEYWORD SANITIZATION (NEW - Critical for FTS5 Safety)
// ============================================================================

/**
 * Sanitize a single keyword for use in FTS5 queries
 * Removes all FTS5 special characters that can cause syntax errors
 * 
 * CRITICAL: FTS5 has many special characters that cause errors:
 * - Dash (-) is interpreted as column filter
 * - @ is invalid bareword character
 * - Parentheses, brackets, quotes can break query syntax
 * - Commas and periods can cause issues in newer SQLite versions
 */
function sanitizeKeyword(keyword) {
  if (!keyword || typeof keyword !== 'string') {
    return '';
  }
  
  // Remove ALL FTS5 special characters
  const sanitized = keyword
    .replace(/[*()<>\-:\[\]{}|^~,.;!?'"@#$%&+=/\\\\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  
  return sanitized;
}

/**
 * Sanitize array of keywords
 * Returns only keywords that are 3+ characters after sanitization
 */
function sanitizeKeywords(keywords) {
  if (!Array.isArray(keywords)) {
    return [];
  }
  
  return keywords
    .map(sanitizeKeyword)
    .filter(k => k.length >= 3);
}

// ============================================================================
// FTS5 QUERY PREPARATION (UPDATED - Hardened)
// ============================================================================

/**
 * Prepare FTS5 query - handle special characters and phrases
 * 
 * CRITICAL FIX for better-sqlite3 v12+ (SQLite 3.46+):
 * - Commas and periods inside quoted strings cause "fts5: syntax error near ,"
 * - Solution: Extract keywords and search for them individually with OR
 * - This is more robust than attempting to quote complex phrases
 */
function prepareFTS5Query(query) {
  let cleaned = query.trim();

  // Length validation
  if (cleaned.length > MAX_QUERY_LENGTH) {
    logger.warn({ 
      queryLength: cleaned.length, 
      truncatedTo: MAX_QUERY_LENGTH 
    }, 'Query truncated due to excessive length');
    cleaned = cleaned.substring(0, MAX_QUERY_LENGTH);
  }

  if (!cleaned) {
    return '"empty query"'; // Safe fallback
  }

  // Step 1: Remove XML/HTML tags (common in error messages and code)
  cleaned = cleaned.replace(/<[^>]+>/g, ' ');
  cleaned = cleaned.replace(/\s+/g, ' ').trim();

  if (!cleaned) {
    return '"empty query"';
  }

  // Step 2: Check for FTS5 operators (AND, OR, NOT)
  // If present, user is doing advanced search - preserve operators
  const hasFTS5Operators = /\b(AND|OR|NOT)\b/.test(cleaned);

  // Step 3: Remove ALL FTS5 special characters and punctuation
  // CRITICAL: These can cause syntax errors even in quoted strings:
  // - Commas (,) and periods (.) → "syntax error near ,"
  // - Dashes (-) → interpreted as column filter
  // - @ symbol → "syntax error near @"
  // - Quotes (") → can break string quoting
  // - Parentheses, brackets → break grouping syntax
  cleaned = cleaned.replace(/[*()<>\-:\[\]{}|^~,.;!?'"@#$%&+=/\\\\]/g, ' ');
  cleaned = cleaned.replace(/\s+/g, ' ').trim();

  if (!cleaned) {
    return '"empty query"';
  }

  // Step 4: If has operators, return as-is for advanced search
  if (hasFTS5Operators) {
    // Advanced users can use AND/OR/NOT
    // Characters are already sanitized above
    return cleaned;
  }

  // Step 5: Extract keywords (min 3 chars, max 50 words to prevent DoS)
  const words = cleaned
    .split(/\s+/)
    .filter(w => w.length >= 3)
    .slice(0, MAX_OR_TERMS);
  
  if (words.length === 0) {
    // No valid keywords - try with shorter words
    const anyWords = cleaned
      .split(/\s+/)
      .filter(w => w.length > 0)
      .slice(0, 10);
    
    if (anyWords.length === 0) {
      return '"empty query"';
    }
    
    // Quote each word individually
    return anyWords.map(w => `"${w}"`).join(' OR ');
  }

  // Step 6: Single word - simple quote
  if (words.length === 1) {
    return `"${words[0]}"`;
  }

  // Step 7: Multiple words - create OR query of individual quoted words
  // This is the safest approach that avoids all FTS5 syntax errors
  // Example: "word1" OR "word2" OR "word3"
  return words.map(word => `"${word}"`).join(' OR ');
}

// ============================================================================
// SEARCH FUNCTIONS (UPDATED)
// ============================================================================

/**
 * Search memories using FTS5 full-text search
 */
function searchMemories(options) {
  const {
    query,
    limit = 10,
    types = null,
    categories = null,
    sessionId = null,
    minImportance = null,
  } = options;

  if (!query || typeof query !== "string") {
    logger.warn("Search query must be a non-empty string");
    return [];
  }

  try {
    // Build FTS5 query - now hardened against syntax errors
    const ftsQuery = prepareFTS5Query(query);
    
    logger.debug({ 
      originalQuery: query.substring(0, 100), 
      ftsQuery: ftsQuery.substring(0, 100) 
    }, 'FTS5 query prepared');

    // Build SQL with filters
    let sql = `
      SELECT m.id, m.session_id, m.content, m.type, m.category,
             m.importance, m.surprise_score, m.access_count, m.decay_factor,
             m.source_turn_id, m.created_at, m.updated_at, m.last_accessed_at, m.metadata,
             memories_fts.rank
      FROM memories_fts
      JOIN memories m ON m.id = memories_fts.rowid
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
    sql += ` ORDER BY memories_fts.rank, m.importance DESC LIMIT ?`;
    params.push(limit);

    const startTime = Date.now();
    const stmt = db.prepare(sql);
    const rows = stmt.all(...params);
    const duration = Date.now() - startTime;

    // Log slow queries for monitoring
    if (duration > 100) {
      logger.warn({
        query: query.substring(0, 50),
        ftsQuery: ftsQuery.substring(0, 50),
        duration,
        resultCount: rows.length
      }, 'Slow FTS5 query detected');
    }

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
      rank: row.rank,
    }));
  } catch (err) {
    logger.error({ 
      err, 
      query: query.substring(0, 100),
      sqliteCode: err.code,
      message: err.message 
    }, "FTS5 search failed");
    return [];
  }
}

/**
 * Search with keyword expansion (UPDATED - now uses sanitized keywords)
 */
function searchWithExpansion(options) {
  const { query, limit = 10 } = options;

  // Extract keywords from query
  const keywords = extractKeywords(query);
  const sanitizedKeywords = sanitizeKeywords(keywords);  // ✅ ADDED

  // Search with original query (already sanitized by prepareFTS5Query)
  const results = searchMemories({ ...options, limit: limit * 2 });

  // If not enough results, try individual keywords
  if (results.length < limit && sanitizedKeywords.length > 1) {
    const seen = new Set(results.map((r) => r.id));

    for (const keyword of sanitizedKeywords) {  // ✅ CHANGED - use sanitized
      if (results.length >= limit) break;

      const kwResults = searchMemories({
        ...options,
        query: keyword,  // Now guaranteed safe
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

  const stopwords = new Set([
    "the", "is", "at", "which", "on", "and", "or", "not", "this", "that",
    "with", "from", "for", "to", "in", "of", "a", "an",
  ]);

  return text
    .toLowerCase()
    .split(/\s+/)
    .map((word) => word.replace(/[^\w]/g, ""))
    .filter((word) => word.length > 3 && !stopwords.has(word));
}

/**
 * Find similar memories by keyword overlap (UPDATED - sanitized)
 */
function findSimilar(memoryId, limit = 5) {
  const memory = store.getMemory(memoryId);
  if (!memory) {
    throw new Error(`Memory with id ${memoryId} not found`);
  }

  const keywords = extractKeywords(memory.content);
  const sanitizedKeywords = sanitizeKeywords(keywords);  // ✅ ADDED
  
  if (sanitizedKeywords.length === 0) return [];

  // Build OR query with SANITIZED keywords
  const query = sanitizedKeywords.join(" OR ");  // ✅ CHANGED - use sanitized

  const results = searchMemories({
    query,
    limit: limit + 1,
  });

  return results.filter((r) => r.id !== memoryId).slice(0, limit);
}

/**
 * Search by content similarity (UPDATED - sanitized)
 */
function searchByContent(content, options = {}) {
  const keywords = extractKeywords(content);
  const sanitizedKeywords = sanitizeKeywords(keywords);  // ✅ ADDED
  
  if (sanitizedKeywords.length === 0) return [];

  const query = sanitizedKeywords.slice(0, 5).join(" OR ");  // ✅ CHANGED
  return searchMemories({ ...options, query });
}

/**
 * Count search results without fetching them
 */
function countSearchResults(options) {
  const results = searchMemories({ ...options, limit: 1000 });
  return results.length;
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  searchMemories,
  searchWithExpansion,
  extractKeywords,
  findSimilar,
  searchByContent,
  countSearchResults,
  prepareFTS5Query,
  sanitizeKeyword,      // ✅ NEW - exported for testing
  sanitizeKeywords,     // ✅ NEW - exported for testing
};