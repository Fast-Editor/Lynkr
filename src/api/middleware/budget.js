const { getBudgetManager } = require('../../budget');
const logger = require('../../logger');

/**
 * Budget and rate limiting middleware
 */
function budgetMiddleware(req, res, next) {
  const budgetManager = getBudgetManager();

  // Extract user ID (from session, auth header, or default)
  const userId = req.session?.id || req.headers['x-user-id'] || 'default';

  // Check rate limits
  const rateLimitCheck = budgetManager.checkRateLimit(userId);
  if (!rateLimitCheck.allowed) {
    logger.warn({
      userId,
      reason: rateLimitCheck.reason,
      limit: rateLimitCheck.limit,
      current: rateLimitCheck.current,
    }, 'Rate limit exceeded');

    return res.status(429).json({
      error: 'rate_limit_exceeded',
      message: `Rate limit exceeded: ${rateLimitCheck.limit} requests per ${rateLimitCheck.reason === 'rate_limit_minute' ? 'minute' : 'hour'}`,
      limit: rateLimitCheck.limit,
      current: rateLimitCheck.current,
      resetInMs: rateLimitCheck.resetInMs,
      retryAfter: Math.ceil(rateLimitCheck.resetInMs / 1000), // seconds
    });
  }

  // Check budget
  const budgetCheck = budgetManager.checkBudget(userId);
  if (!budgetCheck.allowed) {
    logger.warn({
      userId,
      reason: budgetCheck.reason,
      limit: budgetCheck.limit,
      current: budgetCheck.current,
    }, 'Budget limit exceeded');

    return res.status(402).json({ // 402 Payment Required
      error: 'budget_exceeded',
      message: `Budget limit exceeded: ${budgetCheck.reason}`,
      reason: budgetCheck.reason,
      limit: budgetCheck.limit,
      current: budgetCheck.current,
    });
  }

  // Log warnings if approaching limits
  if (budgetCheck.warnings && budgetCheck.warnings.length > 0) {
    logger.warn({
      userId,
      warnings: budgetCheck.warnings,
    }, 'Budget warning: approaching limits');
  }

  req.budgetInfo = {
    userId,
    budgetCheck,
    startTime: Date.now(),
  };

  // Record usage after response completes
  res.on('finish', () => {
    try {
      const usage = res.locals.usage;
      if (!usage) return;
      budgetManager.recordUsage(userId, req.session?.id || null, {
        tokensInput: usage.prompt_tokens || usage.input_tokens || 0,
        tokensOutput: usage.completion_tokens || usage.output_tokens || 0,
        costUsd: usage.cost_usd || 0,
        model: usage.model || null,
        endpoint: req.path,
        latencyMs: Date.now() - req.budgetInfo.startTime,
      });
    } catch (err) {
      logger.warn({ err: err.message }, 'Failed to record usage after response');
    }
  });

  next();
}

module.exports = { budgetMiddleware };
