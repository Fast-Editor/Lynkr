/**
 * Reward pipeline for the LinUCB bandit (Phase 4.1).
 *
 * Combines quality score, normalised cost, and normalised latency into a
 * single scalar reward in [0, 100]. The bandit then rescales to [0, 1].
 *
 *   reward = quality - λ·norm_cost·100 - μ·norm_latency·100
 *
 * Normalisation uses running min/max so we don't need to pre-compute global
 * scales.
 */

const logger = require('../logger');

const DEFAULT_LAMBDA = 0.3;
const DEFAULT_MU = 0.1;

class RewardPipeline {
  constructor({ lambda = DEFAULT_LAMBDA, mu = DEFAULT_MU } = {}) {
    this.lambda = lambda;
    this.mu = mu;
    this.costRange = { min: Infinity, max: -Infinity };
    this.latencyRange = { min: Infinity, max: -Infinity };
  }

  observe({ cost, latency }) {
    if (typeof cost === 'number' && cost >= 0) {
      this.costRange.min = Math.min(this.costRange.min, cost);
      this.costRange.max = Math.max(this.costRange.max, cost);
    }
    if (typeof latency === 'number' && latency >= 0) {
      this.latencyRange.min = Math.min(this.latencyRange.min, latency);
      this.latencyRange.max = Math.max(this.latencyRange.max, latency);
    }
  }

  _normalize(value, range) {
    if (!isFinite(range.min) || !isFinite(range.max) || range.max <= range.min) return 0;
    const v = Math.max(range.min, Math.min(range.max, value));
    return (v - range.min) / (range.max - range.min);
  }

  /**
   * @param {object} obs - { quality: 0-100, cost: dollars, latency: ms }
   * @returns {number} reward in [0, 100]
   */
  reward(obs) {
    this.observe(obs);
    const q = typeof obs.quality === 'number' ? obs.quality : 50;
    const cn = this._normalize(obs.cost ?? 0, this.costRange);
    const ln = this._normalize(obs.latency ?? 0, this.latencyRange);
    return Math.max(0, Math.min(100, q - this.lambda * cn * 100 - this.mu * ln * 100));
  }
}

let _instance = null;
function getRewardPipeline() {
  if (!_instance) _instance = new RewardPipeline();
  return _instance;
}

module.exports = { RewardPipeline, getRewardPipeline };
