/**
 * Smart Routing Module
 *
 * Intelligent request routing based on complexity analysis.
 * Routes simple requests to local models (Ollama, llama.cpp)
 * and complex requests to cloud providers.
 *
 * @module routing
 */

const config = require('../config');
const logger = require('../logger');
const {
  analyzeComplexity,
  shouldForceLocal,
  shouldForceCloud,
  shouldForceReasoning,
  routingMetrics,
  analyzeWithEmbeddings,
} = require('./complexity-analyzer');

// Intelligent routing modules
const { getAgenticDetector, AGENT_TYPES } = require('./agentic-detector');
const { getModelTierSelector, TIER_DEFINITIONS } = require('./model-tiers');
const { getCostOptimizer } = require('./cost-optimizer');
const { analyzeRisk } = require('./risk-classifier');
const { scoreIntent, intentScoreMode } = require('./intent-score');

// Phase 3-6 routing modules
const { getKnnRouter } = require('./knn-router');
const { getBandit } = require('./bandit');
const { getShadowPolicy, compareAndLog: shadowCompareAndLog } = require('./shadow-mode');
const { chooseFastest } = require('./deadline');
const { applyTenantOverrides } = require('./tenant-policy');

// Telemetry modules
const telemetry = require('./telemetry');
const { scoreResponseQuality } = require('./quality-scorer');
const { getLatencyTracker } = require('./latency-tracker');

// Phase 1 modules
const contextValidator = require('./context-validator');
const { countPayloadTokens } = require('./tokenizer');

// Degradation registry — swallows silent fallbacks into a counted signal.
const degradation = require('./degradation');

// WS2.3 — de-escalation policy (evidence-gated tier demotion).
const deescalator = require('./deescalator');
try {
  const shadow = require('./shadow-mode');
  shadow.registerPolicy('deescalate-v1', deescalator.shadowDeescalate);
} catch (err) {
  // shadow-mode is optional here — the policy just won't be available
  logger.debug({ err: err.message }, '[Routing] Failed to register deescalate-v1 shadow policy');
}

// Local providers
const LOCAL_PROVIDERS = ['ollama', 'llamacpp', 'lmstudio'];

/**
 * Returns true when any message content block is an image.
 * Handles both string content and structured content arrays.
 */
function _payloadHasImages(payload) {
  const messages = payload?.messages;
  if (!Array.isArray(messages)) return false;
  return messages.some(msg => {
    const content = msg?.content;
    if (!Array.isArray(content)) return false;
    return content.some(block => block?.type === 'image' || block?.type === 'image_url');
  });
}

/**
 * List of providers that currently have credentials configured.
 * Used by the Phase 1.2 cost-optimizer override to scope candidates.
 */
function _enabledProviders() {
  const out = [];
  if (config.databricks?.url && config.databricks?.apiKey) out.push('databricks');
  if (config.azureAnthropic?.endpoint && config.azureAnthropic?.apiKey) out.push('azure-anthropic');
  if (config.bedrock?.apiKey) out.push('bedrock');
  if (config.openrouter?.apiKey) out.push('openrouter');
  if (config.edenai?.apiKey) out.push('edenai');
  if (config.openai?.apiKey) out.push('openai');
  if (config.azureOpenAI?.endpoint && config.azureOpenAI?.apiKey) out.push('azure-openai');
  if (config.ollama?.endpoint) out.push('ollama');
  if (config.llamacpp?.endpoint) out.push('llamacpp');
  if (config.lmstudio?.endpoint) out.push('lmstudio');
  return out;
}

/**
 * Check if a provider is local
 */
function isLocalProvider(provider) {
  return LOCAL_PROVIDERS.includes(provider);
}

/**
 * Check if fallback is enabled
 */
function isFallbackEnabled() {
  return config.modelProvider?.fallbackEnabled !== false;
}

/**
 * Get the configured fallback provider
 */
function getFallbackProvider() {
  return config.modelProvider?.fallbackProvider ?? 'databricks';
}

/**
 * Get the best available cloud provider
 * @param {Object} options - Options for provider selection
 * @param {number} options.toolCount - Number of tools in the request (for hybrid routing)
 * @param {boolean} options.useHybridRouting - Whether to use hybrid routing logic (default: false)
 */
function getBestCloudProvider() {
  // Standard priority order for cloud providers
  if (config.databricks?.url && config.databricks?.apiKey) return 'databricks';
  if (config.azureAnthropic?.endpoint && config.azureAnthropic?.apiKey) return 'azure-anthropic';
  if (config.bedrock?.apiKey) return 'bedrock';
  if (config.openrouter?.apiKey) return 'openrouter';
  if (config.edenai?.apiKey) return 'edenai';
  if (config.openai?.apiKey) return 'openai';
  if (config.azureOpenAI?.endpoint && config.azureOpenAI?.apiKey) return 'azure-openai';

  return getFallbackProvider();
}

/**
 * Get the best available local provider
 */
function getBestLocalProvider() {
  if (config.ollama?.endpoint) return 'ollama';
  if (config.llamacpp?.endpoint) return 'llamacpp';
  if (config.lmstudio?.endpoint) return 'lmstudio';

  return 'ollama';  // Default
}

/**
 * Determine the optimal provider based on request complexity
 *
 * This is the main routing function that implements all 4 phases:
 * - Phase 1: Basic scoring (tokens, tools, task type)
 * - Phase 2: Advanced classification (code complexity, reasoning)
 * - Phase 3: Metrics tracking
 * - Phase 4: Optional embeddings-based adjustment
 *
 * @param {Object} payload - Request payload
 * @param {Object} options - Routing options
 * @returns {Object} Routing decision with provider and metadata
 */
const sessionAffinity = require('./session-affinity');

// ---------------------------------------------------------------------------
// WS1 — sticky sessions
//
// The wrapper below implements cache-aware sticky routing. Routing decisions
// happen once per session (persisted so process restarts don't lose the pin)
// and are re-evaluated only at explicit triggers: compaction, guard
// escalation (risk/context/vision), or an economic downgrade that beats the
// estimated cost of the cold-cache re-read.
// ---------------------------------------------------------------------------

const TIER_ORDER = ['SIMPLE', 'MEDIUM', 'COMPLEX', 'REASONING'];

function _tierPriority(tier) {
  const idx = TIER_ORDER.indexOf(tier);
  return idx < 0 ? -1 : idx;
}

/**
 * Run the cheap guards a pin must satisfy for the current turn:
 *   - Risk analysis: if `risk.level === 'high'`, the pin can't serve
 *     regardless of its model.
 *   - Context fit: pinned model's context window vs estimated prompt tokens.
 *   - Vision need: payload has images ⇒ pinned model must have vision.
 *
 * @param {object} payload
 * @param {{provider:string, model:string|null, tier:string|null}} pin
 * @returns {{ok:boolean, reason:string|null, risk:object|null, promptTokensEst:number|null}}
 */
function _runPinGuards(payload, pin) {
  let risk = null;
  try {
    risk = analyzeRisk(payload);
  } catch (err) {
    degradation.record('risk', err);
  }
  if (risk?.level === 'high') {
    return { ok: false, reason: 'risk', risk, promptTokensEst: null };
  }

  let promptTokensEst = null;
  try {
    if (pin.model) {
      promptTokensEst = countPayloadTokens(payload, pin.model);
      const ctxResult = contextValidator.validate(pin.model, promptTokensEst);
      if (!ctxResult.ok) {
        return { ok: false, reason: 'context', risk, promptTokensEst };
      }
    }
  } catch (err) {
    degradation.record('context_validate', err);
  }

  if (_payloadHasImages(payload)) {
    try {
      const { getModelRegistrySync } = require('./model-registry');
      const registry = getModelRegistrySync();
      const modelInfo = pin.model ? registry.getCost(pin.model) : null;
      if (!modelInfo?.vision) {
        return { ok: false, reason: 'vision', risk, promptTokensEst };
      }
    } catch (err) {
      degradation.record('vision_guard', err);
    }
  }

  return { ok: true, reason: null, risk, promptTokensEst };
}

