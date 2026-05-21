/**
 * LinUCB contextual bandit for intra-tier model selection (Phase 4.1).
 *
 * Standard LinUCB-with-disjoint-models algorithm (Li et al. 2010).
 *   - One arm per (provider, model) pair in a tier
 *   - Context = numerical feature vector for the request
 *   - Reward = quality_score - λ·norm_cost - μ·norm_latency
 *   - Per-arm A (d×d ridge-regression matrix) and b (d-vector) stored to disk
 *
 * State persists to data/bandit-state.json. Loaded on startup; saved on
 * every `update()` (cheap — small matrices) and on graceful shutdown.
 */

const fs = require('fs');
const path = require('path');
const logger = require('../logger');

const STATE_PATH = path.join(__dirname, '../../data/bandit-state.json');
const DEFAULT_ALPHA = 1.5;
const DEFAULT_LAMBDA = 0.3; // cost penalty weight
const DEFAULT_MU = 0.1;     // latency penalty weight
const FEATURE_DIM = 12;
const EXPLORATION_RATE = 0.05;

function _identity(d) {
  const m = new Array(d);
  for (let i = 0; i < d; i++) {
    m[i] = new Array(d).fill(0);
    m[i][i] = 1;
  }
  return m;
}

function _zeros(d) {
  return new Array(d).fill(0);
}

function _matVec(M, v) {
  const d = v.length;
  const out = new Array(d).fill(0);
  for (let i = 0; i < d; i++) {
    for (let j = 0; j < d; j++) out[i] += M[i][j] * v[j];
  }
  return out;
}

function _dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

function _outer(a, b) {
  const out = new Array(a.length);
  for (let i = 0; i < a.length; i++) {
    out[i] = new Array(b.length);
    for (let j = 0; j < b.length; j++) out[i][j] = a[i] * b[j];
  }
  return out;
}

function _addMat(A, B) {
  for (let i = 0; i < A.length; i++) {
    for (let j = 0; j < A[i].length; j++) A[i][j] += B[i][j];
  }
}

function _addVec(a, b) {
  for (let i = 0; i < a.length; i++) a[i] += b[i];
}

/**
 * Invert a small dense matrix via Gauss-Jordan. For d=12 this is plenty fast
 * and saves us a dependency on a linear algebra library.
 */
function _inv(M) {
  const d = M.length;
  const aug = M.map((row, i) => {
    const r = row.slice();
    for (let j = 0; j < d; j++) r.push(i === j ? 1 : 0);
    return r;
  });
  for (let i = 0; i < d; i++) {
    let pivot = aug[i][i];
    if (Math.abs(pivot) < 1e-12) {
      let swap = -1;
      for (let k = i + 1; k < d; k++) {
        if (Math.abs(aug[k][i]) > 1e-12) { swap = k; break; }
      }
      if (swap < 0) throw new Error('matrix singular');
      [aug[i], aug[swap]] = [aug[swap], aug[i]];
      pivot = aug[i][i];
    }
    for (let j = 0; j < 2 * d; j++) aug[i][j] /= pivot;
    for (let k = 0; k < d; k++) {
      if (k === i) continue;
      const factor = aug[k][i];
      for (let j = 0; j < 2 * d; j++) aug[k][j] -= factor * aug[i][j];
    }
  }
  return aug.map(row => row.slice(d));
}

class LinUCBBandit {
  constructor({ alpha = DEFAULT_ALPHA, lambda = DEFAULT_LAMBDA, mu = DEFAULT_MU, dim = FEATURE_DIM } = {}) {
    this.alpha = alpha;
    this.lambda = lambda;
    this.mu = mu;
    this.dim = dim;
    /** arms: Map<armKey, { A: number[][], b: number[], count: number }> */
    this.arms = new Map();
    this.steps = 0;
    this._load();
  }

  _armKey(tier, provider, model) {
    return `${tier}|${provider}:${model}`;
  }

