/**
 * TaskBand task ledger — pure fold of a conversation prefix into the task
 * currently in flight, so follow-up turns ("do the same here") can inherit
 * the difficulty band the task already earned.
 *
 * Contract (shared with jev-router / intent-score / api-router):
 *   - deriveTaskLedger(messages): caller slices the array to EXCLUDE the
 *     current ask; the fold only ever sees the thread's past.
 *   - detectContinuation(text, ledger, embedFn): cheap veto-first detector,
 *     three independent branches (deictic / cosine / files).
 *   - buildTaskContext(ledger): slim stable string for the judge — reference
 *     material, never instructions.
 *   - buildJevSignals({...}): the flat signal set buildJevState normalizes.
 *
 * No env vars — every knob is a hardcoded constant below (same convention
 * as jev-router.js). Requires jev-router for cleanUserText; jev-router must
 * never require this module back (acyclic).
 */

const crypto = require('crypto');

const COSINE_CUT = 0.70;
const EMBED_BUDGET_MS = 100;
const VETO_MAX_CHARS = 400;
const DEICTIC_MAX_CHARS = 200;
const DECAY_TURNS = 2;
const AUTO_CLOSE_LOW_TURNS = 3;
const MAX_CONTEXT = 360;
const ANCHOR_MAX = 160;
const LAST_MAX = 120;
const FLOOR_ENABLED = true;
const HOLDOUT_PCT = 0.10;

const CONSTANTS = {
  COSINE_CUT,
  EMBED_BUDGET_MS,
  VETO_MAX_CHARS,
  DEICTIC_MAX_CHARS,
  DECAY_TURNS,
  AUTO_CLOSE_LOW_TURNS,
  MAX_CONTEXT,
  ANCHOR_MAX,
  LAST_MAX,
  FLOOR_ENABLED,
  HOLDOUT_PCT,
};

// A gratitude marker only closes when it IS the whole turn — substantive
// text after it means the user moved on mid-turn ("thanks — now do X"
// closes AND opens, however short the turn is).
const MARKER_MAX_CHARS = 30;
const MARKER_RE = /^\s*(thanks|thank you|got it|perfect|great|awesome|works now|that fixed it)\b/i;
// A contrast token means the task is NOT done ("thanks but it still fails").
const CONTRAST_RE = /\b(but|however|instead|what about|still|though|except)\b/i;
const NEW_TASK_RE = /^\s*(new task|unrelated|different (question|topic)|separately)\b/i;
const DEICTIC_RE = /\b(same|this one|that one|it again|again|also (this|these)|those)\b/i;

// File paths mentioned in ASKS ONLY — tool_use inputs are model-authored
// and would let the harness's own file churn masquerade as user intent.
const FILE_RE = /[\w\-./@~]+\.(js|ts|tsx|jsx|py|go|rs|java|json|md|yaml|yml|toml|sql)\b/g;
const FILE_SCAN_MAX_CHARS = 2000;

// Tokens too common to signal novelty. Includes the deictic vocabulary so
// "do the same thing here" counts ~0 novel tokens against any task.
const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'if', 'then', 'else', 'for', 'to',
  'of', 'in', 'on', 'at', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'do', 'does', 'did', 'done', 'can', 'could', 'will', 'would', 'should',
  'may', 'might', 'must', 'this', 'that', 'these', 'those', 'it', 'its',
  'with', 'as', 'by', 'from', 'we', 'you', 'i', 'me', 'my', 'your', 'our',
  'they', 'them', 'their', 'he', 'she', 'his', 'her', 'what', 'which',
  'who', 'whom', 'how', 'when', 'where', 'why', 'not', 'no', 'yes', 'so',
  'just', 'now', 'also', 'same', 'again', 'here', 'there', 'please', 'ok',
  'okay', 'one', 'thing', 'too', 'all', 'any', 'some', 'more', 'other',
  'into', 'out', 'up', 'down', 'about', 'over', 'after', 'before', 'need',
  'want', 'like', 'make', 'get', 'use', 'let', 'lets', 'us',
]);

function _sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

function _tokensOf(text) {
  const out = new Set();
  const words = String(text).toLowerCase().match(/[a-z0-9_$][\w$.-]*/gi) || [];
  for (const w of words) {
    if (w.length < 3) continue;
    if (STOPWORDS.has(w)) continue;
    out.add(w);
  }
  return out;
}