/**
 * True when the fresh decision may replace the pin from a cost perspective.
 * The rule (per WS1 plan):
 *   - Fresh model must be strictly cheaper than the pin's model per
 *     cost-optimizer.estimateCost (per-1000-token estimate).
 *   - Estimated prompt tokens must be below LYNKR_SWITCH_MAX_PROMPT_TOKENS
 *     (default 20k) — beyond that the cold-cache re-read dominates the
 *     savings.
 *   - Fresh must be ≥25% cheaper.
 *
 * Returns false (i.e. suppress the switch) when either bound fails.
 *
 * @param {number|null} promptTokensEst
 * @param {string|null} pinModel
 * @param {string|null} freshModel
 * @returns {boolean}
 */
function _economicDowngradeAllowed(promptTokensEst, pinModel, freshModel) {
  if (!pinModel || !freshModel || pinModel === freshModel) return true;
  const maxPromptTokens = Number(process.env.LYNKR_SWITCH_MAX_PROMPT_TOKENS) || 20000;
  if (promptTokensEst != null && promptTokensEst >= maxPromptTokens) return false;
  try {
    const optimizer = getCostOptimizer();
    const pinCost = optimizer.estimateCost(pinModel, 1000);
    const freshCost = optimizer.estimateCost(freshModel, 1000);
    if (!pinCost?.totalEstimate || !freshCost?.totalEstimate) return true;
    return freshCost.totalEstimate <= pinCost.totalEstimate * 0.75;
  } catch (err) {
    degradation.record('cost_optimize', err);
    return true; // fail-open: if we can't compare, let the fresh decision through
  }
}

function _pinToDecision(pin, { reason, risk }) {
  return {
    provider: pin.provider,
    model: pin.model,
    tier: pin.tier,
    method: 'session_pin',
    reason,
    score: null,
    analysis: null,
    embeddingsResult: null,
    agenticResult: null,
    costOptimized: false,
    risk: risk ?? null,
    knnResult: null,
    base_tier: null,
    escalations: [],
    escalation_source: null,
    pinned: true,
    switch_reason: null,
    propensity: 1.0,
    candidates: [{ provider: pin.provider, model: pin.model }],
  };
}

/**
 * Provider routing with cache-aware session pinning.
 *
 * Fast path: when a session has a pin and the cheap guards pass, we skip
 * complexity analysis, kNN, and the bandit entirely and serve the pin.
 * Slow path: no pin, compaction, or a guard forces a re-decide.
 *
 * The pin evaluation itself lives in `checkSessionPin` so this path and the
 * OAuth intent path in `src/api/router.js` use the same trigger rules.
 * Gated by `LYNKR_STICKY_SESSIONS !== 'false'`.
 */
async function determineProviderSmart(payload, options = {}) {
  const pinCheck = checkSessionPin(payload, options);

  // Bypass (no session / forceProvider / feature-off) or no pin yet →
  // straight to fresh routing, then persist the outcome for the next turn.
  if (pinCheck.reason === 'bypass' || pinCheck.reason === 'no_pin') {
    const fresh = await _determineProviderSmartInner(payload, options);
    if (pinCheck.sessionId && fresh?.provider) {
      writeSessionPin(pinCheck.sessionId, fresh, payload);
    }
    return fresh;
  }

  // Pin serves — either mid-tool-exchange (unconditional) or guards passed.
  if (pinCheck.serve) {
    // WS1.5 — upward-drift escape hatch. Only on guards_passed turns:
    // tool_history serves must NEVER switch (tool-call IDs break across
    // providers), and drift-checking them would risk exactly that.
    if (pinCheck.reason === 'guards_passed') {
      const drift = await checkPinScoreDrift(pinCheck.pin, payload);
      if (drift.drift) {
        logger.info({
          sessionId: pinCheck.sessionId,
          pinnedTier: pinCheck.pin.tier,
          freshScore: drift.freshScore,
          ceiling: drift.ceiling,
        }, '[Routing] Pin score drift — re-deciding');
        const fresh = await _determineProviderSmartInner(payload, options);
        fresh.pinned = false;
        fresh.switch_reason = 'score_drift';
        if (_tierPriority(fresh.tier) >= _tierPriority(pinCheck.pin.tier)) {
          writeSessionPin(pinCheck.sessionId, fresh, payload);
        }
        return fresh;
      }
    }
    const reasonLabel = pinCheck.reason === 'tool_history'
      ? 'tool_history_provider_pin'
      : 'guards_passed';
    logger.debug({
      sessionId: pinCheck.sessionId,
      provider: pinCheck.pin.provider,
      tier: pinCheck.pin.tier,
      reason: reasonLabel,
    }, '[Routing] Serving session pin');
    return _pinToDecision(pinCheck.pin, { reason: reasonLabel, risk: null });
  }

  // Pin exists but a trigger fired. Run fresh routing.
  const pin = pinCheck.pin;
  const fresh = await _determineProviderSmartInner(payload, options);
  fresh.pinned = false;

  // Compaction: prompt cache was reset upstream, so switching is free EXCEPT
  // when the switch would be to a cheaper model that doesn't pay for the
  // cold-cache re-read at the current prompt size. The economic guard only
  // fires on the compaction path — guard escalations are mandatory.
  if (pinCheck.reason === 'compaction') {
    fresh.switch_reason = 'compaction';
    const promptTokensEst = _tryCountTokens(payload, pin.model || fresh.model);
    if (!_economicDowngradeAllowed(promptTokensEst, pin.model, fresh.model)) {
      logger.debug({
        sessionId: pinCheck.sessionId,
        pinModel: pin.model,
        freshModel: fresh.model,
        promptTokensEst,
      }, '[Routing] Economic downgrade suppressed — staying on pin');
      const served = _pinToDecision(pin, { reason: 'economic_suppressed', risk: null });
      writeSessionPin(pinCheck.sessionId, pin, payload);
      return served;
    }
    writeSessionPin(pinCheck.sessionId, fresh, payload);
    return fresh;
  }

  // Vision-only escalation: use the vision-capable model for THIS turn but
  // don't overwrite the pin — the next non-image turn should fall back to
  // the cheaper pinned model.
  if (pinCheck.reason === 'vision') {
    fresh.switch_reason = 'guard_escalation';
    logger.debug({
      sessionId: pinCheck.sessionId,
      pinModel: pin.model,
      freshModel: fresh.model,
    }, '[Routing] Vision guard fired — pinExempt, not re-pinning');
    return fresh;
  }

  // Risk/context escalation: re-pin upward when the fresh tier is at least
  // as capable as the pinned tier (typical) — downgrades from a guard fail
  // are rare and we leave the old pin alone in that case.
  fresh.switch_reason = 'guard_escalation';
  if (_tierPriority(fresh.tier) >= _tierPriority(pin.tier)) {
    writeSessionPin(pinCheck.sessionId, fresh, payload);
  }
  return fresh;
}

function _tryCountTokens(payload, model) {
  if (!model) return null;
  try {
    return countPayloadTokens(payload, model);
  } catch (err) {
    degradation.record('context_validate', err);
    return null;
  }
}

// WS1.5 — upward-drift margin. A pinned session re-decides when the latest
// user message scores this many points ABOVE the pinned tier's calibrated
// ceiling. 15 ≈ half a tier band: enough that score jitter on borderline
// messages doesn't thrash the pin, small enough that "Hi" → "refactor the
// whole repo" escapes a SIMPLE pin on the very turn the task escalates.
const PIN_DRIFT_MARGIN = Number(process.env.LYNKR_PIN_DRIFT_MARGIN) || 15;

