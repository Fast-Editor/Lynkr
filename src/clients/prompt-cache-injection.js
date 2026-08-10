/**
 * Provider-Side Prompt Cache Injection
 *
 * Injects `cache_control` breakpoints into requests for providers
 * that support explicit prompt caching (Anthropic, Bedrock, Vertex/Gemini).
 *
 * Strategy: "stable_hierarchy" — up to 4 breakpoints ordered by stability
 * (Phase 5, cache-aware routing):
 *   1. Tools block  — never moves (tools render before system in the
 *      provider's prefix, so this read point survives system edits)
 *   2. System prompt — never moves
 *   3. Frozen history boundary — advances only every K user turns
 *      (K = config.memory.distillation.refreshEveryTurns, default 5; shared
 *      with the distiller's freeze window). Deterministic from the message
 *      list, so consecutive requests inside a bucket mark the same bytes.
 *   4. Rolling marker on the newest message — pays the 1.25x write on the
 *      per-turn delta once so the next turn reads it at 0.1x. Kept
 *      deliberately: dropping it would re-pay full input price on
 *      everything after the boundary every turn until the next refresh.
 *
 * The previous "system_and_3" strategy rolled breakpoints 2-4 across the
 * last three messages; markers moved every turn, and history-rewriting
 * layers (distiller) invalidated the prefix wholesale. Stability of the
 * marked bytes is what compounds hits.
 *
 * Providers with automatic caching (OpenAI, DeepSeek) need no injection.
 *
 * @module clients/prompt-cache-injection
 */

const logger = require('../logger');

const CACHE_MARKER = { type: 'ephemeral' };
const MAX_BREAKPOINTS = 4;
const DEFAULT_BOUNDARY_EVERY_TURNS = 5;

function _boundaryEveryTurns() {
  try {
    const config = require('../config');
    const k = config.memory?.distillation?.refreshEveryTurns;
    return Number.isFinite(k) && k > 0 ? k : DEFAULT_BOUNDARY_EVERY_TURNS;
  } catch {
    return DEFAULT_BOUNDARY_EVERY_TURNS;
  }
}

/** Mark the last content block of a message; converts string content. */
function _markMessage(msg) {
  if (!msg) return false;
  if (typeof msg.content === 'string') {
    msg.content = [{
      type: 'text',
      text: msg.content,
      cache_control: CACHE_MARKER,
    }];
    return true;
  }
  if (Array.isArray(msg.content) && msg.content.length > 0) {
    const lastBlock = msg.content[msg.content.length - 1];
    if (lastBlock && typeof lastBlock === 'object' && !lastBlock.cache_control) {
      lastBlock.cache_control = CACHE_MARKER;
      return true;
    }
  }
  return false;
}

/**
 * Index of the frozen-boundary message: the bucket-th user-role message,
 * where bucket = floor(userTurns / K) * K. Deterministic in the message
 * list, so every request inside a K-turn bucket marks the same message —
 * the marked prefix bytes stay identical until the bucket advances.
 *
 * @returns {number} message index, or -1 when the conversation is too
 *   young (bucket < K) or the boundary can't be placed.
 */
function _frozenBoundaryIndex(messages, everyTurns) {
  if (!Array.isArray(messages) || messages.length === 0) return -1;
  const userIdx = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i]?.role === 'user') userIdx.push(i);
  }
  const bucket = Math.floor(userIdx.length / everyTurns) * everyTurns;
  if (bucket < everyTurns) return -1;
  return userIdx[bucket - 1];
}

/**
 * Inject cache_control breakpoints into an Anthropic-format request body.
 * Mutates the body in-place for zero-copy performance.
 *
 * @param {Object} body - Request body with system, tools, and messages
 * @returns {number} Number of breakpoints injected
 */
