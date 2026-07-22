/**
 * Side-Channel Detector — first-user-message fingerprint drift
 *
 * Complements the pin-based side-channel signals in router.js:
 *   1. Message-count regression   → needs pin
 *   2. Tool-history mismatch      → needs pin with hasToolHistory
 *   3. First-message fingerprint  → THIS module — works before any pin exists
 *
 * Purpose: on a session's first request, cache a fingerprint of messages[0].
 * On later requests within the TTL, if messages[0] no longer matches, the
 * payload has been replayed by a background utility caller (Claude Code
 * wraps the original user text in `<session>...</session>` for title-gen,
 * substitutes recap prompts, etc.).
 *
 * Trade-off: if a background call fires BEFORE the first real user turn
 * lands, its wrapper prompt becomes the anchor. That's rare in practice —
 * observed order in real traffic is user turn first, background call after.
 * If it does happen, the real user's next request will be mislabelled once,
 * then the anchor will "settle" once ttl expires.
 *
 * @module routing/side-channel-detector
 */

const crypto = require('crypto');
const logger = require('../logger');

const TTL_MS = 30 * 60 * 1000;   // 30 min — matches an interactive Claude Code session
const MAX_ENTRIES = 2000;         // LRU cap (same order of magnitude as session-affinity)

/** @type {Map<string, {hash:string, ts:number}>} */
const anchors = new Map();

function _evictIfNeeded() {
  if (anchors.size <= MAX_ENTRIES) return;
  const oldest = anchors.keys().next().value;
  if (oldest !== undefined) anchors.delete(oldest);
}

function _firstUserText(messages) {
  if (!Array.isArray(messages)) return null;
  for (const m of messages) {
    if (m?.role !== 'user') continue;
    if (typeof m.content === 'string') return m.content;
    if (Array.isArray(m.content)) {
      const t = m.content.filter(b => b?.type === 'text').map(b => b.text || '').join('');
      if (t) return t;
    }
  }
  return null;
}

function _hash(str) {
  return crypto.createHash('sha1').update(str).digest('hex').slice(0, 16);
}

/**
 * Check whether the payload's first user message drifts from the cached
 * anchor for this session. Returns true only when we have an anchor AND
 * it disagrees; returns false when no anchor exists yet (bootstrap case)
 * and stores this payload's hash as the new anchor.
 *
 * @param {string|null} sessionId
 * @param {Array} messages
 * @returns {boolean} true if drift detected (caller should treat as side channel)
 */
function check(sessionId, messages) {
  if (!sessionId) return false;
  const text = _firstUserText(messages);
  if (!text) return false;
  const hash = _hash(text);
  const now = Date.now();

  const cached = anchors.get(sessionId);
  if (cached) {
    // Refresh insertion order for LRU
    anchors.delete(sessionId);
    if (now - cached.ts > TTL_MS) {
      // Expired — reset the anchor, no drift claim.
      anchors.set(sessionId, { hash, ts: now });
      _evictIfNeeded();
      return false;
    }
    anchors.set(sessionId, cached);
    if (cached.hash !== hash) {
      logger.debug({ sessionId, cachedHash: cached.hash, newHash: hash },
        '[SideChannel] First-message fingerprint drift');
      return true;
    }
    return false;
  }

  // Bootstrap — first sighting of this session, store and pass.
  anchors.set(sessionId, { hash, ts: now });
  _evictIfNeeded();
  return false;
}

/** Test/maintenance helper — clear the in-memory anchors. */
function _clear() {
  anchors.clear();
}

module.exports = { check, _clear };