  _ensureArm(armKey) {
    if (!this.arms.has(armKey)) {
      this.arms.set(armKey, { A: _identity(this.dim), b: _zeros(this.dim), count: 0 });
    }
    return this.arms.get(armKey);
  }

  /**
   * Pick an arm for a given tier and context.
   * @param {string} tier
   * @param {Array<{ provider: string, model: string }>} candidates — qualifying arms
   * @param {number[]} context — feature vector
   * @returns {{ provider, model, ucb, explored }} chosen arm
   */
  pick(tier, candidates, context) {
    if (!candidates || candidates.length === 0) return null;
    if (context.length !== this.dim) {
      // Pad or truncate to dim
      context = context.slice(0, this.dim);
      while (context.length < this.dim) context.push(0);
    }

    // ε-greedy: 5% pure exploration
    if (Math.random() < EXPLORATION_RATE) {
      const random = candidates[Math.floor(Math.random() * candidates.length)];
      return { ...random, ucb: null, explored: true };
    }

    let best = null;
    let bestUcb = -Infinity;
    for (const c of candidates) {
      const key = this._armKey(tier, c.provider, c.model);
      const arm = this._ensureArm(key);
      let Ainv;
      try {
        Ainv = _inv(arm.A);
      } catch (err) {
        continue;
      }
      const theta = _matVec(Ainv, arm.b);
      const mean = _dot(theta, context);
      const variance = _dot(context, _matVec(Ainv, context));
      const ucb = mean + this.alpha * Math.sqrt(Math.max(0, variance));
      if (ucb > bestUcb) {
        bestUcb = ucb;
        best = { ...c, ucb, explored: false };
      }
    }
    return best;
  }

  /**
   * Update the chosen arm with the observed reward.
   * @param {string} tier
   * @param {string} provider
   * @param {string} model
   * @param {number[]} context
   * @param {number} reward — typically in [0, 100]; will be rescaled to [0, 1] internally
   */
  update(tier, provider, model, context, reward) {
    const key = this._armKey(tier, provider, model);
    const arm = this._ensureArm(key);
    let ctx = context;
    if (ctx.length !== this.dim) {
      ctx = ctx.slice(0, this.dim);
      while (ctx.length < this.dim) ctx.push(0);
    }
    const r = Math.max(0, Math.min(1, reward / 100));
    _addMat(arm.A, _outer(ctx, ctx));
    _addVec(arm.b, ctx.map(x => x * r));
    arm.count++;
    this.steps++;
    // Save periodically (not every step to limit IO)
    if (this.steps % 25 === 0) this._save();
  }

  _save() {
    try {
      fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
      const arms = {};
      for (const [k, v] of this.arms) arms[k] = v;
      fs.writeFileSync(STATE_PATH, JSON.stringify({
        savedAt: Date.now(),
        steps: this.steps,
        alpha: this.alpha,
        lambda: this.lambda,
        mu: this.mu,
        dim: this.dim,
        arms,
      }, null, 0));
    } catch (err) {
      logger.debug({ err: err.message }, '[Bandit] State save failed');
    }
  }

  _load() {
    try {
      if (!fs.existsSync(STATE_PATH)) return;
      const raw = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
      if (raw.dim && raw.dim === this.dim) {
        for (const [k, v] of Object.entries(raw.arms || {})) {
          this.arms.set(k, v);
        }
        this.steps = raw.steps || 0;
        logger.info({ arms: this.arms.size, steps: this.steps }, '[Bandit] State loaded');
      }
    } catch (err) {
      logger.debug({ err: err.message }, '[Bandit] State load failed');
    }
  }

  getStats() {
    const armStats = {};
    for (const [k, v] of this.arms) {
      armStats[k] = { count: v.count };
    }
    return { steps: this.steps, arms: armStats, alpha: this.alpha };
  }
}

let _instance = null;
function getBandit() {
  if (!_instance) _instance = new LinUCBBandit();
  return _instance;
}

module.exports = { LinUCBBandit, getBandit, FEATURE_DIM };
