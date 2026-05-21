/**
 * Tenant context middleware (Phase 6.1).
 *
 * Reads LYNKR-Tenant-Id from request headers and attaches the loaded tenant
 * policy to res.locals.tenantPolicy for downstream handlers.
 */

const { getTenantId, getPolicy } = require('../../routing/tenant-policy');

function tenantMiddleware(req, res, next) {
  const tenantId = getTenantId(req);
  res.locals = res.locals || {};
  if (tenantId) {
    const policy = getPolicy(tenantId);
    res.locals.tenantId = tenantId;
    res.locals.tenantPolicy = policy;
  }
  next();
}

module.exports = { tenantMiddleware };
