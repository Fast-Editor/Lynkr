/**
 * Off-policy evaluation (ROUTING-NOTES §3 + §4.10.3).
 *
 * Estimates how a CANDIDATE routing policy would have performed, using only
 * logged decisions made by the LIVE policy — no live traffic, no A/B test.
 * This consumes exactly what WS4.2 has been logging on every telemetry row
 * since it shipped: `propensity` (the live policy's probability of the
 * logged choice), `candidates` (the choice set), `quality_score` (reward),
 * and — as of the same change that added this module — `context` (the
 * bandit's 12-dim feature vector, needed by the doubly-robust term).
 *
 * Four estimators, in increasing order of sophistication:
 *
 *   IPS    importance sampling: reweight logged rewards by
 *          π(a|x) / p. Unbiased but high-variance when propensities are
 *          small.
 *   SNIPS  self-normalized IPS: divide by the sum of weights instead of n.
 *          Slightly biased, far lower variance (Swaminathan & Joachims).
 *   DR     doubly robust (Dudík/Langford/Li 2011): a regression baseline
 *          r̂(x, a) — LinUCB's own per-arm ridge model, reused — plus the
 *          importance-weighted residual. Unbiased if EITHER the propensities
 *          OR the regression model is right.
 *   WDR    weighted DR: DR with SNIPS-style self-normalized weights on the
 *          correction term. The production target named by real systems'
 *          own code ("the IPS/DR/WDR estimators").
 *
 * A candidate policy is a plain function:
 *   policyFn({ tier, context, candidates }) →
 *     { probs: Map<candidateKey, number> } — action probabilities summing
 *     to 1 over the row's candidate set (deterministic policies return
 *     probability 1 on one candidate).
 *
 * Rewards are quality_score rescaled to [0, 1] (same scale the bandit and
 * its r̂ train on). Rows are only usable when they carry propensity,
 * candidates (≥1), and quality_score; the DR term additionally needs
 * context and falls back to the pure IPS term on rows without it.
 *
 * @module routing/ope
 */

const { getBandit } = require('./bandit');

/** Canonical key for a candidate. */
function candKey(c) {
  return `${c.provider}:${c.model}`;
}

// Propensity floor: a logged propensity below this is clamped, bounding any
// single row's importance weight (the same reason workweave's Monte-Carlo
// propensity floors at 1/trials — one row must not dominate the estimate).
const PROPENSITY_FLOOR = 1e-3;

function _parseRow(row) {
  if (row == null) return null;
  const propensity = typeof row.propensity === 'number' ? row.propensity : null;
  const quality = typeof row.quality_score === 'number' ? row.quality_score : null;
  if (propensity == null || quality == null) return null;

  let candidates = row.candidates;
  if (typeof candidates === 'string') {
    try {
      candidates = JSON.parse(candidates);
    } catch {
      return null;
    }
  }
  if (!Array.isArray(candidates) || candidates.length === 0) return null;

  let context = row.context ?? null;
  if (typeof context === 'string') {
    try {
      context = JSON.parse(context);
    } catch {
      context = null;
    }
  }
  if (!Array.isArray(context)) context = null;

  return {
    tier: row.tier ?? null,
    served: { provider: row.provider, model: row.model ?? null },
    reward: Math.max(0, Math.min(1, quality / 100)),
    propensity: Math.max(PROPENSITY_FLOOR, Math.min(1, propensity)),
    candidates,
    context,
  };
}

/**
 * Evaluate a candidate policy against logged telemetry rows.
 *
 * @param {Array<object>} rows — telemetry rows (raw DB rows or equivalents)
 * @param {Function} policyFn — ({ tier, context, candidates }) → { probs: Map }
 * @param {object} [deps]
 * @param {object} [deps.bandit] — override the reward model (tests)
 * @returns {{
 *   n: number, usable: number, drRows: number,
 *   ips: number|null, snips: number|null, dr: number|null, wdr: number|null,
 *   effectiveSampleSize: number|null,
 *   loggedMeanReward: number|null,
 * }}
 */