function injectAnthropicCacheBreakpoints(body) {
  if (!body) return 0;

  let injected = 0;

  // Breakpoint 1: tools block — most stable prefix region.
  if (Array.isArray(body.tools) && body.tools.length > 0) {
    const lastTool = body.tools[body.tools.length - 1];
    if (lastTool && typeof lastTool === 'object' && !lastTool.cache_control) {
      lastTool.cache_control = CACHE_MARKER;
      injected++;
    }
  }

  // Breakpoint 2: system prompt.
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

  if (Array.isArray(body.messages) && body.messages.length > 0) {
    const lastIdx = body.messages.length - 1;

    // Breakpoint 3: frozen history boundary (advances every K user turns).
    const boundaryIdx = _frozenBoundaryIndex(body.messages, _boundaryEveryTurns());
    if (boundaryIdx >= 0 && boundaryIdx < lastIdx && injected < MAX_BREAKPOINTS) {
      if (_markMessage(body.messages[boundaryIdx])) injected++;
    }

    // Breakpoint 4: rolling marker on the newest message — caches this
    // turn's delta so the next turn reads it instead of re-paying input.
    if (injected < MAX_BREAKPOINTS) {
      if (_markMessage(body.messages[lastIdx])) injected++;
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
    'edenai',       // Eden AI forwards cache_control to underlying provider
  ]);

  return EXPLICIT_CACHE_PROVIDERS.has(provider);
}

// Model families that do NOT support cache_control breakpoints. cache_control
// is an Anthropic construct; on aggregating providers (Bedrock, OpenRouter) it
// only applies to models that natively understand it (Claude, and Gemini via
// proxy). Injecting markers onto these families produces request shapes the
// upstream model rejects or silently ignores.
const NON_CACHE_MODEL_PATTERNS = [
  /(^|[./-])titan/i,
  /(^|[./-])nova/i,
  /(^|[./-])llama/i,
  /(^|[./-])mistral/i,
  /(^|[./-])mixtral/i,
  /(^|[./-])cohere/i,
  /(^|[./-])command/i, // cohere command-*
  /(^|[./-])j2/i,      // ai21 jurassic
  /(^|[./-])jamba/i,
  /(^|[./-])deepseek/i,
  /(^|[./-])qwen/i,
  /(^|[./-])gpt/i,
  /(^|[./-])openai/i,
];

/**
 * Determine whether the model targeted by this request supports cache_control.
 *
 * Some providers in EXPLICIT_CACHE_PROVIDERS (notably bedrock and openrouter)
 * route to many model families, only some of which understand cache_control.
 * This guard inspects the resolved model id and blocks injection for families
 * that are known not to support it. When the model id is absent or
 * unrecognized, injection is allowed (fail-open) — Claude/Gemini-style ids and
 * Anthropic-only providers fall through to true.
 *
 * @param {Object} body - Request body (may carry the resolved model id)
 * @param {string} provider - Provider name
 * @returns {boolean}
 */
function modelSupportsCacheControl(body, provider) {
  // Providers that only ever route to Anthropic models always support it.
  if (provider === 'azure-anthropic' || provider === 'databricks') return true;

  const modelId = body && (body._tierModel || body.model);
  if (!modelId || typeof modelId !== 'string') return true; // unknown → fail open

  return !NON_CACHE_MODEL_PATTERNS.some(re => re.test(modelId));
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
  // Gate on model capability: a provider may support cache_control in general
  // while the specific routed model does not.
  if (!modelSupportsCacheControl(body, provider)) return 0;
  // If the client (e.g. Claude Code) already attached cache_control breakpoints,
  // don't add more. Anthropic caps at 4 breakpoints per request and stacking ours
  // on top has caused 400/429 errors on OAuth subscription requests.
  if (hasExistingCacheControl(body)) return 0;
  return injectAnthropicCacheBreakpoints(body);
}

function hasExistingCacheControl(body) {
  if (!body) return false;
  const scan = (obj) => {
    if (!obj || typeof obj !== 'object') return false;
    if (Array.isArray(obj)) return obj.some(scan);
    if (obj.cache_control) return true;
    return Object.values(obj).some(scan);
  };
  return scan(body.system) || scan(body.messages) || scan(body.tools);
}

module.exports = {
  injectPromptCaching,
  injectAnthropicCacheBreakpoints,
  injectGeminiCacheBreakpoints,
  needsCacheInjection,
  modelSupportsCacheControl,
};
