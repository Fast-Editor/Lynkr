/**
 * Detection of semantically-similar tool calls.
 *
 * GPT-family models often retry a tool with slightly different but
 * functionally equivalent parameters instead of accepting the result;
 * the orchestrator uses areSimilarToolCalls to treat those retries as
 * duplicates.
 */

const logger = require("../logger");

// Jaccard similarity above this counts two search-tool calls as duplicates
const SIMILARITY_THRESHOLD = 0.8;

/**
 * Calculate string similarity using Jaccard index
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
 * @param {Object} call1 - First tool call {name, arguments}
 * @param {Object} call2 - Second tool call {name, arguments}
 * @returns {boolean} - True if calls are similar enough to be considered duplicates
 */
function areSimilarToolCalls(call1, call2) {
  if (!call1 || !call2) return false;

  const name1 = call1.function?.name ?? call1.name;
  const name2 = call2.function?.name ?? call2.name;
  if (name1 !== name2) return false;

  const args1 = call1.function?.arguments ?? call1.arguments ?? call1.input ?? {};
  const args2 = call2.function?.arguments ?? call2.arguments ?? call2.input ?? {};

  const argsStr1 = typeof args1 === 'string' ? args1 : JSON.stringify(args1);
  const argsStr2 = typeof args2 === 'string' ? args2 : JSON.stringify(args2);

  if (argsStr1 === argsStr2) return true;

  // Only search-style tools get fuzzy matching; mutating tools with
  // near-identical args may be intentional repeats.
  const searchTools = ['grep', 'glob', 'search', 'find', 'read', 'bash', 'shell'];
  const toolName = (name1 || '').toLowerCase();
  const isSearchTool = searchTools.some(t => toolName.includes(t));

  if (isSearchTool) {
    const similarity = stringSimilarity(argsStr1, argsStr2);
    if (similarity >= SIMILARITY_THRESHOLD) {
      logger.debug({
        tool: name1,
        similarity,
        threshold: SIMILARITY_THRESHOLD,
        args1: argsStr1.substring(0, 100),
        args2: argsStr2.substring(0, 100),
      }, "Similar tool call detected");
      return true;
    }
  }

  return false;
}

module.exports = {
  areSimilarToolCalls,
};
