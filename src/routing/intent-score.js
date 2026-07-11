/**
 * WS7 — payload-invariant intent scoring via embedding anchors.
 *
 * The lexical scorer's noise exceeds its band width (same semantic ask
 * measured 31 offline vs 56 live once the payload envelope — tool schemas,
 * history, injected reminders — is attached; paraphrase-only noise is still
 * ±10-12 on a 24-point band). This module replaces the ex-ante difficulty
 * signal with something the evidence supports:
 *
 *   - Score CLEANED USER TEXT ONLY. Tool schemas, conversation history,
 *     <system-reminder> blocks and tool_result payloads never touch the
 *     score. Envelope concerns (agentic detection, context guard, client
 *     profiles) keep their own triggers — they escalate tiers, they don't
 *     inflate this score.
 *   - Classify against embedding centroids built from ~10 REAL session
 *     texts (data/difficulty-anchors.json): {trivial, substantive,
 *     heavyweight}. The query embedding is already computed per request
 *     (WS5.5, nomic-embed-text via local Ollama, cache-backed), so the
 *     three cosine sims cost microseconds and no new I/O.
 *   - Blend sims → a continuous 0-100 score (softmax over class values)
 *     so the existing band mapping, calibration, pins and drift margin all
 *     keep working unchanged.
 *
 * Contracts (tested in test/intent-score.test.js):
 *   - Envelope invariance: score(text) === score(text + schemas + reminders
 *     + history).
 *   - REASONING (76+) is unreachable from text alone — trigger-only
 *     (risk / force phrase / agentic / kNN / tier-fallback). CLASS_VALUES
 *     top out at heavyweight=68 and the lexical fallback clamps at 75.
 *   - embed() failure never throws — falls back to a lexical score of the
 *     SAME cleaned text (still envelope-invariant, just noisier).
 *
 * Escape hatch: LYNKR_INTENT_SCORE_MODE=legacy restores the pre-WS7
 * full-payload lexical score.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const logger = require('../logger');

const ANCHORS_PATH = path.join(__dirname, '../../data/difficulty-anchors.json');
const VECTORS_CACHE_PATH = path.join(__dirname, '../../data/difficulty-anchors.vectors.json');

// Class → representative score. Chosen so each class lands inside an
// existing default band (SIMPLE 0-25, MEDIUM 26-50, COMPLEX 51-75) and the
// blend can NEVER reach REASONING (76+). Calibration may later collapse
// bands into degenerate ranges without touching these.
const CLASS_VALUES = {
  trivial: 10,
  substantive: 45,
  heavyweight: 68,
};

// Softmax temperature over cosine sims. Real inter-class sim gaps on
// nomic-embed-text run ~0.05-0.15, so 0.05 is sharp enough to commit to a
// class when the winner is clear, soft enough to interpolate borderline
// asks instead of cliffing between bands.
const BLEND_TEMPERATURE = 0.05;

// The CLASS is the decision; the blend only positions within the class's
// band — without the clamp, a close runner-up sim leaks trivial asks
// across the band edge. Bands mirror calibration's DEFAULT_RANGES.
const CLASS_BANDS = {
  trivial: [0, 25],
  substantive: [26, 50],
  heavyweight: [51, 75],
};

function intentScoreMode() {
  const m = (process.env.LYNKR_INTENT_SCORE_MODE || 'anchor').toLowerCase();
  return m === 'legacy' ? 'legacy' : 'anchor';
}

/**
 * Extract the text the USER actually authored this turn: the latest user
 * message that has real text after stripping harness-injected content.
 * Returns null when there is nothing to score (e.g. tool-result-only turn).
 */
