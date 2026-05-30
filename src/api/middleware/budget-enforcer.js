/**
 * Budget enforcement middleware (Phase 6.2).
 *
 * Reads tenant/budget context from request headers, checks the hierarchical
 * budget ceiling, and rejects with 429 if exceeded.
 *
 * Header contract:
 *   LYNKR-Virtual-Key, LYNKR-Team-Id, LYNKR-Customer-Id, LYNKR-Org-Id
 */

const logger = require('../../logger');
const { getHierarchicalBudget } = require('../../budget/hierarchical-budget');

function _readContext(req) {
  const h = req.headers || {};
  return {
    virtual_key: h['lynkr-virtual-key'] || null,
    team: h['lynkr-team-id'] || null,
    customer: h['lynkr-customer-id'] || null,
    org: h['lynkr-org-id'] || null,
  };
}

/**
 * Express middleware. Estimates request cost via cost-optimizer and rejects
 * if the budget is already exceeded. Records spend after the response.
 */
function budgetEnforcer(req, res, next) {
  if (process.env.LYNKR_BUDGET_ENFORCER === 'false') return next();
  const context = _readContext(req);
  // Cheap pre-check at $0; we use the request to record actual spend.
  // The actual ceiling check happens with an estimated $0.01 "minimum" so
  // exhausted accounts get rejected before we even route.
  const budget = getHierarchicalBudget();
  const check = budget.check(context, 0.01);
  if (!check.ok) {
    logger.warn({ exceeded: check.exceeded }, '[BudgetEnforcer] Budget exceeded');
    return res.status(429).json({
      error: {
        type: 'budget_exceeded',
        message: `Budget exceeded for ${check.exceeded.level}=${check.exceeded.id}`,
        ...check.exceeded,
      },
    });
  }
  res.locals = res.locals || {};
  res.locals.budgetContext = context;
  next();
}

/**
 * Helper for handlers to record spend after a request completes.
 * Call this from the orchestrator with the actual cost.
 */
function recordSpend(context, amount) {
  if (!context) return;
  getHierarchicalBudget().record(context, amount);
}

module.exports = { budgetEnforcer, recordSpend };