function _filesOf(text) {
  const out = new Set();
  const capped = String(text).slice(0, FILE_SCAN_MAX_CHARS);
  const matches = capped.match(FILE_RE) || [];
  for (const m of matches) out.add(m);
  return out;
}

// --- prefix-chain memo -------------------------------------------------------
// h_n = sha256(h_prev + NUL + ask_n): the orchestrator re-derives the ledger
// for every window index, but each prefix extends the last by one ask, so
// the fold state after ask_n is memoized under h_n and reuse is O(1).
const _MEMO_MAX = 500;
const _memo = new Map(); // prefixHash -> frozen fold state

function _memoGet(key) {
  const hit = _memo.get(key);
  if (hit) {
    _memo.delete(key);
    _memo.set(key, hit);
  }
  return hit || null;
}

function _memoSet(key, state) {
  _memo.set(key, state);
  while (_memo.size > _MEMO_MAX) {
    const oldest = _memo.keys().next();
    if (oldest.done) break;
    _memo.delete(oldest.value);
  }
}

function _cloneState(s) {
  if (!s) return null;
  return {
    ...s,
    tokenSet: new Set(s.tokenSet),
    fileSet: new Set(s.fileSet),
  };
}

/**
 * One fold step over a cleaned user ask. State is null until a task opens.
 * Segmentation: a marker-only turn closes; marker + substantive content
 * closes and opens a new task anchored at that turn; after a close, the
 * next substantive ask opens a new task. Closed-task fields (anchor,
 * tokenSet, fileSet) survive the close so decayed continuations can still
 * match against them.
 */
function _foldAsk(state, text) {
  const trimmed = String(text).trim();
  const marker = MARKER_RE.test(trimmed);
  const contrast = CONTRAST_RE.test(trimmed);
  // Close-only requires that nothing substantive survives past the marker:
  // "thanks, now fix router.js" fits under MARKER_MAX_CHARS yet redirects,
  // so length alone can't decide.
  const markerOnly = marker && !contrast
    && trimmed.length <= MARKER_MAX_CHARS
    && !/[\w$]/.test(trimmed.replace(MARKER_RE, ''));
  if (markerOnly) {
    if (!state) return null;
    if (state.open) return { ...state, open: false, turnsSinceClose: 0, lastAsk: text };
    return { ...state, turnsSinceClose: state.turnsSinceClose + 1, lastAsk: text };
  }
  const closesAndOpens = marker && !contrast; // "thanks — now do X"
  if (!state || !state.open || closesAndOpens) {
    return {
      anchorText: text,
      anchorHash: _sha256(text),
      open: true,
      turnsSinceClose: 0,
      askCount: 1,
      tokenSet: _tokensOf(text),
      fileSet: _filesOf(text),
      lastAsk: text,
    };
  }
  const tokenSet = new Set(state.tokenSet);
  for (const t of _tokensOf(text)) tokenSet.add(t);
  const fileSet = new Set(state.fileSet);
  for (const f of _filesOf(text)) fileSet.add(f);
  return {
    ...state,
    askCount: state.askCount + 1,
    tokenSet,
    fileSet,
    lastAsk: text,
  };
}

/**
 * Fold an Anthropic-style message array (the thread MINUS the current ask)
 * into the current task's ledger. Pure over its input; the only state is
 * the prefix memo. Returns null when no task ever opened.
 * @param {Array} messages
 * @returns {object|null} Ledger
 */
