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

// data/ (user-editable, gitignored) wins; config/ is the bundled default —
// data/ is excluded from the npm tarball, so installs load from config/.
const ANCHORS_PATHS = [
  path.join(__dirname, '../../data/difficulty-anchors.json'),
  path.join(__dirname, '../../config/difficulty-anchors.json'),
];
const VECTORS_CACHE_PATH = path.join(__dirname, '../../data/difficulty-anchors.vectors.json');

// Class → representative score. Chosen so each class lands inside a tier
// band and routing boundaries are tunable via tier edges (model-tiers.js).
// Config B (local → GLM → Claude): substantive=MEDIUM/ollama,
// heavyweight=COMPLEX/GLM, frontier=REASONING/Claude.
const CLASS_VALUES = {
  trivial: 10,
  substantive: 45,
  heavyweight: 68,
  frontier: 85,
};

// Softmax temperature over cosine sims. Real inter-class sim gaps on
// nomic-embed-text run ~0.05-0.15, so 0.05 is sharp enough to commit to a
// class when the winner is clear, soft enough to interpolate borderline
// asks instead of cliffing between bands.
const BLEND_TEMPERATURE = 0.05;

// The CLASS is the decision; the blend only positions within the class's
// band — without the clamp, a close runner-up sim leaks trivial asks
// across the band edge.
//
// NOTE: the trivial band [0,25] deliberately overlaps the MEDIUM tier
// (which starts at 20 — see model-tiers.js). Trivial-classified asks whose
// blend lands in the top of the band (20-25) route MEDIUM: RouterArena
// optimality data (2026-07-16) showed cheap-model failures cluster exactly
// there (miss median 23 vs hit median 14). Clamping trivial to [0,19]
// would erase that signal — do not "fix" the mismatch.
const CLASS_BANDS = {
  trivial: [0, 25],
  substantive: [26, 50],
  heavyweight: [51, 75],
  frontier: [76, 100],
};

// Frontier class (REASONING tier) requires minimum similarity — a weak
// topical match can't jump to the expensive tier. Tuned on the validation
// set (scripts/validate-intent-anchors.js). Below this floor, frontier is
// excluded from the blend entirely and scoring behaves like the 3-class
// baseline. Hardcoded constant (no env var per user directive).
const FRONTIER_MIN_SIM = 0.50;

function intentScoreMode() {
  const m = (process.env.LYNKR_INTENT_SCORE_MODE || 'anchor').toLowerCase();
  return m === 'legacy' ? 'legacy' : 'anchor';
}

/**
 * Extract the text the USER actually authored this turn: the latest user
 * message that has real text after stripping harness-injected content.
 * Returns {text:null, index:-1} when there is nothing to score (e.g.
 * tool-result-only turn). Per-message cleaning delegates to jev-router's
 * shared cleaner (wrapper/command tags, line-start unclosed-tag rule,
 * whole-message harness content) so the anchor scorer, the judge and the
 * task ledger all read the same user text.
 */
function _latestUserAsk(payload) {
  const msgs = payload?.messages;
  if (!Array.isArray(msgs)) return { text: null, index: -1 };
  const { cleanUserText } = require('./jev-router');
  for (let i = msgs.length - 1; i >= 0; i--) {
    const msg = msgs[i];
    if (msg?.role !== 'user') continue;
    const text = cleanUserText(msg);
    if (text) return { text, index: i };
    // A user message that was ALL injected content (or all tool_results)
    // doesn't end the search — keep walking back for the real user turn.
  }
  return { text: null, index: -1 };
}

