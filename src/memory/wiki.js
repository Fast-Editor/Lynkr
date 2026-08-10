/**
 * Wiki — Large-Block Content Registry (TencentDB-Agent-Memory inspired)
 *
 * Registers large content blocks (docs, configs, big tool outputs) the
 * first time they appear in old conversation history, then replaces later
 * near-duplicates with a short reference + summary instead of resending
 * the full block. Entries persist in the memories table (type='wiki') so
 * dedup works across sessions.
 */

const store = require("./store");
const distill = require("../context/distill");
const config = require("../config");
const logger = require("../logger");

const CHARS_PER_TOKEN = 4;
const MAX_CACHED_ENTRIES = 500;
const MAX_SIGNATURE_LINES = 200;

// In-memory entry cache: [{ id, summary, signature: Set<string> }]
let entryCache = null;

function wikiConfig() {
  return config.memory?.wiki ?? {};
}

function minChars() {
  return (wikiConfig().minTokens ?? 500) * CHARS_PER_TOKEN;
}

/**
 * Load persisted wiki entries into the in-memory cache (lazy, once).
 */
function loadCache() {
  if (entryCache) return entryCache;

  entryCache = [];
  try {
    const rows = store.getMemoriesByType("wiki", MAX_CACHED_ENTRIES);
    for (const row of rows) {
      const meta = typeof row.metadata === "string" ? JSON.parse(row.metadata) : row.metadata;
      if (!meta?.signatureLines?.length) continue;
      entryCache.push({
        id: row.id,
        summary: row.content,
        signature: new Set(meta.signatureLines),
      });
    }
  } catch (err) {
    logger.warn({ err }, "[wiki] Failed to load wiki entries, starting empty");
  }
  return entryCache;
}

/**
 * Build a one-line summary for a content block: first heading or first
 * meaningful line, plus a size note.
 */
function makeSummary(text) {
  const lines = distill.normalizeText(text).split("\n").filter(Boolean);
  const heading = lines.find(l => /^#{1,4}\s|^[A-Z][^a-z]*$/.test(l.trim()));
  const first = (heading || lines[0] || "").trim().slice(0, 120);
  return `${first} (${lines.length} lines, ~${Math.ceil(text.length / CHARS_PER_TOKEN)} tokens)`;
}

/**
 * Register a large block, or return a compact reference if a similar
 * block is already known.
 *
 * @param {string} text - Content block from old history
 * @returns {{ref: string, id: number, saved: number}|null} Reference when a
 *   similar entry exists; null when the block was registered or is too small
 */
function registerOrDereference(text) {
  if (wikiConfig().enabled === false) return null;
  if (!text || text.length < minChars()) return null;

  const threshold = wikiConfig().similarityThreshold ?? 0.85;
  const signature = distill.extractSignature(text);
  const cache = loadCache();

  for (const entry of cache) {
    const sim = distill.jaccardSimilarity(signature, entry.signature);
    if (sim >= threshold) {
      const ref = `[wiki:${entry.id} — ${(sim * 100).toFixed(0)}% match] ${entry.summary}`;
      return { ref, id: entry.id, saved: text.length - ref.length };
    }
  }

  // No match — register for future dedup
  try {
    const summary = makeSummary(text);
    const memory = store.createMemory({
      sessionId: null, // wiki entries are global
      content: summary,
      type: "wiki",
      category: "reference",
      importance: 0.3,
      metadata: {
        signatureLines: Array.from(signature).slice(0, MAX_SIGNATURE_LINES),
        originalChars: text.length,
      },
    });
    cache.push({ id: memory.id, summary, signature });
    if (cache.length > MAX_CACHED_ENTRIES) cache.shift();
  } catch (err) {
    logger.warn({ err }, "[wiki] Failed to register wiki entry");
  }

  return null;
}

/**
 * Replace large repeated blocks inside old-history messages with wiki
 * references. Only text and tool_result content is touched.
 *
 * @param {Array} messages - Old (about-to-be-summarized) messages
 * @returns {{messages: Array, stats: {registered: number, dereferenced: number, charsSaved: number}}}
 */
function dereferenceMessages(messages) {
  const stats = { registered: 0, dereferenced: 0, charsSaved: 0 };
  if (wikiConfig().enabled === false || !messages?.length) {
    return { messages: messages || [], stats };
  }

  const processText = (text) => {
    const before = loadCache().length;
    const result = registerOrDereference(text);
    if (result) {
      stats.dereferenced++;
      stats.charsSaved += result.saved;
      return result.ref;
    }
    if (loadCache().length > before) stats.registered++;
    return text;
  };

  const processed = messages.map(msg => {
    if (typeof msg.content === "string") {
      if (msg.content.length < minChars()) return msg;
      return { ...msg, content: processText(msg.content) };
    }
    if (!Array.isArray(msg.content)) return msg;

    const newContent = msg.content.map(block => {
      if (block.type === "text" && block.text?.length >= minChars()) {
        return { ...block, text: processText(block.text) };
      }
      if (block.type === "tool_result" && typeof block.content === "string" &&
          block.content.length >= minChars()) {
        return { ...block, content: processText(block.content) };
      }
      return block;
    });
    return { ...msg, content: newContent };
  });

  return { messages: processed, stats };
}

/** Reset the in-memory cache (test support). */
function resetCache() {
  entryCache = null;
}

module.exports = {
  registerOrDereference,
  dereferenceMessages,
  makeSummary,
  resetCache,
};
