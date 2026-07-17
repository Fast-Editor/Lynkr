/**
 * WS6 — response verifier for cascade routing.
 *
 * Judges whether a CHEAP-tier response is good enough to serve, so the
 * cascade can discard bad answers and escalate instead of delivering them.
 * Rationale (deep-research, 2026-07-08): ex-ante difficulty prediction
 * failed to beat trivial baselines on agentic coding traffic (SWE-Bench),
 * while try-cheap-then-verify cascades gained up to 14%. The verifier is
 * where that gain lives.
 *
 * Design constraints:
 *   - Layer 1: deterministic structural checks targeting the cheap-model
 *     failure modes observed live — language drift (CJK mid-English),
 *     degeneration loops, truncation, malformed tool calls, empty/echo
 *     output. High precision: flag only what is definitely broken.
 *   - Layer 2: a coarse content-quality score with a conservative
 *     threshold. Catches low-effort responses to substantive asks.
 *   - No LLM-judge in v1 (research: unvalidated self-assessment is weak),
 *     no logprobs (Ollama's Anthropic passthrough doesn't expose them).
 *     A confidently-wrong but fluent answer WILL pass — the target is
 *     garbage, not falsehood.
 *   - Pure function, no I/O. Never throws: any internal error returns
 *     verdict "pass" (fail-open — a broken verifier must not break
 *     serving or force spurious escalations).
 *
 * Verification only ever applies to cheap-tier responses; expensive-tier
 * answers are never second-guessed (caller enforces).
 */

const logger = require('../logger');

// ---------------------------------------------------------------------------
// Text extraction
// ---------------------------------------------------------------------------

function _responseText(responseBody) {
  const content = responseBody?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b?.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n');
}

function _lastUserText(payload) {
  const msgs = payload?.messages;
  if (!Array.isArray(msgs)) return '';
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m?.role !== 'user') continue;
    const raw = typeof m.content === 'string'
      ? m.content
      : Array.isArray(m.content)
        ? m.content.filter((b) => b?.type === 'text').map((b) => b.text || '').join(' ')
        : '';
    return raw
      .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, ' ')
      // Codex harness blocks merged into the typed text — inflate askLen
      // and trip the wants-code regexes ("claude-code", access="write"),
      // failing every short answer to a trivial prompt.
      .replace(/<environment_context>[\s\S]*?<\/environment_context>/g, ' ')
      .replace(/<user_instructions>[\s\S]*?<\/user_instructions>/g, ' ')
      // Goose wraps every typed message in a turn-context block (time, cwd,
      // todo notes) — 275+ chars of harness plumbing that made a bare "Hi"
      // look like a substantive ask, failing every short cheap-tier answer.
      .replace(/<turn-context>[\s\S]*?<\/turn-context>/g, ' ')
      .trim();
  }
  return '';
}

// ---------------------------------------------------------------------------
// Layer 1 — structural checks (each returns a reason string or null)
// ---------------------------------------------------------------------------

/**
 * Language drift: unexpected CJK/Cyrillic content in a conversation whose
 * user text contains none. Live incident: minimax emitting "+统一接口:" in
 * the middle of an English refactor plan. Threshold is a RATIO so quoting
 * a foreign identifier from the repo doesn't trip it.
 */
function checkLanguageDrift(userText, answerText) {
  if (!answerText) return null;
  const FOREIGN = /[一-鿿぀-ヿ가-힯Ѐ-ӿ]/g;
  const userForeign = (userText.match(FOREIGN) || []).length;
  if (userForeign > 0) return null; // user writes that script — anything goes
  const answerForeign = (answerText.match(FOREIGN) || []).length;
  if (answerForeign === 0) return null;
  const ratio = answerForeign / Math.max(1, answerText.length);
  // A couple of quoted characters is fine; sustained drift is not.
  if (answerForeign >= 6 || ratio > 0.02) {
    return `language-drift (${answerForeign} foreign chars, user text had none)`;
  }
  return null;
}

/**
 * Degeneration: the same shingle repeating far beyond what natural text
 * (or even a list) produces. Catches small-model repetition loops.
 */
function checkDegeneration(answerText) {
  if (!answerText || answerText.length < 200) return null;
  const words = answerText.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length < 40) return null;
  const SHINGLE = 5;
  const counts = new Map();
  for (let i = 0; i + SHINGLE <= words.length; i++) {
    const key = words.slice(i, i + SHINGLE).join(' ');
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  let max = 0;
  for (const c of counts.values()) if (c > max) max = c;
  const total = Math.max(1, words.length - SHINGLE + 1);
  if (max >= 5 && max / total > 0.08) {
    return `degeneration (a 5-gram repeats ${max}× across ${total} positions)`;
  }
  return null;
}

/**
 * Truncation: response ran into max_tokens mid-structure. A length stop
 * by itself is common (long answers); a length stop with an UNCLOSED code
 * fence means the useful part is cut.
 */
