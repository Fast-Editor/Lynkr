/**
 * Session → Provider Affinity
 *
 * A multi-turn agentic conversation builds up tool_use / tool_result history
 * whose tool-call IDs are formatted for the provider that produced them. If a
 * later turn re-routes to a *different* provider (because per-turn complexity
 * or risk changed), that provider rejects the orphaned tool linkage:
 *
 *   Azure: 400 "No tool call found for function call output with call_id …"
 *   Moonshot: 400 "Invalid request: tool_call_id is not found"
 *
 * To prevent that, once a session has chosen a provider we keep subsequent
 * turns on it *while the payload carries tool history*. Fresh turns (no tool
 * state) still route normally, so per-turn tier routing is preserved.
 *
 * @module routing/session-affinity
 */

const MAX_ENTRIES = 2000;
const TTL_MS = 60 * 60 * 1000; // 1 hour

/** @type {Map<string, {provider:string, model:string|null, tier:string|null, ts:number}>} */
const pins = new Map();

function _evictIfNeeded() {
  if (pins.size <= MAX_ENTRIES) return;
  // Map preserves insertion order — drop the oldest.
  const oldest = pins.keys().next().value;
  if (oldest !== undefined) pins.delete(oldest);
}

/**
 * True when the payload contains an in-flight tool exchange — i.e. a prior
 * assistant tool_use or a user tool_result. These are the turns whose
 * tool-call IDs break if the provider changes.
 * @param {object} payload
 * @returns {boolean}
 */
function payloadHasToolHistory(payload) {
  const messages = payload?.messages;
  if (!Array.isArray(messages)) return false;
  for (const msg of messages) {
    const content = msg?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      const t = block?.type;
      if (t === "tool_use" || t === "tool_result") return true;
    }
  }
  return false;
}

/**
 * Return the pinned routing decision for a session, or null if none / expired.
 * @param {string} sessionId
 */
function getPinned(sessionId) {
  if (!sessionId) return null;
  const entry = pins.get(sessionId);
  if (!entry) return null;
  if (Date.now() - entry.ts > TTL_MS) {
    pins.delete(sessionId);
    return null;
  }
  return entry;
}

/**
 * Record the provider a session routed to, for reuse on later tool-bearing turns.
 * @param {string} sessionId
 * @param {{provider:string, model?:string|null, tier?:string|null}} decision
 */
function setPinned(sessionId, decision) {
  if (!sessionId || !decision?.provider) return;
  // Refresh insertion order so active sessions aren't evicted.
  pins.delete(sessionId);
  pins.set(sessionId, {
    provider: decision.provider,
    model: decision.model ?? null,
    tier: decision.tier ?? null,
    ts: Date.now(),
  });
  _evictIfNeeded();
}

/** Test/maintenance helper. */
function _clear() {
  pins.clear();
}

module.exports = {
  payloadHasToolHistory,
  getPinned,
  setPinned,
  _clear,
};
