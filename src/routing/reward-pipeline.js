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
 *
 * WS5.1 — state persists to data/reward-state.json so the normaliser ranges
 * survive process restarts. Without this, the first N requests after every
 * restart get scaled against a re-learned range and produce noisy rewards.
 */

const fs = require('fs');
const path = require('path');
const logger = require('../logger');

const STATE_PATH = path.join(__dirname, '../../data/reward-state.json');
const DEFAULT_LAMBDA = 0.3;
const DEFAULT_MU = 0.1;
const SAVE_EVERY = 25;

class RewardPipeline {
  constructor({ lambda = DEFAULT_LAMBDA, mu = DEFAULT_MU, statePath = STATE_PATH } = {}) {
    this.lambda = lambda;
    this.mu = mu;
    this.costRange = { min: Infinity, max: -Infinity };
    this.latencyRange = { min: Infinity, max: -Infinity };
    this.observations = 0;
    this.statePath = statePath;
    this._load();
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
    this.observations++;
    // Periodic save mirrors bandit.js: cheap enough to write inline every
    // N observations, no risk of blocking the response path since callers
    // invoke reward() from setImmediate.
    if (this.observations % SAVE_EVERY === 0) this._save();
    const q = typeof obs.quality === 'number' ? obs.quality : 50;
    const cn = this._normalize(obs.cost ?? 0, this.costRange);
    const ln = this._normalize(obs.latency ?? 0, this.latencyRange);
    return Math.max(0, Math.min(100, q - this.lambda * cn * 100 - this.mu * ln * 100));
  }

  _save() {
    try {
      fs.mkdirSync(path.dirname(this.statePath), { recursive: true });
      fs.writeFileSync(this.statePath, JSON.stringify({
        savedAt: Date.now(),
        lambda: this.lambda,
        mu: this.mu,
        observations: this.observations,
        // Serialise Infinity as null; _load() re-hydrates.
        costRange: {
          min: isFinite(this.costRange.min) ? this.costRange.min : null,
          max: isFinite(this.costRange.max) ? this.costRange.max : null,
        },
        latencyRange: {
          min: isFinite(this.latencyRange.min) ? this.latencyRange.min : null,
          max: isFinite(this.latencyRange.max) ? this.latencyRange.max : null,
        },
      }, null, 0));
    } catch (err) {
      logger.debug({ err: err.message }, '[Reward] State save failed');
    }
  }

  _load() {
    try {
      if (!fs.existsSync(this.statePath)) return;
      const raw = JSON.parse(fs.readFileSync(this.statePath, 'utf8'));
      if (raw.costRange) {
        this.costRange = {
          min: raw.costRange.min == null ? Infinity : raw.costRange.min,
          max: raw.costRange.max == null ? -Infinity : raw.costRange.max,
        };
      }
      if (raw.latencyRange) {
        this.latencyRange = {
          min: raw.latencyRange.min == null ? Infinity : raw.latencyRange.min,
          max: raw.latencyRange.max == null ? -Infinity : raw.latencyRange.max,
        };
      }
      this.observations = raw.observations || 0;
      logger.info({
        cost: this.costRange,
        latency: this.latencyRange,
        observations: this.observations,
      }, '[Reward] State loaded');
    } catch (err) {
      logger.debug({ err: err.message }, '[Reward] State load failed');
    }
  }
}

let _instance = null;
function getRewardPipeline() {
  if (!_instance) _instance = new RewardPipeline();
  return _instance;
}

module.exports = { RewardPipeline, getRewardPipeline, SAVE_EVERY };
