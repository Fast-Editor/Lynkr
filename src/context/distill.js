/**
 * Distill — Core Algorithms for Intelligent Compression
 *
 * Ported from samuelfaj/distill (TypeScript CLI tool).
 * Provides structural similarity detection, delta rendering,
 * burst detection, text normalization, and bad distillation detection
 * for LLM-optimized context compression.
 *
 * @module context/distill
 */

const logger = require('../logger');

// ── Text Normalization ──────────────────────────────────────────────

/**
 * Strip ANSI escape codes from text
 */
function stripAnsi(text) {
  if (!text) return '';
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '');
}

/**
 * Normalize text for comparison:
 * - Strip ANSI codes
 * - Normalize line endings
 * - Collapse whitespace runs
 * - Trim
 */
function normalizeText(text) {
  if (!text) return '';
  let result = stripAnsi(text);
  result = result.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  result = result.replace(/[ \t]+/g, ' ');
  result = result.replace(/\n{3,}/g, '\n\n');
  return result.trim();
}

/**
 * Extract a structural signature from text.
 * Splits into lines, normalizes each, filters empties,
 * returns a Set of unique line signatures for Jaccard comparison.
 */
function extractSignature(text) {
  const normalized = normalizeText(text);
  const lines = normalized.split('\n').map(l => l.trim()).filter(Boolean);
  return new Set(lines);
}

// ── Structural Similarity (Jaccard) ─────────────────────────────────

/**
 * Compute Jaccard similarity between two Sets.
 * Returns a value in [0, 1].
 */
