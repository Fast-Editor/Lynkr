/**
 * Auth-mode classifier — JS port of Headroom's `headroom/proxy/auth_mode.py`.
 *
 * Three modes:
 *
 *   - 'payg'         — Pay-as-you-go API key. Aggressive lossy compression OK.
 *   - 'oauth'        — Bearer OAuth (Bedrock SigV4, Codex/Cursor JWT, Vertex
 *                      ADC, etc.). Same mutation policy as PAYG — those
 *                      providers don't fingerprint the request body for
 *                      anti-abuse. NOT to be confused with subscription
 *                      OAuth: see below.
 *   - 'subscription' — A UX-bound CLI/IDE session backed by a flat-fee
 *                      subscription (Claude Pro/Max via Claude Code, Cursor
 *                      logged in via Cursor's auth, GitHub Copilot CLI, etc.).
 *                      Stealth mode: passthrough byte-for-byte, never mutate
 *                      the system prompt or frozen-prefix messages.
 *
 * Decision precedence (most specific signal wins):
 *
 *   1. Subscription User-Agent prefix → 'subscription'.
 *      A `claude-code/2.1.195` UA tells us this is a subscription-bound
 *      client even if the token shape would otherwise look like PAYG.
 *      Anthropic anti-abuse fingerprints the *client*, not just the token.
 *
 *   2. `Authorization: Bearer sk-ant-oat-…` → 'oauth'.
 *      Claude Pro/Max OAuth Access Token, but not detected as a subscription
 *      CLI in step 1 (e.g., a custom script using the token). Still
 *      passthrough-prefer to be safe.
 *
 *   3. `Authorization: Bearer sk-ant-api…` or `Bearer sk-…` → 'payg'.
 *      Anthropic / OpenAI / generic API key.
 *
 *   4. `Authorization: Bearer <jwt>` (3 dot-separated segments) → 'oauth'.
 *      Codex / Cursor / Copilot OAuth JWT.
 *
 *   5. `Authorization` present but not `Bearer …` → 'oauth'.
 *      AWS SigV4 (`AWS4-HMAC-SHA256 …`) for Bedrock, etc.
 *
 *   6. `x-api-key` or `x-goog-api-key` header → 'payg'.
 *
 *   7. Default → 'payg' (the safe default: aggressive compression on a
 *      misclassified request just costs a re-run, not a revoked
 *      subscription).
 *
 * Pure function. No I/O. No side effects. Safe to call from the hot path.
 *
 * @module auth-mode
 */

const SUBSCRIPTION_UA_PREFIXES = [
  'claude-cli/',
  'claude-code/',
  'codex-cli/',
  'cursor/',
  'claude-vscode/',
  'github-copilot/',
  'anthropic-cli/',
  'antigravity/',
];

/**
 * Case-insensitive header read, returning '' on miss.
 */
function getHeader(headers, name) {
  if (!headers) return '';
  const lower = name.toLowerCase();
  // Express lowercases header keys; check both forms defensively.
  const v = headers[lower] ?? headers[name];
  if (v == null) return '';
  if (Array.isArray(v)) return String(v[0] || '');
  return String(v);
}

/**
 * Classify the auth mode of an inbound request from its headers.
 *
 * @param {object} headers - Request headers map (express req.headers, dict, etc.)
 * @returns {'payg' | 'oauth' | 'subscription'}
 */
function classifyAuthMode(headers) {
  // 1. Subscription UA wins over token shape.
  const ua = getHeader(headers, 'user-agent').toLowerCase();
  if (ua) {
    for (const prefix of SUBSCRIPTION_UA_PREFIXES) {
      if (ua.includes(prefix)) return 'subscription';
    }
  }

  // 2-5. Authorization header.
  const auth = getHeader(headers, 'authorization');
  if (auth.startsWith('Bearer ')) {
    const token = auth.slice('Bearer '.length);
    // Order matters: check OAuth Access Token prefix before generic sk-.
    if (token.startsWith('sk-ant-oat')) return 'oauth';
    if (token.startsWith('sk-ant-api') || token.startsWith('sk-')) return 'payg';
    // JWT: header.payload.signature
    if (token.split('.').length >= 3) return 'oauth';
    // Unknown bearer shape — fall through to default.
  } else if (auth) {
    // Authorization present but not Bearer — most commonly AWS SigV4 for
    // Bedrock, or Basic for a custom proxy chain. Treat as OAuth.
    return 'oauth';
  }

  // 6. Vendor API-key headers.
  if (getHeader(headers, 'x-api-key')) return 'payg';
  if (getHeader(headers, 'x-goog-api-key')) return 'payg';

  // 7. Default.
  return 'payg';
}

module.exports = {
  classifyAuthMode,
  SUBSCRIPTION_UA_PREFIXES,
};
