/**
 * Wilson score interval — lower bound on a binomial proportion.
 *
 * Used by the downsize analyzer: "the lower tier succeeded k of n times"
 * is only evidence when the LOWER BOUND of the confidence interval clears
 * the bar. A raw average (k/n >= 0.7) treats 21/30 the same as 700/1000;
 * Wilson does not — small samples get wide intervals and stay unproven.
 *
 * @param {number} successes
 * @param {number} n
 * @param {number} [z=1.96] - 95% confidence
 * @returns {number} lower bound in [0,1]; 0 when n === 0
 */
function wilsonLowerBound(successes, n, z = 1.96) {
  if (!Number.isFinite(n) || n <= 0) return 0;
  const p = Math.min(1, Math.max(0, successes / n));
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = p + z2 / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n);
  return Math.max(0, (centre - margin) / denom);
}

module.exports = { wilsonLowerBound };
