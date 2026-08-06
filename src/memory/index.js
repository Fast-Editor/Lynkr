/**
 * Titans-Inspired Long-Term Memory System
 *
 * This module provides long-term memory capabilities with:
 * - Surprise-based memory updates (Titans core innovation)
 * - Automatic memory extraction from conversations
 * - FTS5 semantic search
 * - Multi-signal memory retrieval
 * - Memory management tools
 */

const store = require("./store");
const search = require("./search");
const retriever = require("./retriever");
const extractor = require("./extractor");
const surprise = require("./surprise");
const tools = require("./tools");
const distiller = require("./distiller");
const wiki = require("./wiki");
const skillsCache = require("./skills-cache");

module.exports = {
  // Store operations
  store,
  createMemory: store.createMemory,
  getMemory: store.getMemory,
  updateMemory: store.updateMemory,
  deleteMemory: store.deleteMemory,
  getRecentMemories: store.getRecentMemories,
  getMemoriesByImportance: store.getMemoriesByImportance,
  pruneOldMemories: store.pruneOldMemories,
  countMemories: store.countMemories,

  // Search operations
  search,
  searchMemories: search.searchMemories,
  searchWithExpansion: search.searchWithExpansion,
  findSimilar: search.findSimilar,

  // Retrieval
  retriever,
  retrieveRelevantMemories: retriever.retrieveRelevantMemories,
  formatMemoriesForContext: retriever.formatMemoriesForContext,
  injectMemoriesIntoSystem: retriever.injectMemoriesIntoSystem,
  getMemoryStats: retriever.getMemoryStats,

  // Extraction
  extractor,
  extractMemories: extractor.extractMemories,

  // Surprise detection
  surprise,
  calculateSurprise: surprise.calculateSurprise,

  // Tools
  tools,
  MEMORY_TOOLS: tools.MEMORY_TOOLS,

  // TencentDB-inspired L0-L3 token optimization
  distiller,
  needsDistillation: distiller.needsDistillation,
  distillMessages: distiller.distillMessages,
  wiki,
  skillsCache,
};
