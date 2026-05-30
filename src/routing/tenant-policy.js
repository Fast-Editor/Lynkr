/**
 * Per-tenant routing policy (Phase 6.1).
 *
 * Each tenant can override:
 *   - tier thresholds (which complexity scores map to which tiers)
 *   - reward weights (λ for cost, μ for latency in the bandit)
 *   - max acceptable latency
 *   - blocked models (never route to these)
 *
 * Tenant id is read from the `LYNKR_TENANT_ID` request header. Per-tenant
 * configs live in data/tenants/<id>.json. Falls back to global config when
 * the id is absent or the file doesn't exist.
 */

const fs = require('fs');
const path = require('path');
const logger = require('../logger');

const TENANTS_DIR = path.join(__dirname, '../../data/tenants');
const _cache = new Map();
const RELOAD_INTERVAL_MS = 60_000;

function _loadTenant(tenantId) {
  if (!tenantId) return null;
  const cached = _cache.get(tenantId);
  if (cached && Date.now() - cached.loadedAt < RELOAD_INTERVAL_MS) return cached.config;

  const file = path.join(TENANTS_DIR, `${tenantId.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`);
  if (!fs.existsSync(file)) {
    _cache.set(tenantId, { config: null, loadedAt: Date.now() });
    return null;
  }
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    _cache.set(tenantId, { config: data, loadedAt: Date.now() });
    return data;
  } catch (err) {
    logger.warn({ tenantId, err: err.message }, '[TenantPolicy] Load failed');
    return null;
  }
}

function getPolicy(tenantId) {
  const t = _loadTenant(tenantId);
  if (!t) return null;
  return {
    tenantId,
    tierRanges: t.tierRanges || null,
    rewardWeights: t.rewardWeights || null,
    maxLatencyMs: t.maxLatencyMs ?? null,
    blockedModels: Array.isArray(t.blockedModels) ? new Set(t.blockedModels) : null,
    preferredProviders: Array.isArray(t.preferredProviders) ? t.preferredProviders : null,
  };
}

/**
 * Apply tenant overrides to a routing decision after the main algorithm has
 * produced one. Returns either the decision unchanged or a new decision
 * respecting the tenant constraints.
 */
function applyTenantOverrides(decision, tenantPolicy) {
  if (!tenantPolicy || !decision) return decision;
  // Blocked model → fall back to next-cheapest qualifying model in same tier
  if (tenantPolicy.blockedModels && decision.model && tenantPolicy.blockedModels.has(decision.model)) {
    const { getCostOptimizer } = require('./cost-optimizer');
    const optimizer = getCostOptimizer();
    const cheapest = optimizer.findCheapestForTier(decision.tier, tenantPolicy.preferredProviders || []);
    if (cheapest && !tenantPolicy.blockedModels.has(cheapest.model)) {
      return {
        ...decision,
        provider: cheapest.provider,
        model: cheapest.model,
        method: (decision.method || '') + '+tenant_override',
        tenantOverride: { reason: 'blocked_model', tenantId: tenantPolicy.tenantId },
      };
    }
  }
  return decision;
}

function getTenantId(req) {
  if (!req) return null;
  const h = req.headers || req;
  return (h['lynkr-tenant-id'] || h['LYNKR-Tenant-Id'] || h['x-tenant-id'] || null);
}

function reloadCache() {
  _cache.clear();
}

module.exports = {
  getPolicy,
  getTenantId,
  applyTenantOverrides,
  reloadCache,
};