function checkTruncation(answerText, responseBody) {
  if (responseBody?.stop_reason !== 'max_tokens' && responseBody?.stop_reason !== 'length') return null;
  const fences = (answerText.match(/```/g) || []).length;
  if (fences % 2 === 1) {
    return 'truncation (hit token limit inside an open code fence)';
  }
  return null;
}

/**
 * Malformed tool calls: tool_use blocks whose input is not an object or
 * whose name is missing. Live symptom: Claude Code's "Invalid tool
 * parameters" errors on cheap-model responses.
 */
function checkMalformedToolCalls(responseBody) {
  const content = responseBody?.content;
  if (!Array.isArray(content)) return null;
  for (const b of content) {
    if (b?.type !== 'tool_use') continue;
    if (!b.name || typeof b.name !== 'string') return 'malformed-tool-call (missing name)';
    if (b.input === undefined || b.input === null || typeof b.input !== 'object' || Array.isArray(b.input)) {
      return `malformed-tool-call (input is ${Array.isArray(b.input) ? 'array' : typeof b.input})`;
    }
  }
  return null;
}

/** Empty or echo output. */
function checkEmptyOrEcho(userText, answerText, responseBody) {
  const hasToolUse = Array.isArray(responseBody?.content)
    && responseBody.content.some((b) => b?.type === 'tool_use');
  if (hasToolUse) return null; // tool-only turns legitimately carry no prose
  const t = (answerText || '').trim();
  if (t.length < 2) return 'empty-response';
  if (userText.length > 40 && t.length > 40) {
    const a = t.toLowerCase().slice(0, 200);
    const u = userText.toLowerCase().slice(0, 200);
    if (a === u) return 'prompt-echo';
  }
  return null;
}

// ---------------------------------------------------------------------------
// Layer 2 — coarse content-quality score
// ---------------------------------------------------------------------------

/**
 * 0-100. Conservative: only very low scores fail (threshold below).
 * Signals: effort proportional to the ask, structure when structure was
 * requested, code when code was requested.
 */
function contentScore(userText, answerText, responseBody) {
  const hasToolUse = Array.isArray(responseBody?.content)
    && responseBody.content.some((b) => b?.type === 'tool_use');
  if (hasToolUse) return 100; // agent turns are judged by their tool calls, not prose

  let score = 60; // neutral prior
  const askLen = userText.length;
  const ansLen = (answerText || '').length;

  // Effort: a substantive ask answered in a stub.
  if (askLen > 200 && ansLen < 60) score -= 35;
  else if (askLen > 100 && ansLen < 30) score -= 30;
  else if (ansLen >= 120) score += 15;

  // Structure requested → structure delivered?
  const wantsStructure = /\b(list|steps?|plan|compare|table|pros and cons|trade-?offs)\b/i.test(userText);
  const hasStructure = /(^|\n)\s*([-*•]|\d+[.)])\s+|\n#{1,3}\s|\|.*\|/.test(answerText || '');
  if (wantsStructure) score += hasStructure ? 15 : -20;

  // Code requested → code delivered?
  const wantsCode = /\b(code|function|implement|snippet|example|replacement|fix)\b/i.test(userText)
    && /```/.test(userText || '') === false; // asking about pasted code still often warrants code back — keep loose
  const hasCode = /```|(^|\n) {4}\S/.test(answerText || '');
  if (wantsCode && /\b(write|implement|show|give me)\b/i.test(userText)) {
    score += hasCode ? 10 : -15;
  }

  return Math.max(0, Math.min(100, score));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

const CONTENT_SCORE_FAIL_THRESHOLD = 30;

/**
 * @param {object} args
 * @param {object} args.payload      — the request payload
 * @param {object} args.responseBody — Anthropic-format response body
 * @returns {{verdict: 'pass'|'fail', score: number|null, reasons: string[]}}
 */
function verify({ payload, responseBody } = {}) {
  try {
    // No body / unrecognizable content shape = nothing to verify (upstream
    // error paths have their own handling). Verification judges answers,
    // not absences or shapes we don't understand.
    if (!responseBody || typeof responseBody !== 'object') {
      return { verdict: 'pass', score: null, reasons: [] };
    }
    const c = responseBody.content;
    if (typeof c !== 'string' && !Array.isArray(c)) {
      return { verdict: 'pass', score: null, reasons: [] };
    }
    const userText = _lastUserText(payload);
    const answerText = _responseText(responseBody);

    const reasons = [
      checkLanguageDrift(userText, answerText),
      checkDegeneration(answerText),
      checkTruncation(answerText, responseBody),
      checkMalformedToolCalls(responseBody),
      checkEmptyOrEcho(userText, answerText, responseBody),
    ].filter(Boolean);

    const score = contentScore(userText, answerText, responseBody);
    if (reasons.length === 0 && score < CONTENT_SCORE_FAIL_THRESHOLD) {
      reasons.push(`low-content-score (${score} < ${CONTENT_SCORE_FAIL_THRESHOLD})`);
    }

    return { verdict: reasons.length ? 'fail' : 'pass', score, reasons };
  } catch (err) {
    // Fail-open: a broken verifier must never block serving.
    logger.debug({ err: err.message }, '[Verifier] error — failing open');
    return { verdict: 'pass', score: null, reasons: [] };
  }
}

module.exports = {
  verify,
  CONTENT_SCORE_FAIL_THRESHOLD,
  // exported for unit tests
  _internal: {
    checkLanguageDrift,
    checkDegeneration,
    checkTruncation,
    checkMalformedToolCalls,
    checkEmptyOrEcho,
    contentScore,
  },
};
