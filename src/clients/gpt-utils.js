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
      .split(/[\s\-_/.,:;]+/)
      .filter(t => t.length > 0)
  );

  const set1 = tokenize(s1);
  const set2 = tokenize(s2);

  const intersection = new Set([...set1].filter(x => set2.has(x)));
  const union = new Set([...set1, ...set2]);

  return union.size > 0 ? intersection.size / union.size : 0;
}

// Common argument keys a Read-style tool might carry its target path under,
// across different clients/harnesses.
const FILE_PATH_ARG_KEYS = ['file_path', 'path', 'filePath', 'filename', 'file'];

/**
 * Pull a file-path argument out of a (possibly stringified) args object,
 * trying the common key spellings different clients use.
 * @param {string|Object} args
 * @returns {string|null}
 */
function extractFilePathArg(args) {
  let obj = args;
  if (typeof obj === 'string') {
    try { obj = JSON.parse(obj); } catch { return null; }
  }
  if (!obj || typeof obj !== 'object') return null;
  for (const key of FILE_PATH_ARG_KEYS) {
    if (typeof obj[key] === 'string' && obj[key]) return obj[key];
  }
  return null;
}

/**
 * Extract a read window [start, end) from read-tool args (offset/limit in
 * lines, the convention Claude Code, opencode, and Cursor all share).
 * Missing offset → 0; missing limit → open-ended (whole rest of the file).
 * @param {string|Object} args
 * @returns {{ start: number, end: number }}
 */
function extractReadWindow(args) {
  let obj = args;
  if (typeof obj === 'string') {
    try { obj = JSON.parse(obj); } catch { obj = null; }
  }
  const start = Number.isFinite(obj?.offset) ? obj.offset : 0;
  const limit = Number.isFinite(obj?.limit) && obj.limit > 0 ? obj.limit : Infinity;
  return { start, end: start + limit };
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

  const toolName = (name1 || '').toLowerCase();

  // Read-style tools: NOT Jaccard-fuzzy-matched (see below for why), and NOT
  // matched on path alone either. This rule has flip-flopped through two live
  // incidents, so the history matters:
  //
  //   1. Jaccard on paths merged reads of DIFFERENT files (repo paths share
  //      nearly every token) → fixed by exact path equality.
  //   2. Exact-args-only let an agent re-read one file at OVERLAPPING offsets
  //      ~10 times, restating the same conclusion, without ever tripping the
  //      guard → fixed by counting any same-path read as similar.
  //   3. That overcorrected: paging through DISJOINT regions of one large
  //      file is exactly how a coding agent works on it (live incident: a
  //      4,000-line settings.rs read at offsets 975/3485/3800 tripped the
  //      warn threshold, and the injected "STOP calling this tool" order
  //      killed the work turn — repeatedly).
  //
  // The rule that satisfies all three: same file + OVERLAPPING (or identical)
  // windows → similar (re-reading content you already have); same file +
  // DISJOINT windows → paging, not a loop. Whole-file reads (no offset/limit)
  // have an open-ended window, so they overlap everything in that file —
  // repeated whole-file re-reads still count, incident #2 stays fixed.
  if (toolName.includes('read')) {
    const path1 = extractFilePathArg(args1);
    const path2 = extractFilePathArg(args2);
    if (path1 && path2 && path1 === path2) {
      const w1 = extractReadWindow(args1);
      const w2 = extractReadWindow(args2);
      const overlaps = w1.start < w2.end && w2.start < w1.end;
      if (overlaps) {
        logger.debug({ tool: name1, path: path1, w1, w2 }, "Same-file overlapping re-read detected");
        return true;
      }
      return false;
    }
    return false;
  }

  // Only search-style tools get fuzzy matching; mutating tools with
  // near-identical args may be intentional repeats.
  // 'read' is handled above, deliberately NOT via Jaccard: its argument is a
  // file path, and absolute paths in one repo share nearly every Jaccard
  // token (/Users/x/project/src/…), so reads of DIFFERENT files scored ≥0.8
  // and merged into one "repeated call" signature (live incident: an opencode
  // code-trace reading server.js, openai-router.js and orchestrator/index.js
  // was flagged as a loop).
  const searchTools = ['grep', 'glob', 'search', 'find', 'bash', 'shell'];
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
  extractReadWindow,
};