function extractCleanUserText(payload) {
  const msgs = payload?.messages;
  if (!Array.isArray(msgs)) return null;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const msg = msgs[i];
    if (msg?.role !== 'user') continue;
    let text = null;
    if (typeof msg.content === 'string') {
      text = msg.content;
    } else if (Array.isArray(msg.content)) {
      text = msg.content
        .filter((b) => b?.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text)
        .join(' ');
    }
    if (text == null) continue;
    text = text
      .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
      // Harness task/background-agent notifications — not user-authored.
      .replace(/<task-notification>[\s\S]*?<\/task-notification>/g, '')
      // Lynkr's own injected notices (quota banners, badges) start with the
      // [Lynkr] marker — the user didn't type those.
      .replace(/^\s*\[Lynkr\][^\n]*$/gm, '')
      .trim();
    // Whole-message harness content: compaction/continuation summaries and
    // system notifications arrive as user-role messages the user never
    // typed. Treat as empty and keep walking back.
    if (/^\s*(\[SYSTEM NOTIFICATION|<conversation[\s>]|<session[\s>]|\[Request interrupted|This session is being continued from a previous conversation)/i.test(text)) {
      // Continuation summaries PARAPHRASE the prior session, so they carry
      // force-phrase vocabulary the user typed hours ago.
      text = '';
    }
    if (text) return text;
    // A user message that was ALL injected content (or all tool_results)
    // doesn't end the search — keep walking back for the real user turn.
  }
  return null;
}

function cosine(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom > 0 ? dot / denom : 0;
}

/**
 * Embed every anchor text and mean them per class.
 * @param {Object<string,string[]>} anchorsByClass
 * @param {(text:string)=>Promise<number[]|null>} embedFn
 * @returns {Promise<Object<string,number[]>|null>} null if any class has no vectors
 */
async function buildCentroids(anchorsByClass, embedFn) {
  const centroids = {};
  for (const [cls, texts] of Object.entries(anchorsByClass)) {
    if (cls.startsWith('_') || !Array.isArray(texts)) continue;
    const vectors = [];
    for (const t of texts) {
      try {
        const v = await embedFn(t);
        if (Array.isArray(v) && v.length > 0) vectors.push(v);
      } catch { /* embed never throws by contract, belt-and-braces */ }
    }
    if (vectors.length === 0) return null; // a class with no anchors is unusable
    const dim = vectors[0].length;
    const mean = new Array(dim).fill(0);
    for (const v of vectors) for (let i = 0; i < dim; i++) mean[i] += v[i] / vectors.length;
    centroids[cls] = mean;
  }
  return Object.keys(centroids).length === Object.keys(CLASS_VALUES).length ? centroids : null;
}

/**
 * Cosine sims against each class centroid.
 * @returns {{cls:string, sims:Object<string,number>}}
 */
function classify(embedding, centroids) {
  const sims = {};
  let best = null;
  for (const cls of Object.keys(CLASS_VALUES)) {
    const c = centroids[cls];
    sims[cls] = Array.isArray(c) ? cosine(embedding, c) : -1;
    if (best === null || sims[cls] > sims[best]) best = cls;
  }
  return { cls: best, sims };
}

/**
 * Softmax-blend class sims into a continuous score. Bounded by construction
 * to [min(CLASS_VALUES), max(CLASS_VALUES)] — REASONING stays unreachable.
 */
function blendScore(sims) {
  const classes = Object.keys(CLASS_VALUES);
  const max = Math.max(...classes.map((c) => sims[c] ?? -1));
  let totalW = 0;
  let total = 0;
  for (const cls of classes) {
    const w = Math.exp(((sims[cls] ?? -1) - max) / BLEND_TEMPERATURE);
    totalW += w;
    total += w * CLASS_VALUES[cls];
  }
  const score = totalW > 0 ? total / totalW : CLASS_VALUES.substantive;
  return Math.round(Math.max(0, Math.min(75, score)));
}

// --- default centroids (lazy singleton, disk-cached) ------------------------

let _centroidsPromise = null;

function _anchorsHash(anchors, model) {
  return crypto.createHash('sha256')
    .update(JSON.stringify(anchors) + '|' + model)
    .digest('hex');
}

async function _loadDefaultCentroids() {
  let anchors;
  try {
    anchors = JSON.parse(fs.readFileSync(ANCHORS_PATH, 'utf8'));
  } catch (err) {
    logger.warn({ err: err.message }, '[IntentScore] No difficulty-anchors.json — anchor mode unavailable');
    return null;
  }
  const config = require('../config');
  const model = config.ollama?.embeddingsModel || 'unknown';
  const hash = _anchorsHash(anchors, model);

  // Disk cache: survives Ollama being down at boot.
  try {
    const cached = JSON.parse(fs.readFileSync(VECTORS_CACHE_PATH, 'utf8'));
    if (cached?.hash === hash && cached.centroids) {
      logger.debug('[IntentScore] Anchor centroids loaded from disk cache');
      return cached.centroids;
    }
  } catch { /* no cache yet */ }

  const { getKnnRouter } = require('./knn-router');
  const router = getKnnRouter();
  const centroids = await buildCentroids(anchors, (t) => router.embed(t));
  if (!centroids) {
    logger.warn('[IntentScore] Anchor embedding failed (Ollama down?) — lexical fallback until next attempt');
    return null;
  }
  try {
    fs.writeFileSync(VECTORS_CACHE_PATH, JSON.stringify({ hash, model, centroids }));
  } catch (err) {
    logger.debug({ err: err.message }, '[IntentScore] Could not persist centroid cache');
  }
  logger.info({ classes: Object.keys(centroids) }, '[IntentScore] Anchor centroids built');
  return centroids;
}

function getDefaultCentroids() {
  if (!_centroidsPromise) {
    _centroidsPromise = _loadDefaultCentroids().catch((err) => {
      logger.warn({ err: err.message }, '[IntentScore] Centroid load failed');
      return null;
    });
    // A failed load should retry on the next request, not stick forever.
    _centroidsPromise.then((c) => { if (!c) _centroidsPromise = null; });
  }
  return _centroidsPromise;
}

/**
 * Lexical fallback: the OLD scorer's content dimensions, but fed ONLY the
 * cleaned user text (fresh single-message payload — no tools, no history),
 * so it stays envelope-invariant. Clamped below the REASONING band.
 */
function _lexicalCleanScore(text) {
  const { calculateWeightedScore } = require('./complexity-analyzer');
  const minimal = { messages: [{ role: 'user', content: text }] };
  const { score } = calculateWeightedScore(minimal, text);
  return Math.max(0, Math.min(75, Math.round(score)));
}

/**
 * Score the user's intent for this turn.
 *
 * @param {object} payload — full request payload (only cleaned user text is used)
 * @param {object} [opts]
 * @param {(text:string)=>Promise<number[]|null>} [opts.embedFn] — injected for tests
 * @param {Object<string,number[]>} [opts.centroids] — injected for tests
 * @param {string} [opts.mode] — 'anchor' | 'legacy' (default: env LYNKR_INTENT_SCORE_MODE)
 * @returns {Promise<{score:number, mode:'anchor'|'lexical', class?:string, sims?:object, text:string}|null>}
 *   null → caller keeps its legacy score (legacy mode, or nothing to score)
 */
async function scoreIntent(payload, opts = {}) {
  const mode = opts.mode ?? intentScoreMode();
  if (mode === 'legacy') return null;

  const text = extractCleanUserText(payload);
  if (!text) return null;

  try {
    const centroids = opts.centroids !== undefined ? opts.centroids : await getDefaultCentroids();
    if (centroids) {
      let embedFn = opts.embedFn;
      if (!embedFn) {
        const { getKnnRouter } = require('./knn-router');
        const router = getKnnRouter();
        embedFn = (t) => router.embed(t);
      }
      const embedding = await embedFn(text);
      if (Array.isArray(embedding) && embedding.length > 0) {
        const { cls, sims } = classify(embedding, centroids);
        const [lo, hi] = CLASS_BANDS[cls];
        const score = Math.max(lo, Math.min(hi, blendScore(sims)));
        return { score, mode: 'anchor', class: cls, sims, text };
      }
    }
  } catch (err) {
    logger.debug({ err: err.message }, '[IntentScore] anchor scoring failed — lexical fallback');
  }

  return { score: _lexicalCleanScore(text), mode: 'lexical', text };
}

module.exports = {
  CLASS_VALUES,
  intentScoreMode,
  extractCleanUserText,
  cosine,
  buildCentroids,
  classify,
  blendScore,
  scoreIntent,
  // exposed for the replay script
  getDefaultCentroids,
};
