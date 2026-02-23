/**
 * Parser registry — maps model name prefixes to parser classes.
 *
 * Follows vLLM's pattern: each model family gets a dedicated parser.
 * Unknown models fall back to GenericToolParser.
 */
const logger = require('../logger');
const GenericToolParser = require('./generic-tool-parser');
const Glm47ToolParser = require('./glm47-tool-parser');

// Model prefix → parser class.
// Order matters: longer/more-specific prefixes first.
const PARSER_REGISTRY = [
  { prefix: 'glm-4.7', ParserClass: Glm47ToolParser },
  { prefix: 'glm4',    ParserClass: Glm47ToolParser },
  { prefix: 'glm-4',   ParserClass: Glm47ToolParser },
  // Qwen3 uses the same fenced-block + bullet-point strategies as GLM for now.
  // TODO: Replace with dedicated Qwen3CoderToolParser that handles <function=name> XML format.
  { prefix: 'qwen3-coder', ParserClass: Glm47ToolParser },
  { prefix: 'qwen3',       ParserClass: Glm47ToolParser },
  // Future:
  // { prefix: 'deepseek',    ParserClass: DeepSeekToolParser },
  // { prefix: 'llama',       ParserClass: LlamaToolParser },
];

// Instance cache (model name → parser instance)
const _cache = new Map();

/**
 * Get the appropriate parser for a model name.
 *
 * @param {string} modelName - Full model name (e.g. "glm-4.7:cloud", "qwen3-coder-next")
 * @returns {BaseToolParser} Parser instance (cached)
 */
function getParserForModel(modelName) {
  if (!modelName || typeof modelName !== 'string') {
    return _getOrCreate('__generic__', GenericToolParser, 'generic');
  }

  // Check cache
  if (_cache.has(modelName)) {
    return _cache.get(modelName);
  }

  const normalized = modelName.toLowerCase();

  for (const { prefix, ParserClass } of PARSER_REGISTRY) {
    if (normalized.startsWith(prefix)) {
      logger.debug({ modelName, prefix, parser: ParserClass.name }, 'Parser registry: matched');
      return _getOrCreate(modelName, ParserClass, modelName);
    }
  }

  // Fallback to generic
  logger.debug({ modelName }, 'Parser registry: no match, using GenericToolParser');
  return _getOrCreate(modelName, GenericToolParser, modelName);
}

function _getOrCreate(cacheKey, ParserClass, modelName) {
  if (_cache.has(cacheKey)) return _cache.get(cacheKey);
  const instance = new ParserClass(modelName);
  _cache.set(cacheKey, instance);
  return instance;
}

/**
 * Clear the parser cache (for testing).
 */
function clearParserCache() {
  _cache.clear();
}

module.exports = {
  getParserForModel,
  clearParserCache,
  PARSER_REGISTRY,
};