/**
 * WS1.5 — detect upward complexity drift on a pinned session.
 *
 * WS1's re-decide triggers (compaction, risk, context, vision, economics)
 * all miss the most common real-world case: the session OPENED trivially
 * ("Hi" → pinned SIMPLE) and then the real task arrived ("plan a refactor
 * of the whole repo"). Nothing about that turn trips a guard, so the pin
 * held the session on the SIMPLE-tier model forever.
 *
 * This scores ONLY the latest user message (cheap heuristic pass — no
 * embeddings, no kNN, no bandit) and compares it against the pinned
 * tier's calibrated score ceiling. Exceeding ceiling + PIN_DRIFT_MARGIN
 * means the conversation has outgrown its pin → caller falls through to
 * full routing and re-pins upward.
 *
 * Deliberately one-directional: downward drift stays pinned (the economic
 * downgrade rule owns that case, where switching costs a cold cache read).
 *
 * @param {{tier:string|null}} pin
 * @param {object} payload — full request payload
 * @returns {Promise<{drift:boolean, freshScore:number|null, ceiling:number|null}>}
 */
async function checkPinScoreDrift(pin, payload) {
  const none = { drift: false, freshScore: null, ceiling: null };
  try {
    const tier = pin?.tier;
    if (!tier || tier === 'REASONING') return none; // already at the top
    const idx = _tierPriority(tier);
    if (idx < 0) return none;

    const msgs = payload?.messages;
    if (!Array.isArray(msgs)) return none;
    const lastUser = [...msgs].reverse().find(m => m?.role === 'user');
    if (!lastUser) return none;
    const rawText = typeof lastUser.content === 'string'
      ? lastUser.content
      : Array.isArray(lastUser.content)
        ? lastUser.content.filter(b => b?.type === 'text').map(b => b.text || '').join(' ')
        : '';
    const text = rawText.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
    if (!text) return none; // tool-result-only turn etc. — nothing to score

    // Force-cloud patterns are absolute overrides ("refactor the entire
    // codebase", "security audit", "architecture review" — always cloud,
    // regardless of score). Full routing honours them, but a pinned turn
    // never reaches full routing — live incident (2026-07-07): "refactor
    // the entire codebase give me a plan" scored 28, missed the drift
    // threshold by 1, and rode a SIMPLE pin instead of force-routing to
    // cloud. Treat a force-cloud match on the TYPED text as drift so the
    // caller falls through to full routing, where the pattern fires
    // properly. (force_local is deliberately NOT checked here — downward
    // moves stay pinned per the economics rule.)
    if (shouldForceCloud({ messages: [{ role: 'user', content: text }] })) {
      return { drift: true, freshScore: 100, ceiling: null, forced: 'force_cloud' };
    }

    // Agentic-autonomous is a trigger of the same rank as force-cloud, and
    // its anchor score alone can't clear ceiling+margin — without this
    // escape, autonomous asks are trapped by any pin.
    try {
      const agentic = getAgenticDetector().detect(
        { messages: [{ role: 'user', content: text }], tools: payload.tools },
        { clientProfile: payload._clientProfile || null },
      );
      if (agentic?.agentType === 'AUTONOMOUS') {
        return { drift: true, freshScore: 100, ceiling: null, forced: 'agentic_autonomous' };
      }
    } catch { /* detector failure never blocks the pin path */ }

    // Heuristic-only score of the isolated message. Mirrors the intent
    // scorer's shape (single message + tools + client profile) so the
    // number is comparable to the score that produced the pin.
    // Pins hold anchor scores, so drift must use the same scorer or
    // ceiling+margin comparisons are meaningless.
    let freshScore = null;
    if (intentScoreMode() !== 'legacy') {
      const intent = await scoreIntent({ messages: [{ role: 'user', content: text }] });
      if (intent && Number.isFinite(intent.score)) freshScore = intent.score;
    }
    if (freshScore === null) {
      const analysis = await analyzeComplexity({
        messages: [{ role: 'user', content: text }],
        tools: payload.tools,
        _clientProfile: payload._clientProfile,
      }, {});
      freshScore = analysis?.score;
    }
    if (typeof freshScore !== 'number') return none;

    // Calibrated ceiling for the pinned tier (falls back to defaults).
    const selector = getModelTierSelector();
    const ranges = selector.ranges || {};
    const ceiling = Array.isArray(ranges[tier]) ? ranges[tier][1]
      : TIER_DEFINITIONS[tier]?.range?.[1];
    if (typeof ceiling !== 'number') return none;

    return { drift: freshScore > ceiling + PIN_DRIFT_MARGIN, freshScore, ceiling };
  } catch (err) {
    degradation.record('tier_select', err);
    return none;
  }
}

/**
 * Sticky-session pin check used by both `determineProviderSmart` (full
 * pipeline) and the OAuth intent path in `src/api/router.js`. The two paths
 * decide provider differently but agree on WHEN to reuse a pin, so this
 * central function keeps that policy in one place.
 *
 * Returns:
 *   { serve: true,  pin, reason, sessionId }  — reuse the pinned decision
 *   { serve: false, pin?, reason?, sessionId } — run full routing
 *
 * Refreshes the pin's ts/messageCount on serve so an active session doesn't
 * TTL-expire mid-conversation. Never throws.
 *
 * @param {object} payload
 * @param {object} [options]
 * @returns {{serve:boolean, pin?:object, reason:string, sessionId:string|null}}
 */
function checkSessionPin(payload, options = {}) {
  const sessionId = payload?._sessionId || null;
  const stickyEnabled = process.env.LYNKR_STICKY_SESSIONS !== 'false';
  if (!stickyEnabled || !sessionId || options.forceProvider) {
    return { serve: false, sessionId: null, reason: 'bypass' };
  }
  const pin = sessionAffinity.getPin(sessionId);
  if (!pin) return { serve: false, sessionId, reason: 'no_pin' };

  const messageCount = Array.isArray(payload?.messages) ? payload.messages.length : 0;
  // Opener-only conversations (≤2 messages) never consume pins either —
  // a visible pin may belong to a different conversation with the same
  // opener, and a full route on frame 1-2 costs one cached embed.
  if (messageCount <= 2) {
    return { serve: false, pin, sessionId, reason: 'opener_conversation' };
  }
  // Tool-less requests are harness side traffic (title generation,
  // summarization, memory extraction) replaying the conversation. They may
  // be SERVED from the pin but must not refresh its ts/messageCount — a
  // side request's message count includes wrapper turns, and persisting it
  // makes the next real turn look compacted (phantom re-route).
  const refreshOk = Array.isArray(payload?.tools) && payload.tools.length > 0;

  if (sessionAffinity.payloadHasToolHistory(payload)) {
    // Text typed during a tool loop arrives merged with the pending
    // tool_result, where the pin serves unconditionally (id linkage forbids
    // switching mid-exchange). If that embedded text trips a trigger, drop
    // the pin so the next turn boundary re-routes.
    try {
      const { extractCleanUserText } = require('./intent-score');
      const lastMsg = payload.messages[payload.messages.length - 1];
      const embedded = extractCleanUserText({ messages: [lastMsg] });
      if (embedded) {
        const trippedForce = shouldForceCloud({ messages: [{ role: 'user', content: embedded }] });
        const agentic = trippedForce ? null : getAgenticDetector().detect(
          { messages: [{ role: 'user', content: embedded }], tools: payload.tools },
          { clientProfile: payload._clientProfile || null },
        );
        if (trippedForce || agentic?.agentType === 'AUTONOMOUS') {
          sessionAffinity.removePin(sessionId);
          logger.info({
            sessionId,
            trigger: trippedForce ? 'force_cloud' : 'agentic_autonomous',
            pinnedTier: pin.tier,
          }, '[Routing] Trigger text embedded in tool exchange — pin dropped, next boundary re-routes');
          return { serve: true, pin, reason: 'tool_history_pin_dropped', sessionId };
        }
      }
    } catch { /* never block the pin-serve path */ }
    if (refreshOk) {
      sessionAffinity.setPin(sessionId, pin, {
        // Monotonic within a pin's lifetime: refreshes must never SHRINK the
        // recorded conversation size, or a short colliding session blinds
        // the new_conversation guard for everyone after it.
        messageCount: Math.max(messageCount, pin.messageCount ?? 0),
        promptTokensEst: pin.promptTokensEst,
      });
    }
    return { serve: true, pin, reason: 'tool_history', sessionId };
  }

  const repin = sessionAffinity.shouldRepin(pin, payload);
  if (repin.repin) return { serve: false, pin, sessionId, reason: repin.reason };

  const guards = _runPinGuards(payload, pin);
  if (!guards.ok) return { serve: false, pin, sessionId, reason: guards.reason };

  if (refreshOk) {
    sessionAffinity.setPin(sessionId, pin, {
      messageCount: Math.max(messageCount, pin.messageCount ?? 0),
      promptTokensEst: guards.promptTokensEst ?? pin.promptTokensEst,
    });
  }
  return { serve: true, pin, reason: 'guards_passed', sessionId };
}

