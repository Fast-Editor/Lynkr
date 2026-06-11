/**
 * Risk Analyzer
 *
 * Scores a request along a risk axis that is orthogonal to complexity.
 * A trivially short edit to `auth/middleware.ts` is still high risk and
 * should not be served by a cheap local model.
 *
 * @module routing/risk-analyzer
 */

const { extractContent } = require('./complexity-analyzer');

// Substring keywords found in file paths or instruction text.
// Matched case-insensitively as raw substrings, so "auth" hits
// "src/auth/login.ts" and "authentication".
// NOTE: keywords are matched as case-insensitive *substrings* against file
// paths, so overly generic terms cause false positives. 'session' and 'token'
// were removed because they match benign paths (src/sessions/*, tokenizer.js,
// token-budget.js) and were force-escalating ordinary requests to COMPLEX —
// real secrets/credentials are still covered by the keywords below.
const PROTECTED_PATH_KEYWORDS = [
  'auth', 'oauth', 'jwt', 'security', 'permission', 'rbac',
  'payment', 'payments', 'billing', 'invoice', 'subscription',
  'migration', 'migrations', 'schema',
  'infra', 'terraform', 'kustomize', 'helm', 'kubernetes',
  '.github/workflows', '.env', 'secret', 'credential',
  'api-key', 'api_key', 'apikey',
  'webhook', 'admin',
];

// Whole-word instruction keywords that signal sensitive intent regardless
// of which files are involved. Higher signal than path keywords because
// they reflect what the user is *asking for*.
const HIGH_RISK_INSTRUCTION_KEYWORDS = [
  'authentication', 'authorization', 'permission', 'security',
  'payment', 'billing', 'migration', 'database schema',
  'encrypt', 'decrypt', 'secret', 'credential', 'api key',
  'production', 'deploy', 'rollout', 'rollback',
];

// Path-extracting patterns. We look at:
//   1. Anything that looks like a file path inside the instruction text.
//   2. Explicit path-like fields in tool inputs (e.g. tool_use blocks).
const PATH_LIKE_RE = /(?:^|[\s`'"([])([./a-zA-Z0-9_-]+\.[a-zA-Z0-9]{1,8})(?=[\s`'")\]:,;]|$)/g;
const SLASHED_PATH_RE = /(?:^|[\s`'"([])((?:[a-zA-Z0-9_.-]+\/)+[a-zA-Z0-9_.-]+)(?=[\s`'")\]:,;]|$)/g;

/**
 * Pull every path-shaped substring out of free-form text.
 * @param {string} text
 * @returns {string[]}
 */
function extractPathsFromText(text) {
  if (!text) return [];
  const out = new Set();
  let m;
  while ((m = PATH_LIKE_RE.exec(text)) !== null) {
    out.add(m[1]);
  }
  while ((m = SLASHED_PATH_RE.exec(text)) !== null) {
    out.add(m[1]);
  }
  return Array.from(out);
}

/**
 * Walk every tool_use block in the conversation and collect any string
 * inputs that look like paths. Catches cases where the model already
 * called an Edit/Read tool on a sensitive file.
 * @param {object} payload
 * @returns {string[]}
 */
function extractPathsFromToolUses(payload) {
  const out = new Set();
  const messages = payload?.messages;
  if (!Array.isArray(messages)) return [];

  for (const msg of messages) {
    if (!Array.isArray(msg?.content)) continue;
    for (const block of msg.content) {
      if (block?.type !== 'tool_use' || !block.input) continue;
      const stack = [block.input];
      while (stack.length) {
        const node = stack.pop();
        if (typeof node === 'string') {
          if (node.includes('/') || node.includes('.')) {
            // Treat short tool-input strings that look path-y as paths.
            if (node.length <= 200) out.add(node);
          }
        } else if (Array.isArray(node)) {
          for (const v of node) stack.push(v);
        } else if (node && typeof node === 'object') {
          for (const v of Object.values(node)) stack.push(v);
        }
      }
    }
  }
  return Array.from(out);
}

/**
 * Find which keywords from `keywords` appear (case-insensitively) inside
 * any of `haystack`. Substring match — by design — so "auth" matches
 * both "src/auth/login.ts" and the word "authorization".
 * @param {string[]} keywords
 * @param {string[]} haystack
 * @returns {string[]} hit keywords, sorted
 */
function findHits(keywords, haystack) {
  const hits = new Set();
  const joined = haystack.join('\n').toLowerCase();
  for (const kw of keywords) {
    if (joined.includes(kw.toLowerCase())) hits.add(kw);
  }
  return Array.from(hits).sort();
}

/**
 * Analyze the risk level of a request.
 *
 * Risk is orthogonal to complexity:
 *   - low    → no protected paths or sensitive keywords detected
 *   - medium → protected paths *or* a read-only task on a protected area
 *   - high   → instruction explicitly names sensitive domain logic,
 *              or protected paths combined with a write-intent task
 *
 * @param {object} payload - Anthropic-format request payload
 * @returns {{ level: 'low'|'medium'|'high',
 *             reason: string,
 *             pathHits: string[],
 *             instructionHits: string[],
 *             paths: string[] }}
 */
function analyzeRisk(payload) {
  const instructionText = extractContent(payload) || '';
  const lowText = instructionText.toLowerCase();

  const textPaths = extractPathsFromText(instructionText);
  const toolPaths = extractPathsFromToolUses(payload);
  const allPaths = Array.from(new Set([...textPaths, ...toolPaths]));

  // Instruction-level hits scan the raw text. Path-level hits scan only
  // the extracted path strings so phrases like "authentication is hard"
  // don't double-fire as a path hit.
  const instructionHits = findHits(HIGH_RISK_INSTRUCTION_KEYWORDS, [instructionText]);
  const pathHits = findHits(PROTECTED_PATH_KEYWORDS, allPaths.length ? allPaths : []);
  // Also let path keywords match against the instruction text — covers
  // "update the auth flow" with no path mentioned.
  const textPathHits = findHits(PROTECTED_PATH_KEYWORDS, [instructionText]);
  const mergedPathHits = Array.from(new Set([...pathHits, ...textPathHits])).sort();

  if (instructionHits.length > 0) {
    return {
      level: 'high',
      reason: 'High-risk instruction keyword detected.',
      pathHits: mergedPathHits,
      instructionHits,
      paths: allPaths,
    };
  }

  if (mergedPathHits.length > 0) {
    // Read-only intent on a protected area is medium, not high.
    // Heuristic: presence of explain/summarize/read verbs.
    const readOnly = /\b(explain|summarize|describe|what does|walk me through|read|show|list|search|find|grep|locate)\b/i.test(lowText);
    if (readOnly) {
      return {
        level: 'medium',
        reason: 'Protected paths involved but task appears read-only.',
        pathHits: mergedPathHits,
        instructionHits: [],
        paths: allPaths,
      };
    }
    return {
      level: 'high',
      reason: 'Protected path referenced with write-capable intent.',
      pathHits: mergedPathHits,
      instructionHits: [],
      paths: allPaths,
    };
  }

  return {
    level: 'low',
    reason: 'No risk signals detected.',
    pathHits: [],
    instructionHits: [],
    paths: allPaths,
  };
}

module.exports = {
  analyzeRisk,
  PROTECTED_PATH_KEYWORDS,
  HIGH_RISK_INSTRUCTION_KEYWORDS,
  // Exposed for tests
  extractPathsFromText,
  extractPathsFromToolUses,
};
