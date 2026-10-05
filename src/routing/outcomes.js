/**
 * Turn-outcome attribution.
 *
 * When request N+1 of a session arrives, it carries evidence about what
 * happened after request N: the assistant reply the client kept, the tool
 * results or terminal output it produced, whether the client retried the
 * identical conversation (parse/schema failure), whether the same command
 * batch was issued again. Combined with what the gateway recorded about
 * request N (provider error, failover, tier fallback), that is enough to
 * classify N's outcome without any model-as-judge.
 *
 * Categories (and whether the MODEL is attributable):
 *   progress        yes   new tool output, no error markers, no repeat
 *   no_progress     yes   same command signature twice with the same output
 *   regression      yes   client retried the identical conversation (parse /
 *                         schema failure) or repeated a failing command batch
 *   provider_error  no    upstream 5xx / timeout / failover / tier fallback
 *   tool_error      no    tool_result is_error or terminal error markers that
 *                         are clearly environmental (command not found, OOM)
 *   missing         no    no following turn (filled by a sweeper)
 *
 * Only attributable outcomes may train the policy (reward pipeline, kNN,
 * bandit). Environment noise never does.
 */
'use strict';

const crypto = require('crypto');

const RING = 8;
const TTL_MS = 6 * 60 * 60 * 1000;
const _sessions = new Map(); // sessionId -> { ts, turns: [] }

const ATTRIBUTABLE = new Set(['progress', 'no_progress', 'regression']);
const ENV_ERROR_RE = /command not found|No such file or directory|Permission denied|Killed|Out of memory|Connection refused|Temporary failure in name resolution|E: Unable to locate package/i;
const RUNTIME_ERROR_RE = /Traceback \(most recent call last\)|SyntaxError|TypeError|ReferenceError|error\[E\d+\]|FAILED|AssertionError|exit code [1-9]/;

function _hash(s) { return crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 16); }
function _text(msg) {
  if (!msg) return '';
  if (typeof msg.content === 'string') return msg.content;
  if (Array.isArray(msg.content)) return msg.content.filter((b) => b && (b.type === 'text' || b.type === 'tool_result')).map((b) => typeof b.text === 'string' ? b.text : (typeof b.content === 'string' ? b.content : JSON.stringify(b.content || ''))).join('\n');
  return '';
}
function _lastIdx(messages, role) { for (let i = messages.length - 1; i >= 0; i--) if (messages[i]?.role === role) return i; return -1; }
function _commandSig(text) {
  const s = text.indexOf('{'), e = text.lastIndexOf('}');
  if (s === -1 || e <= s) return null;
  try {
    const obj = JSON.parse(text.slice(s, e + 1));
    if (obj && Array.isArray(obj.commands)) return _hash(JSON.stringify(obj.commands.map((c) => String(c?.keystrokes ?? '').replace(/\s+/g, ' ').trim())));
  } catch { /* not json */ }
  return null;
}
function _toolResultError(msg) {
  return Array.isArray(msg?.content) && msg.content.some((b) => b && b.type === 'tool_result' && b.is_error === true);
}

function _get(sessionId) {
  const now = Date.now();
  let s = _sessions.get(sessionId);
  if (s && now - s.ts > TTL_MS) { _sessions.delete(sessionId); s = null; }
  if (!s) { s = { ts: now, turns: [] }; _sessions.set(sessionId, s); }
  s.ts = now;
  if (_sessions.size > 20000) { // crude eviction
    const oldest = [..._sessions.entries()].sort((a, b) => a[1].ts - b[1].ts).slice(0, 2000);
    for (const [k] of oldest) _sessions.delete(k);
  }
  return s;
}

/**
 * Classify the previous turn from the incoming request.
 * @param {object} args
 * @param {string} args.sessionId
 * @param {object} args.payload         incoming request (messages)
 * @param {object} [args.prevRecord]    what the gateway recorded about the previous turn:
 *        { statusCode, errorType, failover:boolean, tierFallback:boolean, servedModel, tier }
 * @returns {{ outcome, attributable, evidence, streak }|null}  null when there is no previous turn
 */
function classifyPrevious({ sessionId, payload, prevRecord = null }) {
  const msgs = Array.isArray(payload?.messages) ? payload.messages : [];
  const aIdx = _lastIdx(msgs, 'assistant');
  if (aIdx < 0) return null;
  const lastA = _text(msgs[aIdx]);
  const after = msgs.slice(aIdx + 1).filter((m) => m?.role === 'user');
  const lastU = after.length ? after[after.length - 1] : null;
  const uText = _text(lastU);
  const convHash = _hash(msgs.slice(0, aIdx + 1).map((m) => _text(m)).join('\u0000'));
  const cmdSig = _commandSig(lastA);
  const s = sessionId ? _get(sessionId) : { turns: [] };
  const prev = s.turns.length ? s.turns[s.turns.length - 1] : null;

  let outcome, evidence = {};
  if (prevRecord && (prevRecord.failover || prevRecord.tierFallback || (prevRecord.statusCode && prevRecord.statusCode >= 500) || /timeout|UPSTREAM/i.test(String(prevRecord.errorType || '')))) {
    outcome = 'provider_error'; evidence = { statusCode: prevRecord.statusCode, errorType: prevRecord.errorType, failover: !!prevRecord.failover };
  } else if (!lastU) {
    // Client re-sent the conversation ending in an assistant turn, or no user turn followed yet.
    outcome = 'missing';
  } else if (prev && prev.convHash === convHash && prev.outcome !== 'provider_error') {
    outcome = 'regression'; evidence = { reason: 'identical_conversation_retry' };
  } else if (_toolResultError(lastU) || ENV_ERROR_RE.test(uText)) {
    outcome = 'tool_error'; evidence = { reason: _toolResultError(lastU) ? 'tool_result_is_error' : 'environment_error_marker' };
  } else if (cmdSig && prev && prev.cmdSig === cmdSig) {
    outcome = (prev.outputHash === _hash(uText)) ? 'no_progress' : 'regression';
    evidence = { reason: outcome === 'no_progress' ? 'same_commands_same_output' : 'same_commands_different_output' };
  } else if (RUNTIME_ERROR_RE.test(uText)) {
    outcome = 'regression'; evidence = { reason: 'runtime_error_in_output' };
  } else {
    outcome = 'progress';
  }
  const attributable = ATTRIBUTABLE.has(outcome);
  // Streak of consecutive attributable regressions/no_progress, skipping noise.
  let streak = 0;
  if (attributable && outcome !== 'progress') {
    streak = 1;
    for (let i = s.turns.length - 1; i >= 0; i--) {
      const t = s.turns[i];
      if (!t.attributable) continue;
      if (t.outcome === 'progress') break;
      streak++;
    }
  }
  const rec = { ts: Date.now(), outcome, attributable, evidence, streak, convHash, cmdSig, outputHash: _hash(uText), tier: prevRecord?.tier ?? null, servedModel: prevRecord?.servedModel ?? null };
  if (sessionId) { s.turns.push(rec); if (s.turns.length > RING) s.turns.shift(); }
  return { outcome, attributable, evidence, streak };
}

function ring(sessionId) { return sessionId && _sessions.has(sessionId) ? [..._sessions.get(sessionId).turns] : []; }
/** Reward for the learning loop: null means "do not update" (environment noise). */
function rewardFor(outcome) {
  if (!ATTRIBUTABLE.has(outcome)) return null;
  return outcome === 'progress' ? 1 : outcome === 'no_progress' ? 0.3 : 0;
}
function _clear() { _sessions.clear(); }

module.exports = { classifyPrevious, ring, rewardFor, ATTRIBUTABLE, _clear };