/**
 * Write-through helper: persist a fresh routing decision as the session's
 * new pin. No-op when sessionId is missing or the decision has no provider.
 *
 * Risk-forced decisions are NEVER pinned. Risk analysis runs on every turn
 * (both in `_runPinGuards` and inner routing), so escalating THIS turn is
 * already guaranteed without a pin — pinning it only creates a one-way
 * ratchet where a single phantom risk hit (live incidents: harness
 * suggestion-mode wrapper text, replayed repo transcripts) locks the whole
 * conversation onto the expensive tier. If the next turn is genuinely
 * risky, risk fires again then.
 *
 * @param {string|null} sessionId
 * @param {object} decision
 * @param {object} payload
 */
function writeSessionPin(sessionId, decision, payload) {
  if (!sessionId || !decision?.provider) return;
  const method = decision.method || '';
  if (method === 'risk' || method.startsWith('risk+') || decision.escalation_source === 'risk') {
    logger.debug({
      sessionId,
      provider: decision.provider,
      tier: decision.tier,
      method,
    }, '[Routing] Risk-forced decision — pin write skipped');
    return;
  }
  const messageCount = Array.isArray(payload?.messages) ? payload.messages.length : 0;
  // Opener-only sessions (≤2 messages) never pin: a bare opener has nothing
  // to stabilize, and identical openers share a fingerprint for the 6h TTL,
  // so any pin written here leaks to unrelated sessions.
  if (messageCount <= 2) {
    logger.debug({ sessionId, tier: decision.tier, messageCount },
      '[Routing] Opener-only session — pin write skipped');
    return;
  }
  const promptTokensEst = _tryCountTokens(payload, decision.model);
  sessionAffinity.setPin(sessionId, decision, { messageCount, promptTokensEst });
}

