/**
 * Hierarchical budget controls (Phase 6.2).
 *
 * Tracks spend at four levels: virtual_key → team → customer → org.
 * Each level has a ceiling; a request must pass *every* level it belongs
 * to.
 *
 * Storage: in-process Map by default. Operations are atomic-by-design (single
 * Node event loop), so no locking needed. For multi-process deployments,
 * swap the storage implementation for Redis (the interface is stable; see
 * RedisBudgetStore stub at the bottom of the file).
 */

const fs = require('fs');
const path = require('path');
const logger = require('../logger');

const CONFIG_PATH = path.join(__dirname, '../../data/budgets.json');
const RELOAD_INTERVAL_MS = 60_000;

const LEVELS = ['virtual_key', 'team', 'customer', 'org'];

class MapBudgetStore {
  constructor() {
    this._spend = new Map(); // `${level}:${id}` → { spent, periodStart }
  }

  _key(level, id) {
    return `${level}:${id}`;
  }

  get(level, id) {
    return this._spend.get(this._key(level, id)) || { spent: 0, periodStart: Date.now() };
  }

  set(level, id, value) {
    this._spend.set(this._key(level, id), value);
  }

  incr(level, id, amount) {
    const current = this.get(level, id);
    current.spent += amount;
    this.set(level, id, current);
    return current;
  }

  resetIfStale(level, id, periodMs) {
    const current = this.get(level, id);
    if (Date.now() - current.periodStart > periodMs) {
      current.spent = 0;
      current.periodStart = Date.now();
      this.set(level, id, current);
    }
    return current;
  }
}

let _config = null;
let _configLoadedAt = 0;
function _loadConfig() {
  if (_config && Date.now() - _configLoadedAt < RELOAD_INTERVAL_MS) return _config;
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      _config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
      _configLoadedAt = Date.now();
      return _config;
    }
  } catch (err) {
    logger.debug({ err: err.message }, '[HierarchicalBudget] Config load failed');
  }
  _config = { defaults: { periodMs: 86400000 }, limits: {} };
  _configLoadedAt = Date.now();
  return _config;
}

class HierarchicalBudget {
  constructor(store = new MapBudgetStore()) {
    this.store = store;
  }

  /**
   * Check whether all relevant ceilings still allow `amount` of spend.
   * @param {object} context — { virtual_key, team, customer, org }
   * @param {number} amount — dollars
   * @returns {{ ok: boolean, exceeded?: { level, id, limit, spent } }}
   */
  check(context, amount) {
    const config = _loadConfig();
    const periodMs = config.defaults?.periodMs || 86400000;
    for (const level of LEVELS) {
      const id = context[level];
      if (!id) continue;
      const limit = config.limits?.[level]?.[id] ?? config.defaults?.[level];
      if (typeof limit !== 'number') continue;
      const current = this.store.resetIfStale(level, id, periodMs);
      if (current.spent + amount > limit) {
        return {
          ok: false,
          exceeded: { level, id, limit, spent: current.spent },
        };
      }
    }
    return { ok: true };
  }

  /**
   * Record spend after a request completes. Increments all relevant levels.
   */
  record(context, amount) {
    if (typeof amount !== 'number' || amount <= 0) return;
    for (const level of LEVELS) {
      const id = context[level];
      if (!id) continue;
      this.store.incr(level, id, amount);
    }
  }

  /**
   * Summary for the dashboard.
   */
  status(context) {
    const config = _loadConfig();
    const periodMs = config.defaults?.periodMs || 86400000;
    const out = {};
    for (const level of LEVELS) {
      const id = context[level];
      if (!id) continue;
      const limit = config.limits?.[level]?.[id] ?? config.defaults?.[level];
      const current = this.store.resetIfStale(level, id, periodMs);
      out[level] = { id, spent: current.spent, limit, periodStart: current.periodStart };
    }
    return out;
  }
}

let _instance = null;
function getHierarchicalBudget() {
  if (!_instance) _instance = new HierarchicalBudget();
  return _instance;
}

/**
 * Redis backend stub. Implement this when scaling beyond a single Node
 * process. The interface mirrors MapBudgetStore so HierarchicalBudget can
 * use either.
 */
class RedisBudgetStore {
  constructor(_redisClient) {
    throw new Error('RedisBudgetStore not implemented. Stub — wire your Redis client and use INCRBY with periodic TTL.');
  }
}

module.exports = {
  HierarchicalBudget,
  MapBudgetStore,
  RedisBudgetStore,
  getHierarchicalBudget,
  LEVELS,
};
