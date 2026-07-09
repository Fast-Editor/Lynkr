/**
 * Risk classifier (Phase 3.4).
 *
 * Replaces the regex-based risk-analyzer with a small logistic-regression
 * model trained on TF-IDF of unigrams + bigrams. Bootstrap labels come from
 * the existing regex matcher; subsequent training uses telemetry-flagged
 * outcomes (set the request header `x-lynkr-risk-confirmed: true` to mark a
 * request as truly risky for training).
 *
 * Falls back to the existing regex analyzer when no model artifact is present
 * at data/risk-classifier.json. Model weights are JSON-serializable so they
 * load fast and can be diffed in PRs.
 */

const fs = require('fs');
const path = require('path');
const logger = require('../logger');
const { analyzeRisk: regexAnalyzeRisk, stripSystemReminders } = require('./risk-analyzer');

const MODEL_PATH = path.join(__dirname, '../../data/risk-classifier.json');
const DECISION_THRESHOLD = 0.5;

let _model = null;
let _modelLoaded = false;

function _tokenize(text) {
  if (!text || typeof text !== 'string') return [];
  return text.toLowerCase().split(/[^a-z0-9_\-/.]+/).filter(Boolean);
}

function _features(text) {
  const tokens = _tokenize(text);
  const out = new Map();
  for (let i = 0; i < tokens.length; i++) {
    out.set(tokens[i], (out.get(tokens[i]) || 0) + 1);
    if (i + 1 < tokens.length) {
      const bigram = `${tokens[i]} ${tokens[i + 1]}`;
      out.set(bigram, (out.get(bigram) || 0) + 1);
    }
  }
  return out;
}

function _loadModel() {
  if (_modelLoaded) return _model;
  _modelLoaded = true;
  try {
    if (!fs.existsSync(MODEL_PATH)) return null;
    const raw = JSON.parse(fs.readFileSync(MODEL_PATH, 'utf8'));
    if (!raw?.weights || !raw?.bias) return null;
    _model = raw;
    return _model;
  } catch (err) {
    logger.debug({ err: err.message }, '[RiskClassifier] Model load failed');
    return null;
  }
}

function _sigmoid(z) {
  if (z >= 0) return 1 / (1 + Math.exp(-z));
  const ez = Math.exp(z);
  return ez / (1 + ez);
}

function _predict(text, model) {
  const feats = _features(text);
  let z = model.bias;
  for (const [tok, count] of feats) {
    const w = model.weights[tok];
    if (typeof w === 'number') z += w * count;
  }
  return _sigmoid(z);
}

/**
 * Drop-in replacement for analyzeRisk(payload).
 * Returns { level: 'low'|'medium'|'high', score, ...regexHits } so it's
 * compatible with the existing telemetry pipeline.
 */
function analyzeRisk(payload) {
  // Always run the regex analyzer for hit details (kept for telemetry).
  const regexResult = regexAnalyzeRisk(payload);

  const model = _loadModel();
  if (!model) return regexResult;

  // Build the text we feed to the classifier: latest user message + system
  // fingerprint. Harness-injected <system-reminder> blocks are stripped for
  // the same reason as in the regex analyzer — their boilerplate contains
  // risk keywords ("authentication", "credential") the user never typed.
  let text = '';
  if (Array.isArray(payload?.messages)) {
    for (let i = payload.messages.length - 1; i >= 0; i--) {
      const msg = payload.messages[i];
      if (msg?.role === 'user') {
        if (typeof msg.content === 'string') text = msg.content;
        else if (Array.isArray(msg.content)) {
          text = msg.content.filter(b => b?.type === 'text').map(b => b.text).join(' ');
        }
        break;
      }
    }
  }
  text = stripSystemReminders(text);
  if (typeof payload?.system === 'string') text += ' ' + payload.system;

  const prob = _predict(text, model);
  let level;
  if (prob >= 0.75) level = 'high';
  else if (prob >= DECISION_THRESHOLD) level = 'medium';
  else level = 'low';

  // Reconcile with regex: if classifier disagrees with regex by a lot, prefer the stricter signal.
  // (We never want to *downgrade* a regex-flagged high-risk request silently.)
  if (regexResult?.level === 'high' && level !== 'high') level = 'high';

  return {
    ...regexResult,
    level,
    score: prob,
    classifierUsed: true,
  };
}

function reloadModel() {
  _modelLoaded = false;
  _model = null;
}

module.exports = {
  analyzeRisk,
  reloadModel,
  _internal: { _features, _predict },
};