function evaluatePolicy(rows, policyFn, deps = {}) {
  const bandit = deps.bandit || getBandit();

  let usable = 0;
  let drRows = 0;
  let ipsSum = 0;
  let weightSum = 0;
  let weightSqSum = 0;
  let drSum = 0;
  let wdrBaselineSum = 0;
  let wdrCorrectionSum = 0;
  let loggedRewardSum = 0;

  for (const raw of rows) {
    const row = _parseRow(raw);
    if (!row) continue;
    usable += 1;
    loggedRewardSum += row.reward;

    let probs;
    try {
      const out = policyFn({ tier: row.tier, context: row.context, candidates: row.candidates });
      probs = out?.probs;
    } catch {
      probs = null;
    }
    if (!probs) continue;

    // π(a_logged | x): the candidate policy's probability of the action the
    // live policy actually served.
    const piLogged = probs.get(candKey(row.served)) ?? 0;
    const w = piLogged / row.propensity;

    ipsSum += w * row.reward;
    weightSum += w;
    weightSqSum += w * w;

    // DR terms: baseline = Σ_a π(a|x)·r̂(x,a); correction = w·(r − r̂(x,a_logged)).
    // Rows without a context (bandit didn't run) or without a usable r̂ fall
    // back to r̂ = 0, which reduces the row's DR contribution to pure IPS.
    let baseline = 0;
    let rhatLogged = 0;
    if (row.context && row.tier) {
      drRows += 1;
      for (const c of row.candidates) {
        const p = probs.get(candKey(c)) ?? 0;
        if (p === 0) continue;
        const rhat = bandit.estimateReward(row.tier, c.provider, c.model, row.context);
        if (rhat != null) baseline += p * rhat;
      }
      const rhatServed = bandit.estimateReward(row.tier, row.served.provider, row.served.model, row.context);
      if (rhatServed != null) rhatLogged = rhatServed;
    }
    drSum += baseline + w * (row.reward - rhatLogged);
    wdrBaselineSum += baseline;
    wdrCorrectionSum += w * (row.reward - rhatLogged);
  }

  if (usable === 0) {
    return {
      n: rows.length, usable: 0, drRows: 0,
      ips: null, snips: null, dr: null, wdr: null,
      effectiveSampleSize: null, loggedMeanReward: null,
    };
  }

  // Effective sample size — Kish's approximation. A small ESS relative to
  // `usable` means a few high-weight rows dominate: treat the estimate with
  // suspicion regardless of its value.
  const ess = weightSqSum > 0 ? (weightSum * weightSum) / weightSqSum : 0;

  return {
    n: rows.length,
    usable,
    drRows,
    ips: ipsSum / usable,
    snips: weightSum > 0 ? ipsSum / weightSum : null,
    dr: drSum / usable,
    // WDR: baseline averaged per-row (deterministic, no weights) plus the
    // self-normalized correction — variance control on exactly the term
    // that needs it.
    wdr: weightSum > 0
      ? wdrBaselineSum / usable + wdrCorrectionSum / weightSum
      : wdrBaselineSum / usable,
    effectiveSampleSize: ess,
    loggedMeanReward: loggedRewardSum / usable,
  };
}

// ---------------------------------------------------------------------------
// Reference policies — useful baselines to evaluate out of the box.
// ---------------------------------------------------------------------------

/** Always pick the first candidate (the tier-config/heuristic selection). */
function firstCandidatePolicy({ candidates }) {
  const probs = new Map();
  candidates.forEach((c, i) => probs.set(candKey(c), i === 0 ? 1 : 0));
  return { probs };
}

/** Always pick the last candidate (the kNN suggestion when present). */
function lastCandidatePolicy({ candidates }) {
  const probs = new Map();
  const lastIdx = candidates.length - 1;
  candidates.forEach((c, i) => probs.set(candKey(c), i === lastIdx ? 1 : 0));
  return { probs };
}

/** Uniform-random over the candidate set. */
function uniformPolicy({ candidates }) {
  const probs = new Map();
  const p = 1 / candidates.length;
  candidates.forEach((c) => probs.set(candKey(c), p));
  return { probs };
}

/**
 * The current LinUCB policy replayed greedily (no exploration, mean+bonus
 * argmax at TODAY'S learned weights). Comparing this against the logged
 * rewards answers: "has the bandit's learning actually converged on
 * something better than what it served while learning?"
 */
function currentBanditGreedyPolicy({ tier, context, candidates }, deps = {}) {
  const bandit = deps.bandit || getBandit();
  const probs = new Map();
  if (!context || !tier || candidates.length < 2) {
    return firstCandidatePolicy({ candidates });
  }
  let best = null;
  let bestVal = -Infinity;
  for (const c of candidates) {
    const est = bandit.estimateReward(tier, c.provider, c.model, context);
    const val = est ?? -1; // unknown arms lose to any known arm
    if (val > bestVal) {
      bestVal = val;
      best = c;
    }
  }
  candidates.forEach((c) => probs.set(candKey(c), c === best ? 1 : 0));
  return { probs };
}

module.exports = {
  evaluatePolicy,
  candKey,
  PROPENSITY_FLOOR,
  policies: {
    firstCandidate: firstCandidatePolicy,
    lastCandidate: lastCandidatePolicy,
    uniform: uniformPolicy,
    currentBanditGreedy: currentBanditGreedyPolicy,
  },
};
