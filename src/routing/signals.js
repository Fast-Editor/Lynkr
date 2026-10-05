/**
 * Signal registry for declarative routing.
 *
 * A signal is a pure function of the request context that returns
 *   { matched: boolean, value: any, confidence: number|null, detail?: object }
 * Signals never route; decisions (decisions.js) combine them. Every evaluator
 * fails open: an exception yields { matched:false, value:null, error }.
 *
 * Context (ctx): { payload, analysis, legacy:{tier,provider,model}, risk,
 *                  agenticResult, sessionId, prevTurns:[] }
 */
'use strict';

const logger = require('../logger');
const rc = require('./routing-config');

const TIER_PRI = { SIMPLE: 1, MEDIUM: 2, COMPLEX: 3, REASONING: 4 };

function _text(msg) {
  if (!msg) return '';
  if (typeof msg.content === 'string') return msg.content;
  if (Array.isArray(msg.content)) return msg.content.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n');
  return '';
}
function _lastOfRole(messages, role) {
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i]?.role === role) return messages[i];
  return null;
}
function _hasToolResult(msg) {
  return Array.isArray(msg?.content) && msg.content.some((b) => b && b.type === 'tool_result');
}
function _completionClaim(text) {
  return /"is_task_complete"\s*:\s*true/.test(text) || /\b(task (is )?complete|all done|completed successfully)\b/i.test(text);
}

const EVALUATORS = {
  anchor_score(ctx) {
    const v = ctx.analysis?.anchorScore ?? ctx.analysis?.score ?? null;
    if (!Number.isFinite(v)) return { matched: false, value: null, confidence: null };
    return { matched: true, value: v, confidence: null, band: rc.anchorBandFor(v) };
  },
  jev(ctx, opt) {
    const j = ctx.analysis?.jev;
    if (!j || !j.tier) return { matched: false, value: null, confidence: null };
    const minC = Number.isFinite(opt.min_confidence) ? opt.min_confidence : 0;
    return { matched: (j.confidence ?? 0) >= minC, value: j.tier, confidence: j.confidence ?? null, tier: j.tier, probabilities: j.probabilities || null, risky: j.risky ?? null };
  },
  harness(ctx) {
    const { harnessAskFromPayload } = require('./harness-envelope');
    const ask = harnessAskFromPayload(ctx.payload);
    return ask ? { matched: true, value: ask.name || 'harness', confidence: 1, detail: { instruction: ask.text.slice(0, 200) } } : { matched: false, value: null, confidence: null };
  },
  request_field(ctx, opt) {
    const keys = Array.isArray(opt.any_of) ? opt.any_of : [];
    const hit = keys.find((k) => ctx.payload && ctx.payload[k] !== undefined && ctx.payload[k] !== null);
    return hit ? { matched: true, value: hit, confidence: 1 } : { matched: false, value: null, confidence: null };
  },
  tool_count(ctx) {
    const n = Array.isArray(ctx.payload?.tools) ? ctx.payload.tools.length : 0;
    return { matched: n > 0, value: n, confidence: 1 };
  },
  session_turn(ctx) {
    const msgs = Array.isArray(ctx.payload?.messages) ? ctx.payload.messages : [];
    const n = msgs.filter((m) => m?.role === 'assistant').length;
    return { matched: n > 0, value: n, confidence: 1 };
  },
  session_phase(ctx) {
    const msgs = Array.isArray(ctx.payload?.messages) ? ctx.payload.messages : [];
    const assistants = msgs.filter((m) => m?.role === 'assistant');
    if (assistants.length === 0) return { matched: true, value: 'planning', confidence: 0.9 };
    const lastA = _text(_lastOfRole(msgs, 'assistant'));
    const lastU = _lastOfRole(msgs, 'user');
    if (_completionClaim(lastA)) return { matched: true, value: 'done', confidence: 0.8 };
    if (/\b(pytest|npm test|go test|make test|verify|check that|assert)\b/i.test(lastA)) return { matched: true, value: 'verification', confidence: 0.6 };
    if (_hasToolResult(lastU) || /\$ |root@|Traceback|error:/i.test(_text(lastU))) return { matched: true, value: 'tool_loop', confidence: 0.7 };
    return { matched: true, value: 'tool_loop', confidence: 0.4 };
  },
  risk(ctx) {
    const lvl = ctx.risk?.level || null;
    return { matched: lvl === 'high', value: lvl, confidence: ctx.risk?.score ?? null };
  },
  keyword(ctx, opt) {
    const terms = Array.isArray(opt.terms) ? opt.terms : [];
    if (!terms.length) return { matched: false, value: null, confidence: null };
    const { harnessAskFromPayload } = require('./harness-envelope');
    const ask = harnessAskFromPayload(ctx.payload);
    const text = (ask ? ask.text : _text(_lastOfRole(ctx.payload?.messages || [], 'user'))).toLowerCase();
    const method = opt.method || 'any';
    const hits = terms.filter((t) => opt.regex ? new RegExp(t, 'i').test(text) : text.includes(String(t).toLowerCase()));
    if (method === 'all') return { matched: hits.length === terms.length, value: hits, confidence: hits.length / terms.length };
    const thr = Number.isFinite(opt.min_hits) ? opt.min_hits : 1;
    return { matched: hits.length >= thr, value: hits, confidence: terms.length ? hits.length / terms.length : 0 };
  },
  legacy_tier(ctx) {
    const t = ctx.legacy?.tier || null;
    return { matched: !!t, value: t, confidence: 1 };
  },
  prev_outcome(ctx) {
    const last = Array.isArray(ctx.prevTurns) && ctx.prevTurns.length ? ctx.prevTurns[ctx.prevTurns.length - 1] : null;
    if (!last) return { matched: false, value: null, confidence: null };
    return { matched: true, value: last.outcome, confidence: 1, attributable: !!last.attributable, streak: last.streak ?? null };
  },
};