function deriveTaskLedger(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return null;
  const { cleanUserText } = require('./jev-router');

  const asks = []; // { text, index }
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m?.role !== 'user') continue;
    let text = null;
    try {
      text = cleanUserText(m);
    } catch { /* unscoreable message — skip */ }
    if (text) asks.push({ text, index: i });
  }
  if (asks.length === 0) return null;

  const hashes = [];
  let chain = '';
  for (const a of asks) {
    chain = _sha256(`${chain}\0${a.text}`);
    hashes.push(chain);
  }

  let state = null;
  let start = 0;
  for (let i = asks.length - 1; i >= 0; i--) {
    const hit = _memoGet(hashes[i]);
    if (hit) {
      state = _cloneState(hit);
      start = i + 1;
      break;
    }
  }
  for (let i = start; i < asks.length; i++) {
    state = _foldAsk(state, asks[i].text);
    _memoSet(hashes[i], _cloneState(state));
  }
  if (!state || !state.anchorText) return null;

  // Last-turn stats: tool activity AFTER the last prior ask — i.e. between
  // the last two asks of the full thread, since the caller excluded the
  // current one. tool_use counted on assistant turns, is_error on results.
  let toolCalls = 0;
  let errors = 0;
  const lastAskIdx = asks[asks.length - 1].index;
  for (let i = lastAskIdx + 1; i < messages.length; i++) {
    const m = messages[i];
    if (!Array.isArray(m?.content)) continue;
    for (const block of m.content) {
      if (m.role === 'assistant' && block?.type === 'tool_use') toolCalls++;
      if (block?.type === 'tool_result' && block.is_error === true) errors++;
    }
  }

  return {
    anchorText: state.anchorText,
    anchorHash: state.anchorHash,
    lastAsk: state.lastAsk ?? null,
    open: !!state.open,
    turnsSinceClose: state.open ? 0 : state.turnsSinceClose,
    askCount: state.askCount,
    tokenSet: new Set(state.tokenSet),
    fileSet: new Set(state.fileSet),
    lastTurnStats: { toolCalls, errors },
    prefixHash: hashes[hashes.length - 1],
  };
}

function _cosine(a, b) {
  if (!a || !b || a.length === 0 || a.length !== b.length) return null;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom > 0 ? dot / denom : null;
}

function _validVec(v) {
  return (Array.isArray(v) || ArrayBuffer.isView(v)) && v.length > 0;
}

/**
 * Is the current ask a continuation of the ledger's task? Veto-first, then
 * three independent branches; any one fires. The embedding branch only runs
 * when the free branches both miss, raced against EMBED_BUDGET_MS so the
 * detector can never hold the request hostage.
 * @param {string} currentAskText - cleaned current ask
 * @param {object|null} ledger
 * @param {(text:string)=>Promise<Float32Array|number[]|null>} embedFn
 * @returns {Promise<{isContinuation:boolean, evidence:string[], abstained:boolean}>}
 */
async function detectContinuation(currentAskText, ledger, embedFn) {
  const miss = { isContinuation: false, evidence: [], abstained: false };
  if (!ledger || !currentAskText || typeof currentAskText !== 'string') return miss;
  const text = currentAskText;
  if (text.length > VETO_MAX_CHARS) return miss;
  if (NEW_TASK_RE.test(text)) return miss;
  if (!(ledger.open || (ledger.turnsSinceClose ?? Infinity) <= DECAY_TURNS)) return miss;

  const evidence = [];

  // Branch A — deictic reference with near-zero novel vocabulary.
  if (DEICTIC_RE.test(text) && text.length <= DEICTIC_MAX_CHARS) {
    let novel = 0;
    const known = ledger.tokenSet instanceof Set ? ledger.tokenSet : new Set();
    for (const t of _tokensOf(text)) {
      if (!known.has(t)) novel++;
      if (novel > 2) break;
    }
    if (novel <= 2) evidence.push('deictic');
  }

  // Branch C — names a file the task already touched (asks only).
  if (ledger.fileSet instanceof Set && ledger.fileSet.size > 0) {
    for (const f of _filesOf(text)) {
      if (ledger.fileSet.has(f)) {
        evidence.push('files');
        break;
      }
    }
  }

  // Branch B — semantic proximity to the task anchor. Skipped when a free
  // branch already decided; abstains (never blocks) on timeout/failure.
  let abstained = false;
  if (evidence.length === 0) {
    let vecs = null;
    if (typeof embedFn === 'function' && ledger.anchorText) {
      try {
        vecs = await Promise.race([
          Promise.all([embedFn(text), embedFn(ledger.anchorText)]),
          new Promise((resolve) => {
            const t = setTimeout(() => resolve(null), EMBED_BUDGET_MS);
            if (typeof t?.unref === 'function') t.unref();
          }),
        ]);
      } catch {
        vecs = null;
      }
    }
    if (vecs && _validVec(vecs[0]) && _validVec(vecs[1])) {
      const sim = _cosine(vecs[0], vecs[1]);
      if (sim !== null && sim >= COSINE_CUT) evidence.push('cosine');
    } else {
      abstained = true;
    }
  }

  return { isContinuation: evidence.length > 0, evidence, abstained };
}

