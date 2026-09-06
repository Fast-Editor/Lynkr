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

  // Token-aware (TPM) rate limiting — off unless LYNKR_TPM_LIMIT is set.
  // Pre-flight gates on the window's actual consumption plus this request's
  // cheap estimate; the true-up lands in the res 'finish' handler below.
  try {
    const { countPayloadTokens } = require('../../utils/tokens');
    const estInput = countPayloadTokens(req.body || {}).total || 0;
    const estOutput = typeof req.body?.max_tokens === 'number' && req.body.max_tokens > 0
      ? req.body.max_tokens
      : 1024;
    const tokenCheck = budgetManager.checkTokenRate(userId, estInput + estOutput);
    if (!tokenCheck.allowed) {
      logger.warn({
        userId,
        limit: tokenCheck.limit,
        current: tokenCheck.current,
        estimated: tokenCheck.estimated,
      }, 'Token rate limit (TPM) exceeded');
      return res.status(429).json({
        error: 'rate_limit_exceeded',
        message: `Token rate limit exceeded: ${tokenCheck.limit} tokens per minute`,
        limit: tokenCheck.limit,
        current: tokenCheck.current,
        resetInMs: tokenCheck.resetInMs,
        retryAfter: Math.ceil(tokenCheck.resetInMs / 1000),
      });
    }
  } catch (err) {
    logger.debug({ err: err.message }, 'TPM check failed — allowing request');
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
      const tokensInput = usage.prompt_tokens || usage.input_tokens || 0;
      const tokensOutput = usage.completion_tokens || usage.output_tokens || 0;
      budgetManager.recordUsage(userId, req.session?.id || null, {
        tokensInput,
        tokensOutput,
        costUsd: usage.cost_usd || 0,
        model: usage.model || null,
        endpoint: req.path,
        latencyMs: Date.now() - req.budgetInfo.startTime,
      });
      // TPM true-up with actual consumption (no-op unless LYNKR_TPM_LIMIT set).
      budgetManager.recordTokenUsage(userId, tokensInput + tokensOutput);
    } catch (err) {
      logger.warn({ err: err.message }, 'Failed to record usage after response');
    }
  });

  next();
}

module.exports = { budgetMiddleware };
