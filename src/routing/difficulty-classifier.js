/**
 * Difficulty classifier — LLM-based 4-way classification of user prompts.
 *
 * WHY THIS EXISTS: The anchor-embedding scorer (intent-score.js) measures
 * *topical* similarity to labeled difficulty exemplars. It confuses "list
 * the exports from this file" (LOW difficulty, technical vocabulary) with
 * hard problems. An LLM reading the actual sentence knows better.
 *
 * DESIGN:
 *  - Uses whatever model is configured for the SIMPLE tier (fetched at call
 *    time via getModelTierSelector). When the user later swaps in a
 *    fine-tuned classifier as SIMPLE, this picks it up automatically.
 *  - Structured JSON output; parse failure → null → caller falls back.
 *  - Hard 2500ms timeout; on timeout → null → caller falls back.
 *  - LRU cache keyed by sha256(text.trim().toLowerCase()); capacity 500.
 *  - Skip conditions surface via classifyDifficulty returning null with
 *    reason=skipped: text.length<15, force-pattern matched, risk=high,
 *    cache hit is transparent (returns cached).
 *  - Hardcoded kill-switch CLASSIFIER_ENABLED — no env var per user policy.
 *
 * Failure modes are all null: anchor+lexical scoring already handles the
 * fallback. This module never blocks routing.
 */

const crypto = require('crypto');
const logger = require('../logger');

const CLASSIFIER_ENABLED = true;
// Thinking models (minimax-m2.5) spend 1-4s in <thinking> before emitting
// JSON — 2.5s is not enough. Raise to 10s and rely on skip conditions +
// LRU cache to keep amortized latency low.
const TIMEOUT_MS = 10000;
const CACHE_CAPACITY = 500;
const MIN_TEXT_LENGTH = 15;

// Classifier model — decoupled from tier serving so SIMPLE tier can run a
// more capable model for real traffic while the classifier stays fast and
// cheap. Chosen 2026-07-19: qwen2.5:3b hit 87.3% hand-labeled accuracy at
// ~500ms warm latency, zero cost-critical over-routes. Replace with your
// fine-tuned classifier when you build one. Hardcoded per user directive
// (no env var).
const CLASSIFIER_PROVIDER = 'ollama';
const CLASSIFIER_MODEL = 'qwen2.5:3b';

const VALID_TIERS = ['SIMPLE', 'MEDIUM', 'COMPLEX', 'REASONING'];

// One-shot classification prompt. Kept in a const so drift is diffable.
// Difficulty framing (not intent) — matches config B routing goals.
const CLASSIFY_PROMPT = `You are a classifier for an LLM routing proxy. Classify the difficulty of the user prompt below into exactly one of four tiers. Reply with ONLY valid JSON on a single line, no other text.

Tiers:
- SIMPLE: casual acknowledgments, greetings, one-word answers, trivial factual lookups. Any tiny model handles.
  examples: "hi", "ok thanks", "yes continue", "what time is it"
- MEDIUM: one specific mechanical task or a focused explanation. Mid-size local model suffices.
  examples: "list the exports from this file", "run the unit tests", "fix the linter warnings", "explain this regex", "add error handling to this block"
- COMPLEX: multi-file design, systemic refactor, architecture review, debugging that requires broad code understanding. Needs a strong general model.
  examples: "architecture review of the orchestrator", "refactor the entire ingestion pipeline", "debug this complex race condition across three services"
- REASONING: formal proof, correctness verification, security audit, novel algorithm design, formal reasoning from first principles. Needs a frontier reasoning model.
  examples: "prove the correctness of this lock-free queue", "security audit the auth middleware", "formally verify this state machine never deadlocks", "derive the optimal eviction policy and prove its competitive ratio"

Reply format (strict): {"tier":"SIMPLE|MEDIUM|COMPLEX|REASONING","confidence":0.0-1.0}

User prompt: `;

// --- LRU cache --------------------------------------------------------------

class LruCache {
  constructor(capacity) {
    this.capacity = capacity;
    this.map = new Map();
  }
  get(key) {
    if (!this.map.has(key)) return undefined;
    const val = this.map.get(key);
    this.map.delete(key);
    this.map.set(key, val); // move to MRU
    return val;
  }
  set(key, val) {
    if (this.map.has(key)) this.map.delete(key);
    else if (this.map.size >= this.capacity) {
      const oldest = this.map.keys().next().value;
      this.map.delete(oldest);
    }
    this.map.set(key, val);
  }
  stats() { return { size: this.map.size, capacity: this.capacity }; }
}