/** Evaluate every configured signal once. Returns { name: result }. */
async function evaluateAll(ctx, config) {
  const cfg = config || rc.load();
  const out = {};
  for (const [name, def] of Object.entries(cfg.signals || {})) {
    const fn = EVALUATORS[def.type];
    if (!fn) { out[name] = { matched: false, value: null, confidence: null, error: `unknown type ${def.type}` }; continue; }
    try {
      const r = await fn(ctx, def);
      out[name] = { matched: !!r.matched, value: r.value ?? null, confidence: r.confidence ?? null, ...r };
    } catch (err) {
      logger.debug({ signal: name, err: err.message }, '[Signals] evaluator failed — treated as unmatched');
      out[name] = { matched: false, value: null, confidence: null, error: err.message };
    }
  }
  return out;
}

/** Condition test used by the decision engine. */
function testCondition(cond, signals) {
  const s = signals[cond.signal];
  if (!s) return false;
  // Default semantics: a condition on a signal requires that signal to have
  // matched (e.g. a judge below min_confidence must not satisfy tier_in).
  if (cond.matched === undefined ? !s.matched : (!!s.matched !== !!cond.matched)) return false;
  if (cond.equals !== undefined && s.value !== cond.equals) return false;
  if (Array.isArray(cond.in) && !cond.in.includes(s.value)) return false;
  if (Array.isArray(cond.band_in) && !cond.band_in.includes(s.band)) return false;
  if (Array.isArray(cond.tier_in) && !cond.tier_in.includes(s.tier ?? s.value)) return false;
  if (Number.isFinite(cond.min) && !(Number(s.value) >= cond.min)) return false;
  if (Number.isFinite(cond.max) && !(Number(s.value) <= cond.max)) return false;
  if (Number.isFinite(cond.min_confidence) && !((s.confidence ?? 0) >= cond.min_confidence)) return false;
  if (cond.min_tier && !((TIER_PRI[s.tier ?? s.value] || 0) >= (TIER_PRI[cond.min_tier] || 0))) return false;
  return true;
}

module.exports = { EVALUATORS, evaluateAll, testCondition, TIER_PRI };
