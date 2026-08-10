/**
 * Skills Cache — Compression Strategy Memory (TencentDB-Agent-Memory inspired)
 *
 * Remembers which compression method worked (and how well) for each
 * structural shape of tool output. Validated skills (savings >= minSavings)
 * persist in the memories table (type='skill') and let future compressions:
 *  - skip section-dedup for shapes where it never helps (latency win)
 *  - compress proven-compressible shapes more aggressively (token win)
 */

const store = require("./store");
const distill = require("../context/distill");
const config = require("../config");
const logger = require("../logger");

const MAX_CACHED_SKILLS = 1000;
const SIGNATURE_LINES = 30;

// signature -> { method, avgSavings, hits, persistedId }
let skillMap = null;

function skillsConfig() {
  return config.memory?.skills ?? {};
}

/**
 * Structural shape signature for a tool output: leading token of each of
 * the first N normalized lines. Two grep outputs, two test runs, or two
 * JSON blobs with the same shape produce the same signature even when the
 * values differ.
 */
function shapeSignature(text) {
  if (!text) return "empty";
  const lines = distill.normalizeText(text).split("\n").slice(0, SIGNATURE_LINES);
  const shape = lines
    .map(l => {
      const trimmed = l.trim();
      if (!trimmed) return "";
      // Leading structural token: punctuation kept, words folded
      const lead = trimmed.match(/^[{}[\]"'\-+*#>|]|^[A-Za-z_$]+|^\d+/);
      return lead ? (/^\d+$/.test(lead[0]) ? "N" : lead[0]) : trimmed[0];
    })
    .join(",");
  // djb2 hash keeps keys short
  let hash = 5381;
  for (let i = 0; i < shape.length; i++) {
    hash = ((hash << 5) + hash + shape.charCodeAt(i)) | 0;
  }
  return `s${lines.length}_${(hash >>> 0).toString(36)}`;
}

function loadCache() {
  if (skillMap) return skillMap;

  skillMap = new Map();
  try {
    const rows = store.getMemoriesByType("skill", MAX_CACHED_SKILLS);
    for (const row of rows) {
      const meta = typeof row.metadata === "string" ? JSON.parse(row.metadata) : row.metadata;
      if (!meta?.signature) continue;
      skillMap.set(meta.signature, {
        method: meta.method,
        avgSavings: meta.avgSavings ?? 0,
        hits: meta.hits ?? 1,
        persistedId: row.id,
      });
    }
  } catch (err) {
    logger.warn({ err }, "[skills] Failed to load skills, starting empty");
  }
  return skillMap;
}

/**
 * Look up a known compression skill for a shape signature.
 * @returns {{method: string, avgSavings: number, hits: number}|null}
 */
function lookup(signature) {
  if (skillsConfig().enabled === false) return null;
  return loadCache().get(signature) ?? null;
}

/**
 * Record a compression outcome. Kept in memory always (so known-futile
 * shapes can skip dedup work); persisted only when the running average
 * savings clears minSavings — the "validated skill" bar.
 *
 * @param {string} signature - shapeSignature() of the original text
 * @param {string} method - compression method that ran ('delta'|'distill'|'passthrough')
 * @param {number} savings - fraction saved, 0..1
 */
function record(signature, method, savings) {
  if (skillsConfig().enabled === false || !signature) return;

  const cache = loadCache();
  const existing = cache.get(signature);
  const entry = existing
    ? {
        ...existing,
        method,
        hits: existing.hits + 1,
        avgSavings: (existing.avgSavings * existing.hits + savings) / (existing.hits + 1),
      }
    : { method, avgSavings: savings, hits: 1, persistedId: null };

  cache.set(signature, entry);
  if (cache.size > MAX_CACHED_SKILLS) {
    cache.delete(cache.keys().next().value);
  }

  const minSavings = skillsConfig().minSavings ?? 0.6;
  if (entry.avgSavings < minSavings) return;

  // Persist validated skill off the hot path
  setImmediate(() => {
    try {
      const metadata = {
        signature,
        method: entry.method,
        avgSavings: entry.avgSavings,
        hits: entry.hits,
      };
      if (entry.persistedId) {
        const current = store.getMemory(entry.persistedId);
        if (current) {
          store.updateMemory(entry.persistedId, { metadata });
          return;
        }
      }
      const memory = store.createMemory({
        sessionId: null,
        content: `Compression skill: ${entry.method} saves ${(entry.avgSavings * 100).toFixed(0)}% on shape ${signature}`,
        type: "skill",
        category: "optimization",
        importance: 0.3,
        metadata,
      });
      entry.persistedId = memory.id;
    } catch (err) {
      logger.warn({ err, signature }, "[skills] Failed to persist skill");
    }
  });
}

/**
 * Compression hints for a given text, derived from validated skills.
 *
 * @param {string} text - Tool result text about to be compressed
 * @returns {{signature: string, skipDedup: boolean, maxLengthFactor: number}}
 */
function getCompressionHints(text) {
  const signature = shapeSignature(text);
  const skill = lookup(signature);
  const minSavings = skillsConfig().minSavings ?? 0.6;

  if (!skill || skill.hits < 2) {
    return { signature, skipDedup: false, maxLengthFactor: 1 };
  }

  return {
    signature,
    // Dedup/delta repeatedly achieved almost nothing — don't burn CPU on it
    skipDedup: skill.method === "passthrough" || skill.avgSavings < 0.05,
    // Proven highly-compressible shape — compress harder
    maxLengthFactor: skill.avgSavings >= minSavings ? 0.8 : 1,
  };
}

/** Reset the in-memory cache (test support). */
function resetCache() {
  skillMap = null;
}

module.exports = {
  shapeSignature,
  lookup,
  record,
  getCompressionHints,
  resetCache,
};
