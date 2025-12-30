const db = require("../db");
const logger = require("../logger");

// Prepared statements for memory operations
const insertMemoryStmt = db.prepare(`
  INSERT INTO memories (
    session_id, content, type, category, importance, surprise_score,
    access_count, decay_factor, source_turn_id, created_at, updated_at,
    last_accessed_at, metadata
  ) VALUES (
    @session_id, @content, @type, @category, @importance, @surprise_score,
    @access_count, @decay_factor, @source_turn_id, @created_at, @updated_at,
    @last_accessed_at, @metadata
  )
`);

const getMemoryStmt = db.prepare(`
  SELECT
    id, session_id, content, type, category, importance, surprise_score,
    access_count, decay_factor, source_turn_id, created_at, updated_at,
    last_accessed_at, metadata
  FROM memories
  WHERE id = ?
`);

const updateMemoryStmt = db.prepare(`
  UPDATE memories
  SET content = @content,
      type = @type,
      category = @category,
      importance = @importance,
      surprise_score = @surprise_score,
      decay_factor = @decay_factor,
      updated_at = @updated_at,
      metadata = @metadata
  WHERE id = @id
`);

const deleteMemoryStmt = db.prepare("DELETE FROM memories WHERE id = ?");

const incrementAccessStmt = db.prepare(`
  UPDATE memories
  SET access_count = access_count + 1,
      last_accessed_at = ?
  WHERE id = ?
`);

const updateImportanceStmt = db.prepare(`
  UPDATE memories
  SET importance = ?,
      updated_at = ?
  WHERE id = ?
`);

const getRecentMemoriesStmt = db.prepare(`
  SELECT
    id, session_id, content, type, category, importance, surprise_score,
    access_count, decay_factor, source_turn_id, created_at, updated_at,
    last_accessed_at, metadata
  FROM memories
  WHERE (session_id = ? OR ? IS NULL)
  ORDER BY created_at DESC
  LIMIT ?
`);

const getMemoriesByImportanceStmt = db.prepare(`
  SELECT
    id, session_id, content, type, category, importance, surprise_score,
    access_count, decay_factor, source_turn_id, created_at, updated_at,
    last_accessed_at, metadata
  FROM memories
  WHERE (session_id = ? OR ? IS NULL)
  ORDER BY importance DESC, created_at DESC
  LIMIT ?
`);

const getMemoriesBySurpriseStmt = db.prepare(`
  SELECT
    id, session_id, content, type, category, importance, surprise_score,
    access_count, decay_factor, source_turn_id, created_at, updated_at,
    last_accessed_at, metadata
  FROM memories
  WHERE surprise_score >= ?
  ORDER BY surprise_score DESC, created_at DESC
  LIMIT ?
`);

const pruneOldMemoriesStmt = db.prepare(`
  DELETE FROM memories
  WHERE created_at < ?
`);

const pruneByCountStmt = db.prepare(`
  DELETE FROM memories
  WHERE id NOT IN (
    SELECT id FROM memories
    ORDER BY importance DESC, created_at DESC
    LIMIT ?
  )
`);

const countMemoriesStmt = db.prepare("SELECT COUNT(*) as count FROM memories");

const getMemoriesByTypeStmt = db.prepare(`
  SELECT
    id, session_id, content, type, category, importance, surprise_score,
    access_count, decay_factor, source_turn_id, created_at, updated_at,
    last_accessed_at, metadata
  FROM memories
  WHERE type = ?
  ORDER BY importance DESC, created_at DESC
  LIMIT ?
`);

// Entity tracking
const upsertEntityStmt = db.prepare(`
  INSERT INTO memory_entities (entity_type, entity_name, first_seen_at, last_seen_at, occurrence_count, properties)
  VALUES (@entity_type, @entity_name, @timestamp, @timestamp, 1, @properties)
  ON CONFLICT(entity_type, entity_name) DO UPDATE SET
    last_seen_at = @timestamp,
    occurrence_count = occurrence_count + 1,
    properties = @properties
`);

const getEntityStmt = db.prepare(`
  SELECT id, entity_type, entity_name, first_seen_at, last_seen_at, occurrence_count, properties
  FROM memory_entities
  WHERE entity_type = ? AND entity_name = ?
`);

const getAllEntitiesStmt = db.prepare(`
  SELECT id, entity_type, entity_name, first_seen_at, last_seen_at, occurrence_count, properties
  FROM memory_entities
  ORDER BY occurrence_count DESC
  LIMIT ?
`);

// Helper functions
function parseJSON(value, fallback = null) {
  if (value === null || value === undefined) return fallback;
  try {
    return JSON.parse(value);
  } catch (err) {
    logger.warn({ err }, "Failed to parse JSON from memory store");
    return fallback;
  }
}

function serialize(value) {
  if (value === undefined || value === null) return null;
  try {
    return JSON.stringify(value);
  } catch (err) {
    logger.warn({ err }, "Failed to serialize JSON for memory store");
    return null;
  }
}

function toMemory(row) {
  if (!row) return null;
  return {
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
    metadata: parseJSON(row.metadata, {}),
  };
}

function toEntity(row) {
  if (!row) return null;
  return {
    id: row.id,
    entityType: row.entity_type,
    entityName: row.entity_name,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    occurrenceCount: row.occurrence_count ?? 1,
    properties: parseJSON(row.properties, {}),
  };
}

/**
 * Create a new memory
 */