function jaccardSimilarity(setA, setB) {
  if (setA.size === 0 && setB.size === 0) return 1;
  if (setA.size === 0 || setB.size === 0) return 0;

  let intersection = 0;
  const smaller = setA.size <= setB.size ? setA : setB;
  const larger = setA.size <= setB.size ? setB : setA;

  for (const item of smaller) {
    if (larger.has(item)) intersection++;
  }

  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

// Try to load native Rust implementation (3.7x faster for 100+ line blocks)
let nativeSimilarity = null;
try {
  const native = require('../../native');
  if (native.available && native.structuralSimilarity) {
    nativeSimilarity = native.structuralSimilarity;
  }
} catch { /* native module not available — use JS */ }

/**
 * Compute structural similarity between two text blocks.
 * Uses normalized line signatures + Jaccard index.
 * Delegates to Rust native when available (3.7x faster).
 *
 * @param {string} a - First text
 * @param {string} b - Second text
 * @returns {number} Similarity score in [0, 1]
 */
function structuralSimilarity(a, b) {
  if (!a && !b) return 1;
  if (!a || !b) return 0;

  // Use Rust for large inputs where the speedup offsets Napi boundary cost
  if (nativeSimilarity && a.length + b.length > 500) {
    return nativeSimilarity(a, b);
  }

  const sigA = extractSignature(a);
  const sigB = extractSignature(b);

  return jaccardSimilarity(sigA, sigB);
}

// ── Delta Rendering ─────────────────────────────────────────────────

/**
 * Compute a delta between two text blocks.
 * Returns only the lines that changed (added/removed).
 * If similarity is above threshold, returns a compact diff summary.
 *
 * @param {string} previous - Previous text
 * @param {string} current - Current text
 * @param {Object} options
 * @param {number} options.similarityThreshold - Min similarity to use delta (default 0.3)
 * @returns {Object} { isDelta, similarity, result, addedCount, removedCount }
 */
function deltaRender(previous, current, options = {}) {
  const threshold = options.similarityThreshold ?? 0.3;

  if (!previous) {
    return { isDelta: false, similarity: 0, result: current, addedCount: 0, removedCount: 0 };
  }

  const similarity = structuralSimilarity(previous, current);

  // If not similar enough, return full text (no point diffing unrelated content)
  if (similarity < threshold) {
    return { isDelta: false, similarity, result: current, addedCount: 0, removedCount: 0 };
  }

  const prevLines = normalizeText(previous).split('\n');
  const currLines = normalizeText(current).split('\n');

  const prevSet = new Set(prevLines);
  const currSet = new Set(currLines);

  const added = currLines.filter(l => !prevSet.has(l));
  const removed = prevLines.filter(l => !currSet.has(l));

  if (added.length === 0 && removed.length === 0) {
    return {
      isDelta: true,
      similarity: 1,
      result: '[No changes]',
      addedCount: 0,
      removedCount: 0,
    };
  }

  const parts = [];
  if (removed.length > 0) {
    parts.push(`[Removed ${removed.length} lines]`);
  }
  if (added.length > 0) {
    parts.push(`[Added ${added.length} lines]`);
    parts.push(added.join('\n'));
  }

  return {
    isDelta: true,
    similarity,
    result: parts.join('\n'),
    addedCount: added.length,
    removedCount: removed.length,
  };
}

// ── Burst Detection ─────────────────────────────────────────────────

/**
 * Detect output bursts — groups of data separated by idle periods.
 * Used to determine if output is streaming (many small bursts)
 * or batch (few large bursts).
 *
 * @param {Array<{timestamp: number, size: number}>} chunks - Output chunks with timing
 * @param {number} idleThresholdMs - Idle time to split bursts (default 2000ms)
 * @returns {Object} { burstCount, avgBurstSize, mode: 'streaming'|'batch' }
 */
function detectBursts(chunks, idleThresholdMs = 2000) {
  if (!chunks || chunks.length === 0) {
    return { burstCount: 0, avgBurstSize: 0, mode: 'batch' };
  }

  if (chunks.length === 1) {
    return { burstCount: 1, avgBurstSize: chunks[0].size, mode: 'batch' };
  }

  let burstCount = 1;
  let currentBurstSize = chunks[0].size;
  const burstSizes = [];

  for (let i = 1; i < chunks.length; i++) {
    const gap = chunks[i].timestamp - chunks[i - 1].timestamp;

    if (gap > idleThresholdMs) {
      burstSizes.push(currentBurstSize);
      burstCount++;
      currentBurstSize = chunks[i].size;
    } else {
      currentBurstSize += chunks[i].size;
    }
  }
  burstSizes.push(currentBurstSize);

  const avgBurstSize = burstSizes.reduce((a, b) => a + b, 0) / burstSizes.length;

  return {
    burstCount,
    avgBurstSize: Math.round(avgBurstSize),
    mode: burstCount > 5 ? 'streaming' : 'batch',
  };
}

// ── Bad Distillation Detection ──────────────────────────────────────

/**
 * Heuristics to detect when a compression/summary is worse than original.
 * Checks for:
 * - Summary is longer than original
 * - Summary lost too much information (similarity too low)
 * - Summary introduced hallucinated content (low overlap)
 * - Summary is just a truncation
 *
 * @param {string} original - Original text
 * @param {string} summary - Compressed/summarized text
 * @param {Object} options
 * @param {number} options.maxExpansionRatio - Max allowed summary/original ratio (default 1.1)
 * @param {number} options.minRetention - Min similarity to consider useful (default 0.15)
 * @returns {Object} { isBad, reasons: string[] }
 */
function detectBadDistillation(original, summary, options = {}) {
  const maxExpansionRatio = options.maxExpansionRatio ?? 1.1;
  const minRetention = options.minRetention ?? 0.15;

  const reasons = [];

  if (!original || !summary) {
    return { isBad: false, reasons };
  }

  const origLen = normalizeText(original).length;
  const sumLen = normalizeText(summary).length;

  // Check expansion
  if (origLen > 0 && sumLen / origLen > maxExpansionRatio) {
    reasons.push(`Summary is ${((sumLen / origLen) * 100).toFixed(0)}% of original (expanded)`);
  }

  // Check retention via similarity
  const similarity = structuralSimilarity(original, summary);
  if (similarity < minRetention && sumLen > 50) {
    reasons.push(`Low similarity (${(similarity * 100).toFixed(0)}%) — summary may not represent original`);
  }

  // Check if summary is just a truncation of original
  const origNorm = normalizeText(original);
  const sumNorm = normalizeText(summary);
  if (origNorm.startsWith(sumNorm) && sumLen < origLen * 0.9) {
    reasons.push('Summary appears to be a simple truncation');
  }

  return {
    isBad: reasons.length > 0,
    reasons,
    similarity,
    expansionRatio: origLen > 0 ? sumLen / origLen : 0,
  };
}

// ── Repetition Detection ────────────────────────────────────────────

/**
 * Detect repetitive blocks in a sequence of text outputs.
 * Groups consecutive similar blocks and replaces them with a count.
 *
 * @param {string[]} blocks - Array of text blocks (e.g., tool results)
 * @param {Object} options
 * @param {number} options.similarityThreshold - Threshold for "same" (default 0.8)
 * @returns {Object} { compressed: string[], stats: { totalBlocks, uniqueBlocks, duplicatesRemoved } }
 */
function deduplicateBlocks(blocks, options = {}) {
  const threshold = options.similarityThreshold ?? 0.8;

  if (!blocks || blocks.length <= 1) {
    return {
      compressed: blocks || [],
      stats: { totalBlocks: blocks?.length || 0, uniqueBlocks: blocks?.length || 0, duplicatesRemoved: 0 },
    };
  }

  const compressed = [];
  let runStart = 0;
  let runCount = 1;

  for (let i = 1; i < blocks.length; i++) {
    const sim = structuralSimilarity(blocks[runStart], blocks[i]);

    if (sim >= threshold) {
      runCount++;
    } else {
      // Flush the current run
      compressed.push(blocks[runStart]);
      if (runCount > 1) {
        compressed.push(`[...repeated ${runCount - 1} more time${runCount - 1 > 1 ? 's' : ''} with minor variations]`);
      }
      runStart = i;
      runCount = 1;
    }
  }

  // Flush last run
  compressed.push(blocks[runStart]);
  if (runCount > 1) {
    compressed.push(`[...repeated ${runCount - 1} more time${runCount - 1 > 1 ? 's' : ''} with minor variations]`);
  }

  const duplicatesRemoved = blocks.length - compressed.length;

  return {
    compressed,
    stats: {
      totalBlocks: blocks.length,
      uniqueBlocks: compressed.filter(b => !b.startsWith('[...repeated')).length,
      duplicatesRemoved: Math.max(0, duplicatesRemoved),
    },
  };
}

// ── Smart Tool Result Compression ───────────────────────────────────

/**
 * Intelligently compress a tool result using Distill algorithms.
 * Applies in order:
 * 1. Text normalization (ANSI strip, whitespace cleanup)
 * 2. Delta rendering against previous result (if available)
 * 3. Structural dedup of repetitive sections within the result
 *
 * @param {string} text - Tool result text
 * @param {Object} options
 * @param {string} options.previousResult - Previous tool result for delta rendering
 * @param {number} options.maxLength - Max output length (default 1000)
 * @returns {Object} { text, method, stats }
 */
function compressToolResult(text, options = {}) {
  if (!text) return { text: '', method: 'empty', stats: {} };

  const maxLength = options.maxLength ?? 1000;
  const originalLength = text.length;

  // Step 1: Normalize
  let result = normalizeText(text);

  // Step 2: Delta rendering against previous result
  if (options.previousResult) {
    const delta = deltaRender(options.previousResult, result);
    if (delta.isDelta && delta.similarity > 0.5) {
      result = delta.result;
      logger.debug({
        similarity: delta.similarity.toFixed(2),
        addedLines: delta.addedCount,
        removedLines: delta.removedCount,
      }, '[Distill] Delta rendering applied');

      if (result.length <= maxLength) {
        return {
          text: result,
          method: 'delta',
          stats: {
            originalLength,
            compressedLength: result.length,
            similarity: delta.similarity,
            savings: ((1 - result.length / originalLength) * 100).toFixed(1) + '%',
          },
        };
      }
    }
  }

  // Step 3: Internal dedup — split into logical sections and dedup
  const sections = result.split(/\n{2,}/);
  if (sections.length > 3) {
    const { compressed, stats } = deduplicateBlocks(sections);
    if (stats.duplicatesRemoved > 0) {
      result = compressed.join('\n\n');
      logger.debug({
        sectionsOriginal: stats.totalBlocks,
        duplicatesRemoved: stats.duplicatesRemoved,
      }, '[Distill] Section dedup applied');
    }
  }

  // Step 4: Truncate if still over limit
  if (result.length > maxLength) {
    const keepStart = Math.floor(maxLength * 0.4);
    const keepEnd = Math.floor(maxLength * 0.4);
    const start = result.substring(0, keepStart);
    const end = result.substring(result.length - keepEnd);
    result = `${start}\n...[${result.length - maxLength} chars compressed]...\n${end}`;
  }

  return {
    text: result,
    method: result.length < originalLength ? 'distill' : 'passthrough',
    stats: {
      originalLength,
      compressedLength: result.length,
      savings: ((1 - result.length / originalLength) * 100).toFixed(1) + '%',
    },
  };
}

// ── History Dedup ───────────────────────────────────────────────────

/**
 * Deduplicate repetitive tool results across conversation history.
 * Scans tool_result blocks, finds structurally similar ones,
 * and replaces duplicates with references.
 *
 * @param {Array} messages - Conversation messages
 * @param {Object} options
 * @param {number} options.similarityThreshold - Threshold (default 0.8)
 * @returns {Object} { messages, stats }
 */
function deduplicateHistory(messages, options = {}) {
  if (!messages || messages.length === 0) {
    return { messages: messages || [], stats: { checked: 0, deduplicated: 0 } };
  }

  const threshold = options.similarityThreshold ?? 0.8;
  const seenResults = []; // { text, signature, index }
  let deduplicated = 0;
  let checked = 0;

  const processed = messages.map((msg, msgIdx) => {
    if (!Array.isArray(msg.content)) return msg;

    const newContent = msg.content.map(block => {
      if (block.type !== 'tool_result') return block;

      const text = typeof block.content === 'string'
        ? block.content
        : Array.isArray(block.content)
          ? block.content.map(c => (typeof c === 'string' ? c : c.text || '')).join('\n')
          : '';

      if (!text || text.length < 100) return block; // Skip short results

      checked++;
      const signature = extractSignature(text);

      // Check against seen results
      for (const seen of seenResults) {
        const sim = jaccardSimilarity(signature, seen.signature);
        if (sim >= threshold) {
          deduplicated++;
          return {
            ...block,
            content: `[Similar to earlier tool result — ${(sim * 100).toFixed(0)}% match, ${text.length} chars compressed]`,
          };
        }
      }

      // Register this result
      seenResults.push({ text, signature, index: msgIdx });
      return block;
    });

    return { ...msg, content: newContent };
  });

  return {
    messages: processed,
    stats: { checked, deduplicated },
  };
}

module.exports = {
  // Text normalization
  stripAnsi,
  normalizeText,
  extractSignature,

  // Structural similarity
  jaccardSimilarity,
  structuralSimilarity,

  // Delta rendering
  deltaRender,

  // Burst detection
  detectBursts,

  // Bad distillation detection
  detectBadDistillation,

  // Repetition detection
  deduplicateBlocks,

  // Smart compression
  compressToolResult,

  // History dedup
  deduplicateHistory,
};