async function _determineProviderSmartInner(payload, options = {}) {
  const primaryProvider = config.modelProvider?.type ?? 'databricks';

  // Risk analysis runs orthogonally to complexity. We compute it once
  // up-front so it can short-circuit force_local and feed the tier
  // selector below. Even when tier routing is disabled we still surface
  // the signal for telemetry.
  let risk = null;
  try {
    risk = analyzeRisk(payload);
  } catch (err) {
    degradation.record('risk', err);
    risk = null;
  }

  // WS5.5 — hoist query-text + embedding capture to the top so every
  // decision-return path (static, risk-forced, force-local/cloud,
  // autonomous-agentic, kNN-driven main path) attaches `_queryEmbedding`
  // consistently. Without this, risk-forced short-circuits skip the kNN
  // block entirely and the feedback loop can never add those outcomes as
  // exemplars — which is exactly the path that most needs learning (e.g.
  // "encrypt" trigrams that keep landing high-risk on trivial prompts).
  // Extraction is cheap (string parse); embedding is one HTTP call to
  // Ollama (~200ms). Both are best-effort and fall through as null.
  let queryText = null;
  let queryEmbedding = null;
  if (config.routing?.knnEnabled !== false) {
    try {
      const msgs = payload?.messages;
      const lastMsg = Array.isArray(msgs) ? msgs[msgs.length - 1]?.content : null;
      queryText = typeof lastMsg === 'string' ? lastMsg
        : Array.isArray(lastMsg) ? lastMsg.filter(b => b?.type === 'text').map(b => b.text || '').join(' ')
        : null;
      if (queryText) {
        queryEmbedding = await getKnnRouter().embed(queryText);
      }
    } catch (err) {
      degradation.record('knn', err);
    }
  }

  // If tier routing is disabled, use static configuration
  if (!config.modelTiers?.enabled) {
    return {
      provider: primaryProvider,
      model: null,
      method: 'static',
      reason: 'tier_routing_disabled',
      risk,
      propensity: 1.0,
      candidates: [{ provider: primaryProvider, model: null }],
      _queryEmbedding: queryEmbedding,
      _queryText: queryText,
    };
  }

  // High-risk requests jump straight to COMPLEX and skip the rest of
  // the analysis. This is independent of complexity score — a one-line
  // edit to auth/middleware.ts should never go to a local model.
  if (risk?.level === 'high' && isFallbackEnabled()) {
    try {
      const selector = getModelTierSelector();
      // Config B (local → GLM → Claude): high-risk requests route to the
      // trusted provider (Claude) via REASONING, not the mid-tier GLM.
      // Security/auth/middleware changes belong on the governance path.
      const modelSelection = selector.selectModel('REASONING', null);
      const decision = {
        provider: modelSelection.provider,
        model: modelSelection.model,
        tier: 'REASONING',
        method: 'risk',
        reason: 'high_risk_forced_tier',
        score: 100,
        risk,
        base_tier: null,
        escalations: [{
          source: 'risk',
          fromTier: null,
          toTier: 'REASONING',
          fromModel: null,
          toModel: modelSelection.model,
        }],
        escalation_source: 'risk',
        propensity: 1.0,
        candidates: [{ provider: modelSelection.provider, model: modelSelection.model }],
        _queryEmbedding: queryEmbedding,
        _queryText: queryText,
      };
      routingMetrics.record(decision);
      logger.debug({
        tier: 'REASONING',
        provider: decision.provider,
        instructionHits: risk.instructionHits,
        pathHits: risk.pathHits,
      }, '[Routing] High risk → forcing tier');
      return decision;
    } catch (err) {
      degradation.record('tier_select', err);
    }
  }

  // Quick check for force patterns
  if (shouldForceLocal(payload)) {
    // When tier routing is enabled, respect TIER_SIMPLE instead of blindly choosing local
    if (config.modelTiers?.enabled) {
      try {
        const selector = getModelTierSelector();
        const modelSelection = selector.selectModel('SIMPLE', null);
        const decision = {
          provider: modelSelection.provider,
          model: modelSelection.model,
          tier: 'SIMPLE',
          method: 'force',
          reason: 'force_local_pattern',
          score: 0,
          risk,
          propensity: 1.0,
          candidates: [{ provider: modelSelection.provider, model: modelSelection.model }],
          _queryEmbedding: queryEmbedding,
          _queryText: queryText,
        };
        routingMetrics.record(decision);
        return decision;
      } catch (err) {
        degradation.record('tier_select', err);
      }
    }
    const provider = getBestLocalProvider();
    const decision = {
      provider,
      model: null,
      method: 'force',
      reason: 'force_local_pattern',
      score: 0,
      risk,
      propensity: 1.0,
      candidates: [{ provider, model: null }],
      _queryEmbedding: queryEmbedding,
      _queryText: queryText,
    };
    routingMetrics.record(decision);
    return decision;
  }

  // Force REASONING (Claude in config B) — checked before force_cloud.
  // Matches ultrathink/prove/security-audit/first-principles. Deterministic
  // routing to the top tier regardless of embedding score.
  if (shouldForceReasoning(payload) && isFallbackEnabled() && config.modelTiers?.enabled) {
    try {
      const selector = getModelTierSelector();
      const modelSelection = selector.selectModel('REASONING', null);
      const decision = {
        provider: modelSelection.provider,
        model: modelSelection.model,
        tier: 'REASONING',
        method: 'force',
        reason: 'force_reasoning_pattern',
        score: 100,
        risk,
        propensity: 1.0,
        candidates: [{ provider: modelSelection.provider, model: modelSelection.model }],
        _queryEmbedding: queryEmbedding,
        _queryText: queryText,
      };
      routingMetrics.record(decision);
      return decision;
    } catch (err) {
      degradation.record('tier_select', err);
    }
  }

  if (shouldForceCloud(payload) && isFallbackEnabled()) {
    // When tier routing is enabled, force-cloud means the COMPLEX tier's
    // configured model — NOT getBestCloudProvider()'s credential-priority
    // list. That list starts with databricks-if-credentialed, and installs
    // running pure tier routing carry DUMMY databricks values to pass
    // startup validation (live incident 2026-07-07: an "architecture
    // review" force-cloud routed to the dummy base http://localhost:8081 —
    // Lynkr proxying to itself — and hung). Mirrors the force_local branch,
    // which got the same tier-aware fix long ago.
    if (config.modelTiers?.enabled) {
      try {
        const selector = getModelTierSelector();
        const modelSelection = selector.selectModel('COMPLEX', null);
        const decision = {
          provider: modelSelection.provider,
          model: modelSelection.model,
          tier: 'COMPLEX',
          method: 'force',
          reason: 'force_cloud_pattern',
          score: 100,
          risk,
          propensity: 1.0,
          candidates: [{ provider: modelSelection.provider, model: modelSelection.model }],
          _queryEmbedding: queryEmbedding,
          _queryText: queryText,
        };
        routingMetrics.record(decision);
        return decision;
      } catch (err) {
        degradation.record('tier_select', err);
      }
    }
    const provider = getBestCloudProvider();
    const decision = {
      provider,
      model: null,
      method: 'force',
      reason: 'force_cloud_pattern',
      score: 100,
      risk,
      propensity: 1.0,
      candidates: [{ provider, model: null }],
      _queryEmbedding: queryEmbedding,
      _queryText: queryText,
    };
    routingMetrics.record(decision);
    return decision;
  }

  // Full complexity analysis (pass workspace for code-graph integration)
  const useWeightedScoring = config.routing?.weightedScoring ?? false;
  const analysis = await analyzeComplexity(payload, { weighted: useWeightedScoring, workspace: options.workspace });

  // WS7 — replace the full-payload lexical score with the anchor score of
  // cleaned user text (payload-invariant). Envelope signals escalate via
  // triggers, never via this score. LYNKR_INTENT_SCORE_MODE=legacy opts out.
  let intentScored = false;
  try {
    const intent = await scoreIntent(payload);
    if (intent && Number.isFinite(intent.score)) {
      analysis.lexicalScore = analysis.score;
      analysis.score = intent.score;
      analysis.scoreMode = intent.mode; // 'anchor' | 'lexical' (clean-text fallback)
      analysis.anchorClass = intent.class ?? null;
      intentScored = true;
      logger.debug({
        score: intent.score,
        mode: intent.mode,
        class: intent.class,
        lexicalScore: analysis.lexicalScore,
      }, '[Routing] WS7 intent score');
    }
  } catch (err) {
    degradation.record('intent_score', err);
  }

  // Phase 4 embeddings adjustment: legacy path only — it reads the full
  // payload and would reintroduce envelope noise into an anchor score.
  let embeddingsResult = null;
  if (!intentScored && options.useEmbeddings !== false && config.ollama?.embeddingsModel) {
    try {
      embeddingsResult = await analyzeWithEmbeddings(payload);
      if (embeddingsResult?.adjustment) {
        analysis.score = Math.max(0, Math.min(100,
          analysis.score + embeddingsResult.adjustment
        ));
        analysis.embeddingsAdjustment = embeddingsResult.adjustment;
      }
    } catch (err) {
      degradation.record('embeddings', err);
    }
  }

  // Agentic workflow detection
  let agenticResult = null;
  if (config.routing?.agenticDetection !== false) {
    try {
      const detector = getAgenticDetector();
      // WS3.2 — thread the client profile so the detector subtracts the
      // harness's baseline tool loadout before scoring tool-count signals.
      const clientProfile = payload?._clientProfile
        || options.clientProfile
        || null;
      agenticResult = detector.detect(payload, { clientProfile });

      // Agentic boost: legacy mode only. In anchor mode the score must stay
      // payload-invariant; agentic escalation happens via minTier instead.
      if (agenticResult.isAgentic) {
        if (!intentScored) {
          analysis.score = Math.min(100, analysis.score + agenticResult.scoreBoost);
          analysis.agenticBoost = agenticResult.scoreBoost;
        }
        analysis.agentType = agenticResult.agentType;

        logger.debug({
          agentType: agenticResult.agentType,
          boost: agenticResult.scoreBoost,
          newScore: analysis.score,
        }, '[Routing] Agentic workflow detected, boosting score');

        // Force cloud for autonomous workflows. AUTONOMOUS carries
        // minTier=REASONING, but this early return used to bypass tier
        // mapping entirely and pick from getBestCloudProvider()'s
        // credential list — the same dormant landmine as the force-cloud
        // branch (dummy databricks credentials → self-proxy). When tier
        // routing is on, honour the agent type's declared minTier and
        // serve the REASONING tier's configured model.
        if (agenticResult.agentType === 'AUTONOMOUS' && isFallbackEnabled()) {
          if (config.modelTiers?.enabled) {
            try {
              const selector = getModelTierSelector();
              const modelSelection = selector.selectModel('REASONING', null);
              const decision = {
                provider: modelSelection.provider,
                model: modelSelection.model,
                tier: 'REASONING',
                method: 'agentic',
                reason: 'autonomous_workflow',
                // Triggers present a score consistent with the tier they
                // force (like force_cloud/risk) — score-comparing consumers
                // (intent window decay, pin ceilings) would otherwise treat
                // a REASONING decision as trivial.
                score: 100,
                agenticResult,
                risk,
                propensity: 1.0,
                candidates: [{ provider: modelSelection.provider, model: modelSelection.model }],
                _queryEmbedding: queryEmbedding,
                _queryText: queryText,
              };
              routingMetrics.record(decision);
              return decision;
            } catch (err) {
              degradation.record('tier_select', err);
            }
          }
          const provider = getBestCloudProvider();
          const decision = {
            provider,
            method: 'agentic',
            reason: 'autonomous_workflow',
            score: 100, // trigger score matches forced tier — see comment above
            agenticResult,
            risk,
            propensity: 1.0,
            candidates: [{ provider, model: null }],
            _queryEmbedding: queryEmbedding,
            _queryText: queryText,
          };
          routingMetrics.record(decision);
          return decision;
        }
      }
    } catch (err) {
      degradation.record('agentic', err);
    }
  }

  // Tier-based model selection
  let selectedModel = null;
  let tier = null;
  // baseTier is the tier chosen by pure complexity analysis, before any
  // guard/override. escalations[] accumulates every deviation from base_tier
  // (agentic minTier, context, vision, kNN-ambiguous) for telemetry.
  let baseTier = null;
  const escalations = [];
  if (config.modelTiers?.enabled) {
    try {
      const selector = getModelTierSelector();
      tier = selector.getTier(analysis.score);
      baseTier = tier;

      // Check if agentic detection requires a higher tier
      if (agenticResult?.minTier) {
        const agenticTierPriority = TIER_DEFINITIONS[agenticResult.minTier]?.priority || 0;
        const currentTierPriority = TIER_DEFINITIONS[tier]?.priority || 0;
        if (agenticTierPriority > currentTierPriority) {
          const fromTier = tier;
          tier = agenticResult.minTier;
          escalations.push({
            source: 'agentic_min_tier',
            fromTier,
            toTier: tier,
            fromModel: null,
            toModel: null,
          });
          logger.debug({ from: fromTier, to: tier }, '[Routing] Upgrading tier for agentic workflow');
        }
      }

      // Select model for the tier (will be applied after provider selection)
      analysis.tier = tier;
    } catch (err) {
      degradation.record('tier_select', err);
    }
  }

  // Apply routing decision based on tier config (TIER_* env vars take precedence
  // but Phase 1.2 lets the cost-optimizer pick a cheaper qualifying model when safe).
  let provider;
  let method = 'tier_config';
  let costOptimized = false;

  const selector = getModelTierSelector();
  const modelSelection = selector.selectModel(tier, null);

  provider = modelSelection.provider;
  selectedModel = modelSelection.model;
  logger.debug({ tier, provider, model: selectedModel }, '[Routing] Using tier config');

  // WS2.3 — evidence-based de-escalation.
  //
  // The check is intentionally gated by evidence, not a feature flag: the
  // deescalator only returns a lower tier when the lower tier has >=30
  // rows of this request_type at avg quality >=70 with error rate <5% in
  // the last 7 days. On a fresh install with no telemetry, this never
  // fires. On a mature install with proven data, it demotes safely.
  //
  // Never applied when risk=high (upstream forces COMPLEX) or when any
  // upward escalation has already fired (agentic minTier, context, vision,
  // kNN) — those signals dominate.
  let demotedFrom = null;
  if (risk?.level !== 'high' && escalations.length === 0) {
    try {
      const requestType = analysis?.breakdown?.taskType?.reason
        ?? analysis?.taskType
        ?? null;
      const demoted = deescalator.suggestDemotion({
        tier,
        requestType,
        analysis,
      });
      if (demoted && demoted !== tier) {
        const demotedSelection = selector.selectModel(demoted, null);
        logger.debug({
          from: `${tier}:${provider}:${selectedModel}`,
          to: `${demoted}:${demotedSelection.provider}:${demotedSelection.model}`,
          requestType,
        }, '[Routing] De-escalation — demoting tier on evidence');
        demotedFrom = tier;
        provider = demotedSelection.provider;
        selectedModel = demotedSelection.model;
        tier = demoted;
        method = method + '+deescalated';
      }
    } catch (err) {
      degradation.record('tier_select', err);
    }
  }

  // Phase 1.2 — cost-optimizer override.
  // Only kick in when:
  //  - feature flag enabled (default true, disable with LYNKR_COST_OPTIMIZE=false)
  //  - risk level is not high (high-risk keeps the explicitly-configured model)
  //  - the optimizer finds a meaningfully cheaper qualifying model
  const costOptimizeEnabled = process.env.LYNKR_COST_OPTIMIZE !== 'false'
    && config.routing?.costOptimize !== false;
  if (costOptimizeEnabled && risk?.level !== 'high') {
    try {
      const optimizer = getCostOptimizer();
      const availableProviders = _enabledProviders();
      const cheapest = optimizer.findCheapestForTier(tier, availableProviders);
      if (cheapest && cheapest.model && cheapest.model !== selectedModel) {
        const current = optimizer.estimateCost(selectedModel, 1000);
        const candidate = optimizer.estimateCost(cheapest.model, 1000);
        if (candidate.totalEstimate > 0 && candidate.totalEstimate < current.totalEstimate * 0.75) {
          logger.debug({
            tier,
            from: `${provider}:${selectedModel}`,
            to: `${cheapest.provider}:${cheapest.model}`,
            savedPerK: (current.totalEstimate - candidate.totalEstimate).toFixed(6),
          }, '[Routing] Cost-optimizer override');
          provider = cheapest.provider;
          selectedModel = cheapest.model;
          method = 'tier_config+cost_optimized';
          costOptimized = true;
        }
      }
    } catch (err) {
      degradation.record('cost_optimize', err);
    }
  }

  // Phase 1.3 — context window validation. If estimated tokens exceed the
  // selected model's context (with response headroom), escalate to a
  // context-capable model regardless of tier.
  try {
    const estimatedTokens = countPayloadTokens(payload, selectedModel);
    const ctxResult = contextValidator.validate(selectedModel, estimatedTokens);
    if (!ctxResult.ok) {
      const capable = selector.findContextCapable(estimatedTokens, tier);
      if (capable) {
        const fromTier = tier;
        const fromModel = selectedModel;
        logger.info({
          from: `${provider}:${selectedModel}`,
          to: `${capable.provider}:${capable.model}`,
          required: estimatedTokens,
          oldContext: ctxResult.context,
          newContext: capable.context,
        }, '[Routing] Context window escalation');
        provider = capable.provider;
        selectedModel = capable.model;
        if (capable.tier) tier = capable.tier;
        method = method + '+context_escalated';
        escalations.push({
          source: 'context',
          fromTier,
          toTier: tier,
          fromModel,
          toModel: selectedModel,
        });
      } else {
        logger.warn({
          model: selectedModel,
          required: estimatedTokens,
          available: ctxResult.context,
        }, '[Routing] No context-capable fallback — request may fail upstream');
      }
    }
  } catch (err) {
    degradation.record('context_validate', err);
  }

  // Phase 1.4 — vision capability guard.
  // If the payload contains image content blocks but the selected model lacks
  // vision support, silently swap to the cheapest vision-capable model at or
  // above the current tier. Prevents silent upstream failures.
  if (_payloadHasImages(payload)) {
    try {
      const { getModelRegistrySync } = require('./model-registry');
      const registry = getModelRegistrySync();
      const modelInfo = registry.getCost(selectedModel);
      if (!modelInfo?.vision) {
        const visionModel = selector.findVisionCapable(tier);
        if (visionModel) {
          const fromTier = tier;
          const fromModel = selectedModel;
          logger.info({
            from: `${provider}:${selectedModel}`,
            to: `${visionModel.provider}:${visionModel.model}`,
            tier: visionModel.tier,
          }, '[Routing] Vision guard — upgrading to vision-capable model');
          provider = visionModel.provider;
          selectedModel = visionModel.model;
          if (visionModel.tier !== tier) tier = visionModel.tier;
          method = method + '+vision_guard';
          escalations.push({
            source: 'vision_guard',
            fromTier,
            toTier: tier,
            fromModel,
            toModel: selectedModel,
          });
        } else {
          logger.warn({ model: selectedModel }, '[Routing] Vision guard — no vision-capable model found, request may fail');
        }
      }
    } catch (err) {
      degradation.record('vision_guard', err);
    }
  }

  // Phase 3.1 — kNN routing hint.
  // If the index has enough entries, query it with the last user message.
  // A high-confidence kNN suggestion overrides the heuristic selection.
  //
  // WS5.5 — capture the query embedding at decision time so the feedback
  // path can turn a conclusive outcome into a new kNN exemplar without
  // paying for a second embedding call. The embedding is only computed
  // once regardless of whether the kNN query runs (sparse index / no
  // embedder → we skip the search but still keep the embedding for later
  // add() from feedback).
  // queryText + queryEmbedding are already captured at the top of the
  // function (WS5.5). Reuse them here so we don't re-embed the same text
  // — router.embed() is cache-backed but the extra call is still wasteful.
  let knnResult = null;
  if (config.routing?.knnEnabled !== false && queryEmbedding) {
    try {
      const router = getKnnRouter();
      knnResult = await router.query(queryText);
      {
        // Confidence thresholds (env-configurable; defaults 0.7 high / 0.4 low):
        const KNN_HIGH = Number.parseFloat(process.env.LYNKR_KNN_CONFIDENCE_HIGH) || 0.7;
        const KNN_LOW  = Number.parseFloat(process.env.LYNKR_KNN_CONFIDENCE_LOW)  || 0.4;
        if (knnResult && knnResult.confidence > KNN_HIGH && knnResult.model && knnResult.model !== selectedModel) {
          // High confidence — trust kNN's model recommendation directly.
          logger.debug({
            from: `${provider}:${selectedModel}`,
            to: `${knnResult.provider}:${knnResult.model}`,
            confidence: knnResult.confidence.toFixed(3),
          }, '[Routing] kNN override');
          provider = knnResult.provider;
          selectedModel = knnResult.model;
          method = method + '+knn';
        } else if (knnResult && knnResult.confidence > KNN_LOW && knnResult.confidence <= KNN_HIGH) {
          // Ambiguous signal — neighbors are split, we can't trust any single
          // model recommendation. Historically this always escalated one tier
          // "for safety", but that's a one-way ratchet: on a system where
          // cheap tiers are NOT failing, the bump is pure over-provisioning.
          //
          // Evidence-based leash: escalate only when telemetry shows
          // underProvisionedPct >= 2% (cheap tiers actually failing lately).
          // Otherwise keep the current tier. Fail-open to legacy escalation
          // if telemetry lookup itself fails, so we never regress safety.
          let shouldEscalate = false;
          try {
            const acc = telemetry.getRoutingAccuracy?.();
            const under = acc?.underProvisionedPct ?? 0;
            shouldEscalate = under >= 2;
          } catch (err) {
            degradation.record('knn', err);
            shouldEscalate = true;
          }

          if (!shouldEscalate) {
            method = method + '+knn_ambiguous_kept';
            logger.debug({
              tier,
              provider,
              model: selectedModel,
              confidence: knnResult.confidence.toFixed(3),
            }, '[Routing] kNN ambiguous — leash held, keeping tier');
          } else {
            const TIER_ORDER = ['SIMPLE', 'MEDIUM', 'COMPLEX', 'REASONING'];
            const currentIdx = TIER_ORDER.indexOf(tier);
            if (currentIdx >= 0 && currentIdx < TIER_ORDER.length - 1) {
              const upgradedTier = TIER_ORDER[currentIdx + 1];
              try {
                const upgraded = selector.selectModel(upgradedTier, null);
                const fromTier = tier;
                const fromModel = selectedModel;
                logger.debug({
                  from: `${tier}:${provider}:${selectedModel}`,
                  to: `${upgradedTier}:${upgraded.provider}:${upgraded.model}`,
                  confidence: knnResult.confidence.toFixed(3),
                }, '[Routing] kNN ambiguous — escalating tier for safety');
                provider = upgraded.provider;
                selectedModel = upgraded.model;
                tier = upgradedTier;
                method = method + '+knn_ambiguous_escalate';
                escalations.push({
                  source: 'knn_ambiguous',
                  fromTier,
                  toTier: tier,
                  fromModel,
                  toModel: selectedModel,
                });
              } catch (err) {
                degradation.record('knn', err);
              }
            }
          }
        }
      }
    } catch (err) {
      degradation.record('knn', err);
    }
  }

  // Phase 4.1 — LinUCB bandit intra-tier selection.
  // When there are two candidates (heuristic vs kNN), the bandit picks the
  // one with the highest estimated UCB score for the current context.
  //
  // WS4.2 — capture propensity + candidates + context so the outcome row can
  // support off-policy evaluation. banditContext is stashed on the decision
  // (underscored → won't leak through headers, see WS4.2 verification).
  let banditPropensity = null;
  let banditCandidates = null;
  let banditContext = null;
  if (config.routing?.banditEnabled !== false && knnResult && knnResult.model) {
    try {
      // Build candidates: current selection and kNN alternative if different.
      //
      // Tier-aware filter: only treat the kNN suggestion as a real candidate
      // if it matches a (provider, model) combo configured in ANY TIER_*
      // entry. The bandit is allowed to explore freely across the user's
      // configured tiers (e.g. swap a SIMPLE request to the COMPLEX-tier
      // model), but is forbidden from picking a credentialed-but-untiered
      // model (e.g. an Azure OpenAI deployment whose endpoint is set in .env
      // for some other use, but not referenced by any TIER_*). This keeps
      // tier routing as the source of truth for what's eligible while
      // preserving cross-tier bandit exploration.
      const allCandidates = [{ provider, model: selectedModel }];
      if (knnResult.model !== selectedModel) {
        const configured = require('./model-tiers').getModelTierSelector().getAllConfiguredModels();
        const inConfig = configured.some(
          m => m.provider === knnResult.provider && m.model === knnResult.model
        );
        if (inConfig) {
          allCandidates.push({ provider: knnResult.provider, model: knnResult.model });
        }
      }

      if (allCandidates.length > 1) {
        const bandit = getBandit();
        const TASK_TYPES = ['code_gen', 'summarization', 'reasoning', 'factoid', 'chat', 'other'];
        const inferredTask = (analysis.breakdown?.taskType?.reason || 'other').toLowerCase();
        const taskIdx = Math.max(0, TASK_TYPES.findIndex(t => inferredTask.includes(t)));
        const ctx = [
          (analysis.score || 0) / 100,
          Math.log(Math.max(1, analysis.breakdown?.tokenCount || 0) + 1) / 15,
          ((payload?.tools?.length ?? 0) > 0) ? 1 : 0,
          options.streaming ? 1 : 0,
          risk?.level === 'high' ? 1 : risk?.level === 'medium' ? 0.5 : 0,
          agenticResult?.isAgentic ? 1 : 0,
          ...TASK_TYPES.map((_, i) => i === taskIdx ? 1 : 0),
        ];
        const picked = bandit.pick(tier, allCandidates, ctx);
        if (picked) {
          banditCandidates = allCandidates;
          banditPropensity = picked.propensity ?? null;
          banditContext = ctx;
          if (picked.model !== selectedModel) {
            logger.debug({
              from: `${provider}:${selectedModel}`,
              to: `${picked.provider}:${picked.model}`,
              ucb: picked.ucb?.toFixed(4),
              explored: picked.explored,
              propensity: picked.propensity,
            }, '[Routing] Bandit override');
            provider = picked.provider;
            selectedModel = picked.model;
            method = method + (picked.explored ? '+bandit_explore' : '+bandit');
          }
        }
      }
    } catch (err) {
      degradation.record('bandit', err);
    }
  }

  // Phase 6.3 — deadline-aware fastest-model selection.
  // Payload carries _deadlineMs injected by the orchestrator from the
  // LYNKR-Deadline-Ms request header.
  const deadlineMs = payload?._deadlineMs ?? null;
  if (deadlineMs) {
    try {
      const fastest = chooseFastest([{ provider, model: selectedModel }], deadlineMs);
      if (fastest && fastest.model !== selectedModel) {
        logger.debug({
          from: `${provider}:${selectedModel}`,
          to: `${fastest.provider}:${fastest.model}`,
          deadlineMs,
        }, '[Routing] Deadline override');
        provider = fastest.provider;
        selectedModel = fastest.model;
        method = method + '+deadline';
      }
    } catch (err) {
      degradation.record('deadline', err);
    }
  }

  // Phase 6.1 — per-tenant policy overrides.
  // tenantPolicy comes from options (threaded from Express res.locals via
  // orchestrator → databricks → here).
  if (options.tenantPolicy) {
    try {
      const overridden = applyTenantOverrides(
        { provider, model: selectedModel, tier, method },
        options.tenantPolicy,
      );
      if (overridden && overridden.model !== selectedModel) {
        logger.debug({
          from: `${provider}:${selectedModel}`,
          to: `${overridden.provider}:${overridden.model}`,
        }, '[Routing] Tenant override');
        provider = overridden.provider;
        selectedModel = overridden.model;
        method = overridden.method;
      }
    } catch (err) {
      degradation.record('tenant', err);
    }
  }

  const decision = {
    provider,
    model: selectedModel,
    tier,
    method,
    reason: analysis.recommendation,
    score: analysis.score,
    threshold: analysis.threshold,
    mode: analysis.mode,
    analysis,
    embeddingsResult,
    agenticResult,
    costOptimized,
    risk,
    knnResult,
    base_tier: baseTier,
    escalations,
    // Upward escalations take precedence in the source label; a demotion is
    // only surfaced when nothing else escalated (guarded by the wire above,
    // but re-checked here for clarity).
    escalation_source: escalations[0]?.source
      ?? (demotedFrom ? 'deescalation' : null),
    demoted_from: demotedFrom,
  };

  // WS4.2 — propensity/candidates for off-policy evaluation from telemetry.
  // Bandit picks populate both. If a deterministic downstream override
  // (deadline / tenant) then swapped the served model out of the bandit's
  // candidate set, the bandit's propensity no longer describes the served
  // choice — collapse to propensity=1.0 with a single candidate. Otherwise
  // deterministic branches (bandit didn't run at all) always collapse.
  // _banditContext is underscored so it never leaks to response headers;
  // WS5 will consume it in the feedback path to call bandit.update().
  const banditPickedServed = banditCandidates
    && banditCandidates.some(c => c.provider === provider && c.model === selectedModel);
  if (banditPickedServed) {
    decision.propensity = banditPropensity ?? 1.0;
    decision.candidates = banditCandidates;
    decision._banditContext = banditContext;
  } else {
    decision.propensity = 1.0;
    decision.candidates = [{ provider, model: selectedModel }];
    decision._banditContext = null;
  }

  // WS5.5 — attach the query embedding + raw query text so the feedback
  // path can turn conclusive outcomes into new kNN exemplars without
  // re-embedding. Underscored so it doesn't leak into headers or JSON
  // serialisation of the decision.
  decision._queryEmbedding = queryEmbedding;
  decision._queryText = queryText;

  // Phase 4.4 — shadow-mode policy comparison (fire-and-forget).
  const shadowFn = getShadowPolicy();
  if (shadowFn) {
    setImmediate(() =>
      shadowCompareAndLog({ payload, activeDecision: decision, shadowFn }).catch(() => {})
    );
  }

  // Phase 3: Record metrics
  routingMetrics.record(decision);

  logger.debug(
    {
      provider,
      score: analysis.score,
      threshold: analysis.threshold,
      recommendation: analysis.recommendation,
      taskType: analysis.breakdown?.taskType?.reason,
      toolCount: payload?.tools?.length ?? 0,
    },
    'Smart routing decision'
  );

  return decision;
}