const _cache = new LruCache(CACHE_CAPACITY);

function _cacheKey(text) {
  return crypto.createHash('sha256').update(text.trim().toLowerCase()).digest('hex');
}

// --- Ollama dispatch (only supported provider for the SIMPLE tier today) ----

async function _callOllama(text, opts) {
  const config = require('../config');

  // First cut supports ollama-family classifier only. Other providers can
  // be wired later; today's classifier is qwen2.5:3b on ollama.
  if (CLASSIFIER_PROVIDER !== 'ollama') {
    logger.debug({ provider: CLASSIFIER_PROVIDER, model: CLASSIFIER_MODEL }, '[DifficultyClassifier] non-ollama classifier not yet supported');
    return null;
  }

  const endpoint = config.ollama?.endpoint || 'http://localhost:11434';
  const url = `${endpoint.replace(/\/$/, '')}/api/chat`;
  const body = {
    model: CLASSIFIER_MODEL,
    messages: [{ role: 'user', content: CLASSIFY_PROMPT + '"""' + text + '"""' }],
    stream: false,
    format: 'json',
    // num_predict generous because thinking models (minimax-m2.5) burn
    // budget in message.thinking before producing message.content JSON.
    options: { temperature: 0, num_predict: 512 },
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs || TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const json = await res.json();
    // Thinking models put output in message.thinking; regular in message.content.
    // /api/generate variants use `response`. Try all three, biggest first.
    const candidates = [
      json?.message?.content,
      json?.message?.thinking,
      json?.response,
    ].filter(s => typeof s === 'string' && s.length > 0);
    return candidates.join('\n') || null;
  } catch (err) {
    logger.debug({ err: err.message, textPreview: text.slice(0, 60) }, '[DifficultyClassifier] call failed');
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// --- Parse & validate the model's JSON output -------------------------------

function _parseResult(raw) {
  if (!raw) return null;
  // Ollama with format:'json' usually gives clean JSON, but the model can
  // still surround it with junk — extract the first { ... } span.
  const match = raw.match(/\{[\s\S]*?\}/);
  if (!match) return null;
  let obj;
  try { obj = JSON.parse(match[0]); } catch { return null; }
  const tier = String(obj.tier || '').toUpperCase().trim();
  if (!VALID_TIERS.includes(tier)) return null;
  const rawConf = Number(obj.confidence);
  const confidence = Number.isFinite(rawConf) ? Math.max(0, Math.min(1, rawConf)) : 0.5;
  return { tier, confidence };
}

// --- Public API -------------------------------------------------------------

/**
 * Classify difficulty of user text.
 *
 * @param {string} text — cleaned user prompt
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs] — override default 2500ms
 * @param {boolean} [opts.forceMatched] — caller already matched a FORCE_* pattern; skip classifier
 * @param {string} [opts.riskLevel] — 'high' | 'medium' | 'low'; skip when 'high'
 * @returns {Promise<{tier:string,confidence:number,source:'cache'|'model'}|null>}
 *   null when: disabled, skipped, model failure, parse failure, timeout.
 */
async function classifyDifficulty(text, opts = {}) {
  if (!CLASSIFIER_ENABLED) return null;
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (trimmed.length < MIN_TEXT_LENGTH) return null;
  if (opts.forceMatched) return null;
  if (opts.riskLevel === 'high') return null;

  const key = _cacheKey(trimmed);
  const cached = _cache.get(key);
  if (cached) return { ...cached, source: 'cache' };

  const raw = await _callOllama(trimmed, opts);
  const parsed = _parseResult(raw);
  if (!parsed) return null;
  _cache.set(key, parsed);
  return { ...parsed, source: 'model' };
}

// --- Test helpers -----------------------------------------------------------

function _clearCacheForTests() { _cache.map.clear(); }
function _getCacheStats() { return _cache.stats(); }

// Exposed metadata for the bootstrap module — keeps model choice in one file
// so classifier-setup.js pulls exactly what the classifier will call.
const CLASSIFIER_MODEL_INFO = Object.freeze({
  provider: CLASSIFIER_PROVIDER,
  model: CLASSIFIER_MODEL,
  endpoint: process.env.OLLAMA_ENDPOINT || 'http://localhost:11434',
});

module.exports = {
  classifyDifficulty,
  CLASSIFIER_ENABLED,
  CLASSIFIER_MODEL_INFO,
  VALID_TIERS,
  // internals for tests only
  _parseResult,
  _cacheKey,
  _clearCacheForTests,
  _getCacheStats,
};
