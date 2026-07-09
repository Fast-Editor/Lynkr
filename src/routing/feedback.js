/**
 * WS5.3 — feedback loop.
 *
 * Every routing decision produces an outcome (quality, cost, latency,
 * status, error). Historically the bandit's `update()` was a dead export
 * and `reward-pipeline.js` had no importer at all — the ML pipeline was
 * built but never trained. This module closes that loop:
 *
 *   1. Compute the reward from the outcome (`reward-pipeline`).
 *   2. If the decision came from a bandit pick, feed the reward back with
 *      the same context vector the bandit saw (`bandit.update`).
 *   3. If we captured the query embedding at decision time and the outcome
 *      is conclusive (quality ≥ 70 or ≤ 40), add the entry to the kNN
 *      index for online growth.
 *
 * Contracts:
 *   - `recordOutcome()` NEVER throws. Every failure is swallowed into the
 *     degradation registry so we never poison the response path.
 *   - Work runs on `setImmediate` — the caller is invoking this from the
 *     hot path right after `telemetry.record(...)`.
 *   - Missing / partial routing metadata is acceptable: the function
 *     records what it can and skips what it can't.
 */

const logger = require('../logger');
const degradation = require('./degradation');
const { getRewardPipeline } = require('./reward-pipeline');
const { getBandit } = require('./bandit');
const { getKnnRouter } = require('./knn-router');

// Quality thresholds for kNN online growth. Above HIGH → positive exemplar;
// below LOW → negative exemplar. The mid-band is intentionally excluded to
// avoid polluting the index with ambiguous cases.
const KNN_POSITIVE_QUALITY = 70;
const KNN_NEGATIVE_QUALITY = 40;

/**
 * @param {object} args
 * @param {object} args.routingResult — the decision returned by
 *   `determineProviderSmart` (or `pickTierByIntent` — see call sites in
 *   src/clients/databricks.js). Only underscored internals are consumed.
 * @param {object} args.body — the original request body (unused today but
 *   accepted so future signals — user id, workspace, task id — can be
 *   threaded without a signature change).
 * @param {object} args.outcome — {qualityScore, costUsd, latencyMs,
 *   statusCode, errorType, wasFallback}.
 * @returns {void}
 */
function recordOutcome(args) {
  // Never trust the caller's shape. Any non-object gets silently dropped —
  // the response path is not the place to surface a caller bug.
  const safeArgs = (args && typeof args === 'object') ? args : {};
  setImmediate(() => {
    try {
      _recordOutcomeSync(safeArgs);
    } catch (err) {
      // Absolute last-resort guard. Every sub-call inside _recordOutcomeSync
      // already has its own try/catch → degradation.record(...); this catch
      // exists so a truly unexpected throw (e.g. degradation itself blowing
      // up) can never leak.
      try { degradation.record('feedback', err); } catch (_) { /* nope */ }
    }
  });
}

function _recordOutcomeSync({ routingResult, outcome }) {
  if (!routingResult || !outcome) return;

  const {
    qualityScore = null,
    costUsd = null,
    latencyMs = null,
  } = outcome;

  let reward = null;
  try {
    const pipeline = getRewardPipeline();
    reward = pipeline.reward({
      quality: qualityScore,
      cost: costUsd ?? 0,
      latency: latencyMs ?? 0,
    });
  } catch (err) {
    degradation.record('feedback', err);
    reward = null;
  }

  // Bandit update — only when the decision actually came from a bandit pick
  // (i.e. we stashed the context vector on the decision). Without ctx, an
  // update would be meaningless: LinUCB's A/b matrices require the same
  // feature vector the arm was scored on.
  if (routingResult._banditContext
      && routingResult.provider
      && routingResult.model
      && routingResult.tier
      && typeof reward === 'number') {
    try {
      const bandit = getBandit();
      bandit.update(
        routingResult.tier,
        routingResult.provider,
        routingResult.model,
        routingResult._banditContext,
        reward,
      );
    } catch (err) {
      degradation.record('feedback', err);
    }
  }

  // kNN online growth — conclusive quality only. We paid for the embedding
  // at decision time (stashed on `_queryEmbedding`), so add() is essentially
  // free. Skipping the mid-band (40 < q < 70) keeps the index from filling
  // up with ambiguous exemplars that would only muddy future advice.
  if (routingResult._queryEmbedding
      && typeof qualityScore === 'number'
      && (qualityScore >= KNN_POSITIVE_QUALITY || qualityScore <= KNN_NEGATIVE_QUALITY)) {
    try {
      const router = getKnnRouter();
      router.add(routingResult._queryEmbedding, {
        query: routingResult._queryText ?? null,
        provider: routingResult.provider,
        model: routingResult.model,
        tier: routingResult.tier,
        quality: qualityScore,
        cost: costUsd ?? 0,
        latency: latencyMs ?? 0,
        // A negative exemplar is worth recording so future queries whose
        // neighbours are these bad outcomes score poorly. The router's
        // score function already blends quality naturally; no separate
        // "polarity" flag is needed.
      });
    } catch (err) {
      degradation.record('feedback', err);
    }
  }

  if (reward != null) {
    logger.debug({
      reward: reward.toFixed(2),
      tier: routingResult.tier,
      provider: routingResult.provider,
      model: routingResult.model,
      hasBandit: !!routingResult._banditContext,
      hasEmbedding: !!routingResult._queryEmbedding,
      qualityScore,
    }, '[Feedback] Outcome recorded');
  }
}

module.exports = {
  recordOutcome,
  // Test-only export so unit tests can drive the sync path directly.
  _recordOutcomeSync,
  KNN_POSITIVE_QUALITY,
  KNN_NEGATIVE_QUALITY,
};