/**
 * Get routing headers to include in response
 * Phase 3: Expose routing decision to clients
 */
function getRoutingHeaders(decision) {
  const headers = {
    'X-Lynkr-Routing-Method': decision.method || 'unknown',
    'X-Lynkr-Provider': decision.provider || 'unknown',
  };

  if (typeof decision.score === 'number') {
    headers['X-Lynkr-Complexity-Score'] = String(decision.score);
  }

  if (decision.threshold) {
    headers['X-Lynkr-Complexity-Threshold'] = String(decision.threshold);
  }

  if (decision.reason) {
    headers['X-Lynkr-Routing-Reason'] = decision.reason;
  }

  // Tier and model headers
  if (decision.tier) {
    headers['X-Lynkr-Tier'] = decision.tier;
  }

  if (decision.model) {
    headers['X-Lynkr-Model'] = decision.model;
  }

  if (decision.agenticResult?.isAgentic) {
    headers['X-Lynkr-Agentic'] = decision.agenticResult.agentType;
  }

  if (decision.costOptimized) {
    headers['X-Lynkr-Cost-Optimized'] = 'true';
  }

  // Tier-aware fallback surfacing (never silent).
  if (decision.fallback) {
    headers['X-Lynkr-Fallback'] = 'true';
    if (decision.fromTier) headers['X-Lynkr-Fallback-From-Tier'] = decision.fromTier;
    if (decision.servedTier) headers['X-Lynkr-Served-Tier'] = decision.servedTier;
    if (decision.fallbackDirection) headers['X-Lynkr-Fallback-Direction'] = decision.fallbackDirection;
  }

  if (decision.risk?.level) {
    headers['X-Lynkr-Risk'] = decision.risk.level;
    const hits = Array.from(new Set([
      ...(decision.risk.instructionHits || []),
      ...(decision.risk.pathHits || []),
    ]));
    if (hits.length > 0) {
      // Header values are ASCII-only; comma-join the first few hits.
      headers['X-Lynkr-Risk-Hits'] = hits.slice(0, 8).join(',');
    }
  }

  return headers;
}