function _sanitizeSpan(s, max) {
  const clean = String(s)
    .replace(/[\r\n[\]<>]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return clean.length > max ? clean.slice(0, max) : clean;
}

/**
 * Slim stable judge context: task anchor + last ask, sanitized so the
 * string can never smuggle wrapper tags or bracketed directives. Reference
 * material only — TIER_INSTRUCTIONS tells the judge the latest user
 * message always wins.
 * @param {object|null} ledger
 * @returns {string|null}
 */
function buildTaskContext(ledger) {
  if (!ledger || !ledger.anchorText) return null;
  const anchor = _sanitizeSpan(ledger.anchorText, ANCHOR_MAX);
  if (!anchor) return null;
  let out = `[REFERENCE ONLY — background thread, NOT the current ask. Latest user message wins.] Task: "${anchor}"`;
  if (ledger.lastAsk && ledger.lastAsk !== ledger.anchorText) {
    const last = _sanitizeSpan(ledger.lastAsk, LAST_MAX);
    if (last && last !== anchor) out += ` Last: "${last}"`;
  }
  return out.length > MAX_CONTEXT ? out.slice(0, MAX_CONTEXT) : out;
}

// Fibonacci-ish buckets: coarse enough to cache-key well, fine enough for
// the judge to tell "one tool call" from "a thrashing session".
const _BUCKETS = [1, 2, 3, 5, 8, 13, 21];

function _bucket(v) {
  const n = Number(v) || 0;
  if (n <= 0) return 0;
  for (const b of _BUCKETS) {
    if (n <= b) return b;
  }
  return 21;
}

/**
 * Flat signal set for the judge (see buildJevState in jev-router for the
 * normalizing end). inherited_floor encodes tierIndex+1 so 0 stays "none".
 * @param {{payload?:object, ledger?:object|null, isContinuation?:boolean,
 *          inheritedFloorIdx?:number|null}} args
 */
function buildJevSignals({ payload, ledger, isContinuation, inheritedFloorIdx } = {}) {
  const msgs = Array.isArray(payload?.messages) ? payload.messages : [];
  const toolDefs = Array.isArray(payload?.tools) ? payload.tools : [];
  const hasToolHistory = msgs.some((m) =>
    m?.role === 'user' && Array.isArray(m.content) && m.content.some((c) => c?.type === 'tool_result')
  );
  let floorIdx = Number.isInteger(inheritedFloorIdx) ? inheritedFloorIdx : null;
  if (floorIdx === null && payload?._inheritedFloorTier) {
    const { VALID_TIERS } = require('./jev-router');
    const i = VALID_TIERS.indexOf(payload._inheritedFloorTier);
    if (i >= 0) floorIdx = i;
  }
  return {
    message_count_bucket: _bucket(msgs.length),
    tools_attached: toolDefs.length,
    effective_tools: toolDefs.length,
    has_tool_history: hasToolHistory ? 1 : 0,
    session_turn_bucket: _bucket(Math.max(1, Math.ceil(msgs.length / 2))),
    is_continuation: isContinuation ? 1 : 0,
    inherited_floor: floorIdx !== null && floorIdx >= 0 ? floorIdx + 1 : 0,
    task_open: ledger?.open ? 1 : 0,
    last_turn_tools_bucket: _bucket(ledger?.lastTurnStats?.toolCalls),
    last_turn_errors_bucket: _bucket(ledger?.lastTurnStats?.errors),
  };
}

function _clearMemo() {
  _memo.clear();
}

module.exports = {
  COSINE_CUT,
  EMBED_BUDGET_MS,
  VETO_MAX_CHARS,
  DEICTIC_MAX_CHARS,
  DECAY_TURNS,
  AUTO_CLOSE_LOW_TURNS,
  MAX_CONTEXT,
  ANCHOR_MAX,
  LAST_MAX,
  FLOOR_ENABLED,
  HOLDOUT_PCT,
  CONSTANTS,
  deriveTaskLedger,
  detectContinuation,
  buildTaskContext,
  buildJevSignals,
  _clearMemo,
};