function createMemory(options) {
  const now = Date.now();
  const {
    sessionId = null,
    content,
    type,
    category = null,
    importance = 0.5,
    surpriseScore = 0.0,
    accessCount = 0,
    decayFactor = 1.0,
    sourceTurnId = null,
    metadata = {},
  } = options;

  if (!content || !type) {
    throw new Error("Memory content and type are required");
  }

  const result = insertMemoryStmt.run({
    session_id: sessionId,
    content,
    type,
    category,
    importance,
    surprise_score: surpriseScore,
    access_count: accessCount,
    decay_factor: decayFactor,
    source_turn_id: sourceTurnId,
    created_at: now,
    updated_at: now,
    last_accessed_at: null,
    metadata: serialize(metadata),
  });

  return {
    id: result.lastInsertRowid,
    sessionId,
    content,
    type,
    category,
    importance,
    surpriseScore,
    accessCount,
    decayFactor,
    sourceTurnId,
    createdAt: now,
    updatedAt: now,
    lastAccessedAt: null,
    metadata,
  };
}

/**
 * Get a memory by ID
 */
function getMemory(id, options = {}) {
  const row = getMemoryStmt.get(id);
  const memory = toMemory(row);

  if (memory && options.incrementAccess) {
    incrementAccessCount(id);
    // Re-fetch to get updated access count
    const updatedRow = getMemoryStmt.get(id);
    return toMemory(updatedRow);
  }

  return memory;
}

/**
 * Update a memory
 */
function updateMemory(id, updates) {
  const memory = getMemory(id);
  if (!memory) {
    throw new Error(`Memory with ID ${id} not found`);
  }

  const now = Date.now();
  updateMemoryStmt.run({
    id,
    content: updates.content ?? memory.content,
    type: updates.type ?? memory.type,
    category: updates.category ?? memory.category,
    importance: updates.importance ?? memory.importance,
    surprise_score: updates.surpriseScore ?? memory.surpriseScore,
    decay_factor: updates.decayFactor ?? memory.decayFactor,
    updated_at: now,
    metadata: serialize(updates.metadata ?? memory.metadata),
  });

  return getMemory(id);
}

/**
 * Delete a memory
 */
function deleteMemory(id) {
  const result = deleteMemoryStmt.run(id);
  return result.changes > 0;
}

/**
 * Increment access count for a memory
 */
function incrementAccessCount(id) {
  const now = Date.now();
  incrementAccessStmt.run(now, id);
}

/**
 * Update importance score
 */
function updateImportance(id, importance) {
  const now = Date.now();
  updateImportanceStmt.run(importance, now, id);
}

/**
 * Get recent memories
 */
function getRecentMemories(options = {}) {
  const { limit = 10, sessionId = null } = options;
  const rows = getRecentMemoriesStmt.all(sessionId, sessionId, limit);
  return rows.map(toMemory);
}

/**
 * Get memories by importance
 */
function getMemoriesByImportance(options = {}) {
  const { limit = 10, sessionId = null } = options;
  const rows = getMemoriesByImportanceStmt.all(sessionId, sessionId, limit);
  return rows.map(toMemory);
}

/**
 * Get memories by surprise score
 */
function getMemoriesBySurprise(options = {}) {
  const { minScore = 0.3, limit = 10 } = options;
  const rows = getMemoriesBySurpriseStmt.all(minScore, limit);
  return rows.map(toMemory);
}

/**
 * Get memories by type
 */
function getMemoriesByType(type, limit = 10) {
  const rows = getMemoriesByTypeStmt.all(type, limit);
  return rows.map(toMemory);
}

/**
 * Prune old memories
 */
function pruneOldMemories(options) {
  const { maxAgeDays } = options;
  const olderThanMs = maxAgeDays * 24 * 60 * 60 * 1000;
  const threshold = Date.now() - olderThanMs;
  const result = pruneOldMemoriesStmt.run(threshold);
  return result.changes;
}

/**
 * Prune to keep only top N memories by importance
 */
function pruneByCount(options) {
  const { maxCount } = options;
  const result = pruneByCountStmt.run(maxCount);
  return result.changes;
}

/**
 * Count total memories
 */
function countMemories(options = {}) {
  const { sessionId = null } = options;

  if (sessionId) {
    const stmt = db.prepare(`
      SELECT COUNT(*) as count FROM memories
      WHERE session_id = ?
    `);
    const result = stmt.get(sessionId);
    return result.count;
  }

  const result = countMemoriesStmt.get();
  return result.count;
}

/**
 * Track or update an entity
 */
function trackEntity(options) {
  const { name, type, context = {} } = options;
  const now = Date.now();
  upsertEntityStmt.run({
    entity_type: type,
    entity_name: name,
    timestamp: now,
    properties: serialize(context),
  });
}

/**
 * Get an entity
 */
function getEntity(name) {
  // Since we only have the name, we need to search across all entity types
  const stmt = db.prepare(`
    SELECT id, entity_type, entity_name, first_seen_at, last_seen_at, occurrence_count, properties
    FROM memory_entities
    WHERE entity_name = ?
  `);
  const row = stmt.get(name);
  if (!row) return null;

  return {
    id: row.id,
    name: row.entity_name,
    type: row.entity_type,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    count: row.occurrence_count ?? 1,
    context: parseJSON(row.properties, {}),
  };
}

/**
 * Get all entities
 */
function getAllEntities(limit = 100) {
  const rows = getAllEntitiesStmt.all(limit);
  return rows.map(row => ({
    id: row.id,
    name: row.entity_name,
    type: row.entity_type,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    count: row.occurrence_count ?? 1,
    context: parseJSON(row.properties, {}),
  }));
}

module.exports = {
  createMemory,
  getMemory,
  updateMemory,
  deleteMemory,
  incrementAccessCount,
  updateImportance,
  getRecentMemories,
  getMemoriesByImportance,
  getMemoriesBySurprise,
  getMemoriesByType,
  pruneOldMemories,
  pruneByCount,
  countMemories,
  trackEntity,
  getEntity,
  getAllEntities,
};