/**
 * Get routing statistics
 * Phase 3: Metrics access
 */
function getRoutingStats() {
  const base = routingMetrics.getStats() || {};
  let escalations = null;
  try {
    escalations = telemetry.getEscalationStats?.() ?? null;
  } catch (err) {
    degradation.record('tenant', err); // reuse a bucket; not worth a new one
  }
  return {
    ...base,
    degradation: degradation.getCounts(),
    escalations,
  };
}

module.exports = {
  // Main routing function
  determineProviderSmart,

  // WS1: sticky-session pin helpers (shared with OAuth intent path)
  checkSessionPin,
  writeSessionPin,
  // WS1.5: upward-drift detection for pinned sessions
  checkPinScoreDrift,

  // WS1: test-only internals (exercised by test/sticky-routing.test.js)
  _internals: {
    economicDowngradeAllowed: _economicDowngradeAllowed,
    runPinGuards: _runPinGuards,
    tierPriority: _tierPriority,
  },

  // Helpers
  isFallbackEnabled,
  getFallbackProvider,
  getBestCloudProvider,
  getBestLocalProvider,
  isLocalProvider,

  // Phase 3: Headers and metrics
  getRoutingHeaders,
  getRoutingStats,

  // Re-export analyzer for direct access
  analyzeComplexity: require('./complexity-analyzer').analyzeComplexity,
  analyzeRisk,

  // Intelligent routing modules
  getAgenticDetector,
  getModelTierSelector,
  getCostOptimizer,
  AGENT_TYPES,
  TIER_DEFINITIONS,

  // Phase 3-6 modules
  getKnnRouter,
  getBandit,
  getShadowPolicy,
  shadowCompareAndLog,
  chooseFastest,
  applyTenantOverrides,

  // Telemetry
  telemetry,
  scoreResponseQuality,
  getLatencyTracker,

  // WS2.3 — de-escalation
  deescalator,
};
