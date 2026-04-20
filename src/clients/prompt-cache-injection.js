/**
 * Provider-Side Prompt Cache Injection
 *
 * Injects `cache_control` breakpoints into requests for providers
 * that support explicit prompt caching (Anthropic, Bedrock, Vertex/Gemini).
 *
 * Strategy: "system_and_3" — places up to 4 breakpoints:
 *   1. System prompt (stable across turns — highest cache hit rate)
 *   2-4. Last 3 non-system messages (rolling window)
 *
 * Providers with automatic caching (OpenAI, DeepSeek) need no injection.
 *
 * @module clients/prompt-cache-injection
 */

const logger = require('../logger');

const CACHE_MARKER = { type: 'ephemeral' };
const MAX_BREAKPOINTS = 4;

/**
 * Inject cache_control breakpoints into an Anthropic-format request body.
 * Mutates the body in-place for zero-copy performance.
 *
 * @param {Object} body - Request body with system and messages
 * @returns {number} Number of breakpoints injected
 */
function injectAnthropicCacheBreakpoints(body) {
  if (!body) return 0;

  let injected = 0;

  // Breakpoint 1: System prompt
  if (body.system) {
    if (typeof body.system === 'string') {
      // Convert string system to array format for cache_control support
      body.system = [{
        type: 'text',
        text: body.system,
        cache_control: CACHE_MARKER,
      }];
      injected++;
    } else if (Array.isArray(body.system) && body.system.length > 0) {
      // Mark the last system block
      const lastBlock = body.system[body.system.length - 1];
      if (lastBlock && typeof lastBlock === 'object' && !lastBlock.cache_control) {
        lastBlock.cache_control = CACHE_MARKER;
        injected++;
      }
    }
  }

  // Breakpoints 2-4: Last 3 non-system messages
  if (Array.isArray(body.messages) && body.messages.length > 0) {
    const remaining = MAX_BREAKPOINTS - injected;
    const messagesToMark = Math.min(remaining, 3, body.messages.length);

    for (let i = 0; i < messagesToMark; i++) {
      const msgIdx = body.messages.length - 1 - i;
      const msg = body.messages[msgIdx];
      if (!msg) continue;

      if (typeof msg.content === 'string') {
        // Convert string content to array for cache_control
        msg.content = [{
          type: 'text',
          text: msg.content,
          cache_control: CACHE_MARKER,
        }];
        injected++;
      } else if (Array.isArray(msg.content) && msg.content.length > 0) {
        // Mark the last content block in this message
        const lastBlock = msg.content[msg.content.length - 1];
        if (lastBlock && typeof lastBlock === 'object' && !lastBlock.cache_control) {
          lastBlock.cache_control = CACHE_MARKER;
          injected++;
        }
      }
    }
  }

  if (injected > 0) {
    logger.debug({ breakpoints: injected }, '[prompt-cache] Injected cache_control breakpoints');
  }

  return injected;
}

/**
 * Inject cache_control for Gemini/Vertex explicit caching.
 * Uses the same cache_control format — Gemini accepts it via LiteLLM/OpenRouter.
 *
 * @param {Object} body - Request body with system and messages (Anthropic format, pre-conversion)
 * @returns {number} Number of breakpoints injected
 */
function injectGeminiCacheBreakpoints(body) {
  // Gemini uses the same cache_control format when going through
  // OpenRouter or LiteLLM. For direct Gemini API, implicit caching
  // is automatic — no injection needed.
  // We inject anyway for OpenRouter/proxy paths that forward cache_control.
  return injectAnthropicCacheBreakpoints(body);
}

/**
 * Determine if a provider benefits from cache_control injection.
 *
 * @param {string} provider - Provider name
 * @returns {boolean}
 */
function needsCacheInjection(provider) {
  // These providers support explicit cache_control breakpoints
  const EXPLICIT_CACHE_PROVIDERS = new Set([
    'azure-anthropic',
    'bedrock',
    'databricks',   // Databricks routes to Claude which supports caching
    'openrouter',   // OpenRouter forwards cache_control to underlying provider
  ]);

  return EXPLICIT_CACHE_PROVIDERS.has(provider);
}

/**
 * Inject provider-side prompt caching into the request body.
 * Call this before sending to the provider.
 *
 * @param {Object} body - Request body (Anthropic format)
 * @param {string} provider - Provider name
 * @returns {number} Number of breakpoints injected
 */
function injectPromptCaching(body, provider) {
  if (!needsCacheInjection(provider)) return 0;
  return injectAnthropicCacheBreakpoints(body);
}

module.exports = {
  injectPromptCaching,
  injectAnthropicCacheBreakpoints,
  injectGeminiCacheBreakpoints,
  needsCacheInjection,
};
