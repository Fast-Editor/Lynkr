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
 * WS1 extends this from a per-turn tool-safety guard into a cache-aware sticky
 * routing pin: routing decisions are made **once per session** (persisted to
 * SQLite so restarts don't lose them) and re-evaluated only at explicit
 * triggers — compaction, guard escalation, provider unavailable, or an
 * economic downgrade that beats the estimated cold-cache re-read cost.
 *
 * The in-memory Map is a read-through cache over `affinity-store` (SQLite);
 * the store is authoritative across restarts, the Map keeps hot sessions
 * off the SQLite path.
 *
 * @module routing/session-affinity
 */

const store = require("./affinity-store");

const MAX_ENTRIES = 2000;
// 6h TTL — long enough that a working session (dev machine idled overnight)
// keeps its pin, short enough that abandoned sessions eventually clear.
// Override with LYNKR_STICKY_TTL_MS.
function _ttlMs() {
  const raw = Number(process.env.LYNKR_STICKY_TTL_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 6 * 60 * 60 * 1000;
}

/**
 * Pin entry shape.
 * @typedef {Object} Pin
 * @property {string}  provider
 * @property {string|null}  model
 * @property {string|null}  tier
 * @property {number|null}  score            - decision.score at pin time (so pinned turns can display the original intent score in the badge instead of a misleading full-payload complexity score)
 * @property {number|null}  messageCount     - payload.messages.length at pin time
 * @property {number|null}  promptTokensEst  - countPayloadTokens estimate at pin time
 * @property {number}  ts
 */

/** @type {Map<string, Pin>} */
const pins = new Map();

function _evictIfNeeded() {
  if (pins.size <= MAX_ENTRIES) return;
  const oldest = pins.keys().next().value;
  if (oldest !== undefined) pins.delete(oldest);
}

/**
 * True when the payload is MID tool exchange — the LAST message is
 * submitting tool_result blocks (or replaying a dangling tool_use). Those
 * are the frames whose tool-call IDs break if the provider changes.
 *
 * COMPLETED tool exchanges earlier in the history are safe to carry across
 * providers: the tool_use/tool_result pairs are internally consistent and
 * any Anthropic-format backend accepts them.
 *
 * The original implementation matched tool blocks ANYWHERE in history,
 * which meant one tool call permanently welded the session to its pin:
 * every subsequent frame — including freshly typed user messages — took
 * the unconditional serve, silently disabling the risk/context/vision
 * guards AND the WS1.5 drift check for the rest of the session. Live
 * symptom (2026-07-07): a heavyweight typed ask displayed
 * "score 0 · pin@0" because drift never ran after the session's first
 * tool use.
 * @param {object} payload
 * @returns {boolean}
 */
function payloadHasToolHistory(payload) {
  const messages = payload?.messages;
  if (!Array.isArray(messages) || messages.length === 0) return false;
  const content = messages[messages.length - 1]?.content;
  if (!Array.isArray(content)) return false;
  return content.some((b) => b?.type === "tool_result" || b?.type === "tool_use");
}

/**
 * Load a pin: memory first, then SQLite. Returns null on TTL expiry or miss.
 * @param {string} sessionId
 * @returns {Pin|null}
 */
function getPin(sessionId) {
  if (!sessionId) return null;
  const ttl = _ttlMs();

  const inMem = pins.get(sessionId);
  if (inMem) {
    if (Date.now() - inMem.ts > ttl) {
      pins.delete(sessionId);
      store.remove(sessionId);
      return null;
    }
    return inMem;
  }

  // Cold cache — read through the store.
  const fromStore = store.load(sessionId, ttl);
  if (!fromStore) return null;
  pins.set(sessionId, fromStore);
  _evictIfNeeded();
  return fromStore;
}

/**
 * Write-through: update the in-memory Map and persist to SQLite.
 * Accepts a routing decision plus session-scoped stats used by the re-pin
 * heuristics.
 *
 * `hasToolHistory` is sticky-true: once set to true it stays true for the
 * pin's lifetime — a follow-up refresh that didn't carry tool blocks (e.g.
 * a plain-text turn between tool exchanges) must not clear the flag, or the
 * Signal-2 side-channel check would flip open again.
 *
 * @param {string} sessionId
 * @param {{provider:string, model?:string|null, tier?:string|null}} decision
 * @param {{messageCount?:number|null, promptTokensEst?:number|null, hasToolHistory?:boolean}} [stats]
 */
function setPin(sessionId, decision, stats = {}) {
  if (!sessionId || !decision?.provider) return;
  const prev = pins.get(sessionId);
  const pin = {
    provider: decision.provider,
    model: decision.model ?? null,
    tier: decision.tier ?? null,
    score: typeof decision.score === 'number' ? decision.score : null,
    messageCount: stats.messageCount ?? null,
    promptTokensEst: stats.promptTokensEst ?? null,
    hasToolHistory: !!(stats.hasToolHistory || prev?.hasToolHistory),
    ts: Date.now(),
  };
  // Refresh insertion order so active sessions aren't evicted.
  pins.delete(sessionId);
  pins.set(sessionId, pin);
  _evictIfNeeded();
  store.save(sessionId, pin);
}

/**
 * Decide whether the session should be re-routed from its current pin based
 * on the incoming payload. Currently detects "compaction" — the client
 * shrunk its message history (e.g. Claude Code's /compact), which resets
 * the provider's prompt cache anyway, so we're free to re-route without
 * incurring an extra cold-cache read.
 *
 * @param {Pin|null} pin
 * @param {object} payload
 * @returns {{repin: boolean, reason: string|null}}
 */
function shouldRepin(pin, payload) {
  if (!pin) return { repin: true, reason: "no_pin" };
  const currentMsgCount = Array.isArray(payload?.messages) ? payload.messages.length : 0;
  const pinnedMsgCount = pin.messageCount ?? null;
  // A 1-2 message payload against a long-conversation pin is NOT compaction
  // — it's a new conversation whose opener collided with an old session's
  // fingerprint (compaction always leaves summary + recent turns, never a
  // bare opener). Mislabeling it lets the compaction floor pin greetings
  // to expensive tiers.
  if (pinnedMsgCount != null && currentMsgCount <= 2 && pinnedMsgCount > 4) {
    return { repin: true, reason: "new_conversation" };
  }
  if (pinnedMsgCount != null && currentMsgCount < pinnedMsgCount - 2) {
    return { repin: true, reason: "compaction" };
  }
  return { repin: false, reason: null };
}

/** Test/maintenance helper — clear the in-memory Map only. */
function _clear() {
  pins.clear();
}

/** Test helper — clear both memory and persistent store. */
function _clearAll() {
  pins.clear();
  store._clear();
}

// ---------------------------------------------------------------------------
// Legacy compatibility surface
//
// Preserved so existing call sites and tests keep working during the WS1
// rollout. New code should use getPin/setPin (which record message_count and
// prompt tokens for the sticky-routing triggers).
// ---------------------------------------------------------------------------

/** @deprecated use getPin */
function getPinned(sessionId) {
  const p = getPin(sessionId);
  if (!p) return null;
  return { provider: p.provider, model: p.model, tier: p.tier, ts: p.ts };
}

/**
 * Drop a session's pin (memory + store). Used when a mid-tool-exchange
 * frame carries embedded typed text that trips a trigger (force-cloud /
 * autonomous): the frame itself must still serve the pin (tool_use ↔
 * tool_result id linkage breaks on a mid-exchange switch), but the pin
 * must not survive to the next turn boundary.
 * @param {string} sessionId
 */
function removePin(sessionId) {
  if (!sessionId) return;
  pins.delete(sessionId);
  store.remove(sessionId);
}

/** @deprecated use setPin */
function setPinned(sessionId, decision) {
  setPin(sessionId, decision);
}

module.exports = {
  payloadHasToolHistory,
  getPin,
  setPin,
  removePin,
  shouldRepin,
  // legacy
  getPinned,
  setPinned,
  _clear,
  _clearAll,
};
