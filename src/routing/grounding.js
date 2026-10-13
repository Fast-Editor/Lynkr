/**
 * Grounding check for completion claims (HaluGate-style, local NLI).
 *
 * When a reply claims the task is done, check whether the evidence the model
 * had — the most recent tool output / terminal snapshot — supports that claim.
 * A small NLI cross-encoder (default Xenova/nli-deberta-v3-small, int8, CPU,
 * ~25 ms per pair) labels each claim entailment / neutral / contradiction.
 *
 *   verdict: 'supported' | 'unverified' | 'contradicted' | 'skipped'
 *
 * Policy is per decision (routing.json → decisions[].plugins.grounding):
 *   { mode: "observe" | "flag" | "veto", contradiction_threshold: 0.6 }
 * observe: telemetry only; flag: + X-Lynkr-Grounding header; veto: caller
 * re-asks once with the contradiction quoted (not enabled anywhere yet).
 *
 * The transformers runtime is loaded lazily from LYNKR_NLI_LIB_PATH or the
 * normal module path; if absent the module reports 'skipped' and never
 * throws. Model files cache under LYNKR_MODELS_DIR (default ~/lynkr-models/hf).
 */
'use strict';

const os = require('os');
const path = require('path');
const logger = require('../logger');

const MODEL_ID = process.env.LYNKR_NLI_MODEL || 'Xenova/nli-deberta-v3-small';
const MAX_EVIDENCE_CHARS = 4000;
const MAX_CLAIM_CHARS = 400;
let _loading = null; // Promise<{tok, model, labels}> | null
let _unavailable = false;

function _lib() {
  const p = process.env.LYNKR_NLI_LIB_PATH;
  try { return p ? require(path.join(p, '@huggingface', 'transformers')) : require('@huggingface/transformers'); } catch { return null; }
}

async function _load() {
  if (_unavailable) return null;
  if (_loading) return _loading;
  _loading = (async () => {
    const tf = _lib();
    if (!tf) { _unavailable = true; logger.warn('[Grounding] @huggingface/transformers not available — grounding disabled'); return null; }
    tf.env.cacheDir = process.env.LYNKR_MODELS_DIR || path.join(os.homedir(), 'lynkr-models', 'hf');
    tf.env.allowLocalModels = true;
    const t0 = Date.now();
    const tok = await tf.AutoTokenizer.from_pretrained(MODEL_ID);
    const model = await tf.AutoModelForSequenceClassification.from_pretrained(MODEL_ID, { dtype: process.env.LYNKR_NLI_DTYPE || 'q8' });
    const labels = Object.fromEntries(Object.entries(model.config.id2label || {}).map(([i, l]) => [Number(i), String(l).toLowerCase()]));
    logger.info({ model: MODEL_ID, ms: Date.now() - t0 }, '[Grounding] NLI model loaded');
    return { tf, tok, model, labels };
  })().catch((err) => { _unavailable = true; logger.warn({ err: err.message }, '[Grounding] model load failed — grounding disabled'); return null; });
  return _loading;
}

/** Pull completion-bearing claims out of a reply (structured agents and prose). */
function extractClaims(replyText) {
  if (typeof replyText !== 'string' || !replyText.trim()) return { claimsDone: false, claims: [] };
  const s = replyText.indexOf('{'), e = replyText.lastIndexOf('}');
  if (s !== -1 && e > s) {
    try {
      const obj = JSON.parse(replyText.slice(s, e + 1));
      if (obj && typeof obj === 'object' && 'is_task_complete' in obj) {
        const claims = [];
        for (const k of ['state_analysis', 'explanation', 'summary', 'result']) if (typeof obj[k] === 'string' && obj[k].trim()) claims.push(obj[k].trim().slice(0, MAX_CLAIM_CHARS));
        return { claimsDone: obj.is_task_complete === true, claims };
      }
    } catch { /* fall through to prose */ }
  }
  const done = /\b(task (is )?(now )?complete|completed successfully|all (tests )?pass(ed)?|successfully (created|written|installed|fixed)|is now (working|fixed|done))\b/i.test(replyText);
  const sentences = replyText.split(/(?<=[.!?])\s+/).filter((x) => /\b(complete|done|pass|success|written|created|fixed|installed|verified)\b/i.test(x)).slice(0, 4).map((x) => x.trim().slice(0, MAX_CLAIM_CHARS));
  return { claimsDone: done, claims: sentences };
}

/** Evidence = the last user-turn text (tool results / terminal output), tail-truncated. */
function extractEvidence(messages) {
  if (!Array.isArray(messages)) return '';
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]; if (m?.role !== 'user') continue;
    let t = '';
    if (typeof m.content === 'string') t = m.content;
    else if (Array.isArray(m.content)) t = m.content.map((b) => typeof b?.text === 'string' ? b.text : (b?.type === 'tool_result' ? (typeof b.content === 'string' ? b.content : JSON.stringify(b.content || '')) : '')).join('\n');
    if (t.trim()) return t.length > MAX_EVIDENCE_CHARS ? t.slice(-MAX_EVIDENCE_CHARS) : t;
  }
  return '';
}

/**
 * @returns {Promise<{verdict, claimsDone, pairs:[{claim, entailment, neutral, contradiction}], maxContradiction, minEntailment, ms}>}
 */
async function check({ replyText, messages, evidence = null, onlyWhenDone = true, threshold = 0.6 }) {
  const t0 = Date.now();
  const { claimsDone, claims } = extractClaims(replyText);
  if (onlyWhenDone && !claimsDone) return { verdict: 'skipped', reason: 'no_completion_claim', claimsDone, pairs: [], ms: Date.now() - t0 };
  const ev = evidence != null ? String(evidence) : extractEvidence(messages);
  if (!ev.trim()) return { verdict: 'unverified', reason: 'no_evidence', claimsDone, pairs: [], ms: Date.now() - t0 };
  if (!claims.length) return { verdict: 'unverified', reason: 'no_claims', claimsDone, pairs: [], ms: Date.now() - t0 };
  const rt = await _load();
  if (!rt) return { verdict: 'skipped', reason: 'nli_unavailable', claimsDone, pairs: [], ms: Date.now() - t0 };
  const pairs = [];
  for (const claim of claims) {
    const inputs = rt.tok(ev, { text_pair: claim, truncation: true, max_length: 512 });
    const out = await rt.model(inputs);
    const probs = rt.tf.softmax(Array.from(out.logits.data));
    const row = { claim };
    for (const [i, l] of Object.entries(rt.labels)) row[l] = Math.round(probs[i] * 1000) / 1000;
    pairs.push(row);
  }
  const maxContradiction = Math.max(...pairs.map((p) => p.contradiction || 0));
  const minEntailment = Math.min(...pairs.map((p) => p.entailment || 0));
  const anyEntail = pairs.some((p) => (p.entailment || 0) >= 0.5);
  const verdict = maxContradiction >= threshold ? 'contradicted' : (anyEntail ? 'supported' : 'unverified');
  return { verdict, claimsDone, pairs, maxContradiction, minEntailment, ms: Date.now() - t0 };
}

function available() { return !_unavailable && !!_lib(); }
function warm() { return _load(); }

module.exports = { check, extractClaims, extractEvidence, available, warm, MODEL_ID };