function extractCleanUserText(payload) {
  return _latestUserAsk(payload).text;
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
 * Softmax-blend class sims into a continuous score. Frontier class requires
 * minimum similarity (FRONTIER_MIN_SIM) to participate — below the floor,
 * it's excluded from the blend and scoring behaves like the 3-class baseline.
 * Lexical fallback path stays clamped ≤75 (see _lexicalCleanScore).
 */
function blendScore(sims) {
  // Frontier similarity floor: a weak topical match can't jump tiers.
  const frontierSim = sims.frontier ?? -1;
  const activeSims = { ...sims };
  if (frontierSim < FRONTIER_MIN_SIM) {
    delete activeSims.frontier; // excluded from blend
  }
  const activeClasses = Object.keys(CLASS_VALUES).filter(c => c in activeSims);
  if (activeClasses.length === 0) return CLASS_VALUES.substantive; // degenerate

  const max = Math.max(...activeClasses.map((c) => activeSims[c] ?? -1));
  let totalW = 0;
  let total = 0;
  for (const cls of activeClasses) {
    const w = Math.exp(((activeSims[cls] ?? -1) - max) / BLEND_TEMPERATURE);
    totalW += w;
    total += w * CLASS_VALUES[cls];
  }
  const score = totalW > 0 ? total / totalW : CLASS_VALUES.substantive;
  return Math.round(Math.max(0, Math.min(100, score)));
}

// --- default centroids (lazy singleton, disk-cached) ------------------------

let _centroidsPromise = null;

function _anchorsHash(anchors, model) {
  return crypto.createHash('sha256')
    .update(JSON.stringify(anchors) + '|' + model)
    .digest('hex');
}

async function _loadDefaultCentroids() {
  let anchors = null;
  for (const p of ANCHORS_PATHS) {
    try {
      anchors = JSON.parse(fs.readFileSync(p, 'utf8'));
      break;
    } catch { /* try next path */ }
  }
  if (!anchors) {
    logger.warn('[IntentScore] No difficulty-anchors.json — anchor mode unavailable');
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
// Reconcile anchor's implied tier with the LLM classifier's tier.
// - Agreement → keep anchor score as-is.
// - Classifier lower than anchor → trust classifier (catches embedding
//   false-positives like "list exports" scoring REASONING). Position
//   score at midpoint of classifier's target band. When the verdict was
//   produced WITH conversation_context at confidence < 0.6, the drop is
//   capped at one band below the anchor: background-thread context reads
//   follow-ups as small asks, and a weak context-fed verdict must not
//   collapse a heavyweight anchor to SIMPLE.
// - Classifier higher than anchor → safety-gate: require confidence≥0.3
//   (set 2026-09-22 — see JEV_PROMOTE_CONFIDENCE note)
//   before trusting an escalation to a more expensive tier. Below that,
//   keep the cheaper anchor decision.
function _reconcile(anchorScore, anchorClass, classifierResult, hasContext = false) {
  if (!classifierResult) return { score: anchorScore, reconciled: false };
  // Single 0.3 cut (set 2026-09-22): below it the verdict is noise in both
  // directions. Note this also lets 0.3+ verdicts pull DOWN a band —
  // the price of trusting the judge symmetrically.
  if (classifierResult.confidence < 0.3) return { score: anchorScore, reconciled: false };

  // Anchor class → implied tier (matches model-tiers.js band definitions).
  const anchorTier = anchorScore <= 19 ? 'SIMPLE'
    : anchorScore <= 50 ? 'MEDIUM'
    : anchorScore <= 75 ? 'COMPLEX'
    : 'REASONING';
  const classifierTier = classifierResult.tier;

  if (anchorTier === classifierTier) return { score: anchorScore, reconciled: false };

  const TIER_ORDER = ['SIMPLE', 'MEDIUM', 'COMPLEX', 'REASONING'];
  const anchorIdx = TIER_ORDER.indexOf(anchorTier);
  const classifierIdx = TIER_ORDER.indexOf(classifierTier);

  // Midpoints live in model-tiers.js (single source of truth).
  const { TIER_MIDPOINT } = require('./model-tiers');

  if (classifierIdx < anchorIdx) {
    // Classifier says LOWER tier — trust it. Fixes over-routing.
    if (hasContext && classifierResult.confidence < 0.6) {
      const flooredIdx = Math.max(classifierIdx, anchorIdx - 1);
      return {
        score: TIER_MIDPOINT[TIER_ORDER[flooredIdx]],
        reconciled: flooredIdx > classifierIdx ? 'down_capped' : 'down',
      };
    }
    return { score: TIER_MIDPOINT[classifierTier], reconciled: 'down' };
  }
  // Classifier says HIGHER tier — gate on confidence, and cap the jump at
  // ONE band above the anchor. The classifier is a tiebreaker, not an
  // oracle: qwen2.5:3b's confidence is degenerate (92% of eval answers say
  // 0.9-1.0, incl. every wrong one), so an unbounded jump let a 3B verdict
  // catapult "Who kills him ?" from anchor 25 to 88 → REASONING →
  // subscription passthrough (live incident 2026-07-21). Escalating past
  // the adjacent band now takes consecutive turns that keep re-scoring
  // higher, which is exactly the persistence a genuinely hard conversation
  // exhibits.
  if (classifierResult.confidence >= 0.3) {
    const cappedIdx = Math.min(classifierIdx, anchorIdx + 1);
    return {
      score: TIER_MIDPOINT[TIER_ORDER[cappedIdx]],
      reconciled: cappedIdx < classifierIdx ? 'up_capped' : 'up',
    };
  }
  return { score: anchorScore, reconciled: 'up_gated' };
}

// Memoize the final reconciled score per cleaned text + task identity. The
// classifier leg is live and can time out under load, sending identical text
// down different fallback paths — which made the same turn score differently
// between the router and the pin-drift checker (observed: 63 vs 77 for one
// prompt under suite-wide Ollama contention). First resolution wins for the
// process life. The key carries the task anchor hash and continuation flag:
// the judge's verdict depends on them, so identical text under a different
// task must not share an entry — a text-only key served stale-context scores.
const _scoreMemo = new Map();
const _SCORE_MEMO_MAX = 500;

async function scoreIntent(payload, opts = {}) {
  const mode = opts.mode ?? intentScoreMode();
  if (mode === 'legacy') return null;

  const { text, index: askIdx } = _latestUserAsk(payload);
  if (!text) return null;

  // Only memoize plain calls — opts that alter scoring (custom centroids,
  // embedFn, risk inputs) must not share cache entries.
  const memoizable = !opts.centroids && !opts.embedFn && !opts.forceMatched
    && !opts.riskLevel && !opts.skipClassifier && !opts.priorTurns;

  // Prior-task ledger (messages BEFORE the current ask): names the task for
  // the memo key and feeds the judge's context + flat signals. It never
  // touches the anchor scorer's input — envelope invariance holds.
  let ledger = null;
  if (!opts.skipClassifier) {
    try {
      const { deriveTaskLedger } = require('./task-ledger');
      const msgs = Array.isArray(payload?.messages) ? payload.messages : [];
      ledger = deriveTaskLedger(msgs.slice(0, Math.max(askIdx, 0)));
    } catch { /* ledger unavailable — task-less key, context-free judge */ }
  }

  const memoKey = memoizable
    ? `${text}\0${payload?._taskAnchorHash || ledger?.anchorHash || ''}\0${payload?._isContinuation ? '1' : '0'}`
    : null;
  if (memoizable && _scoreMemo.has(memoKey)) return _scoreMemo.get(memoKey);
  const _memoSet = (result) => {
    if (memoizable && result) {
      if (_scoreMemo.size >= _SCORE_MEMO_MAX) {
        _scoreMemo.delete(_scoreMemo.keys().next().value);
      }
      _scoreMemo.set(memoKey, result);
    }
    return result;
  };

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
        const anchorScore = Math.max(lo, Math.min(hi, blendScore(sims)));

        // Jev routing judge — second opinion. Skipped in tests (opts.skipClassifier)
        // to keep unit tests hermetic (or stubbed via opts.jevFetchFn). Runs live
        // otherwise. Replaces the qwen difficulty classifier in the same result
        // shape ({tier, confidence}) so _reconcile semantics are unchanged;
        // Jev extras (probabilities, risky, model, criteriaHash) ride along
        // for telemetry and the shortfall floor. Fail-soft null preserves the
        // anchor-only path exactly.
        //
        // Hermeticity note: suites asserting deterministic routing scrub
        // TYPESAFE_API_KEY (no key → Jev leg returns null before any fetch),
        // the same posture as the repo's live-Ollama tolerance. Never gate
        // on NODE_ENV — .env pins it to production in every context.
        let classifierResult = null;
        let jevResult = null;
        // Task context (anchor + last ask of the prior-task ledger) so the
        // judge resolves follow-ups. Explicit caller context wins;
        // single-message payloads yield null (unchanged behavior). Tracked
        // out here so _reconcile knows whether the verdict was context-fed.
        let jevContext = typeof payload?._conversationContext === 'string'
          ? payload._conversationContext
          : null;
        if (!opts.skipClassifier) {
          try {
            const { classifyJev } = require('./jev-router');
            let signals = {};
            try {
              const { buildTaskContext, buildJevSignals } = require('./task-ledger');
              if (jevContext === null) jevContext = buildTaskContext(ledger);
              signals = buildJevSignals({
                payload,
                ledger,
                isContinuation: payload?._isContinuation === true,
                inheritedFloorIdx: payload?._inheritedFloorIdx ?? null,
              });
            } catch { /* ledger unavailable — judge runs on bare signals */ }
            jevResult = await classifyJev(text, {
              context: jevContext,
              signals,
              fetchFn: opts.jevFetchFn,
            });
            if (jevResult) {
              classifierResult = { tier: jevResult.tier, confidence: jevResult.confidence };
            }
          } catch (err) {
            logger.debug({ err: err.message }, '[IntentScore] Jev classifier failed — anchor only');
          }
        }

        const { score, reconciled } = _reconcile(anchorScore, cls, classifierResult, !!jevContext);
        if (reconciled) {
          logger.debug({
            text: text.slice(0, 80),
            anchorScore,
            anchorClass: cls,
            classifierTier: classifierResult?.tier,
            classifierConfidence: classifierResult?.confidence,
            reconciled,
            finalScore: score,
          }, '[IntentScore] classifier reconciled anchor score');
        }
        return _memoSet({
          score,
          mode: reconciled ? 'anchor+classifier' : 'anchor',
          class: cls,
          sims,
          text,
          anchorScore,
          classifierTier: classifierResult?.tier ?? null,
          classifierConfidence: classifierResult?.confidence ?? null,
          reconciled,
          // Jev verdict details for telemetry + shortfall floor downstream.
          // Null unless the Jev leg ran (same conditions as classifierResult,
          // plus LRU-cached repeats which still carry the original extras).
          jev: jevResult ? {
            tier: jevResult.tier,
            confidence: jevResult.confidence,
            probabilities: jevResult.probabilities ?? null,
            risky: jevResult.risky ?? null,
            model: jevResult.model ?? null,
            criteriaHash: jevResult.criteriaHash ?? null,
            latencyMs: jevResult.latencyMs ?? null,
            cached: !!jevResult.cached,
          } : null,
        });
      }
    }
  } catch (err) {
    logger.debug({ err: err.message }, '[IntentScore] anchor scoring failed — lexical fallback');
  }

  // Lexical fallback is NOT memoized: it usually means the embedding service
  // was unavailable; pinning it would lock in degraded scores after recovery.
  return { score: _lexicalCleanScore(text), mode: 'lexical', text };
}

module.exports = {
  CLASS_VALUES,
  CLASS_BANDS,
  FRONTIER_MIN_SIM,
  intentScoreMode,
  extractCleanUserText,
  cosine,
  buildCentroids,
  classify,
  blendScore,
  scoreIntent,
  // exposed for the replay script
  getDefaultCentroids,
  // exposed for tests
  _reconcile,
};
