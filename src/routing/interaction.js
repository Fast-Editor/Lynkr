/**
 * Routing Interaction Block
 *
 * Builds an "interaction" block that explains, in plain text, what
 * Lynkr decided to do with a request — which tier, which provider,
 * why it routed there, and what (if anything) the user should do next.
 *
 * Lynkr already surfaces this information via X-Lynkr-* response
 * headers, but headers are invisible to most users in Claude Code /
 * Cursor / Codex. The interaction block lives in the response body
 * so it shows up alongside the model's reply when the visible-routing
 * env flag is on (LYNKR_VISIBLE_ROUTING=true).
 *
 * @module routing/interaction
 */

/**
 * Rough estimate of cost savings vs always-COMPLEX baseline. Not
 * invoice-grade, just a reproducible number for users to glance at.
 *
 * @param {string|null} tier
 * @param {string|null} provider
 * @returns {number} 0-100
 */
function estimateSavingsPercent(tier, provider) {
  if (!tier) return 0;
  const t = tier.toUpperCase();
  // Local providers carry the same savings band as their tier.
  const isLocal = provider && ['ollama', 'llamacpp', 'lmstudio'].includes(provider);
  if (t === 'SIMPLE') return isLocal ? 100 : 70;
  if (t === 'MEDIUM') return isLocal ? 90 : 45;
  if (t === 'COMPLEX') return 10;
  if (t === 'REASONING') return 0;
  return 0;
}

/**
 * Choose a mode label that describes what happened.
 *
 * @param {object} decision
 * @returns {string}
 */
function modeFor(decision) {
  if (decision.method === 'risk') return 'risk_forced_tier';
  if (decision.method === 'agentic') return 'agentic_workflow';
  if (decision.method === 'force' && decision.reason === 'force_local_pattern') return 'force_local';
  if (decision.method === 'force' && decision.reason === 'force_cloud_pattern') return 'force_cloud';
  if (decision.method === 'static') return 'static';
  return 'tier_routed';
}

/**
 * Produce a one-line, terminal-friendly route label, e.g.
 *   "[Lynkr] tier=COMPLEX provider=databricks risk=high score=78"
 *
 * @param {object} decision
 * @returns {string}
 */
function routeLabel(decision) {
  const parts = ['[Lynkr]'];
  if (decision.tier) parts.push(`tier=${decision.tier}`);
  if (decision.provider) parts.push(`provider=${decision.provider}`);
  if (decision.model) parts.push(`model=${decision.model}`);
  if (decision.risk?.level) parts.push(`risk=${decision.risk.level}`);
  if (typeof decision.score === 'number') parts.push(`score=${decision.score}`);
  return parts.join(' ');
}

/**
 * Headline + next_step are model-facing prose. We keep them terse so
 * they don't pollute the user's view when the model echoes them back.
 *
 * @param {object} decision
 * @returns {{ headline: string, next_step: string }}
 */
function copyFor(decision) {
  const mode = modeFor(decision);
  if (mode === 'risk_forced_tier') {
    return {
      headline: `Lynkr routed to ${decision.tier} tier because the request touches a protected domain.`,
      next_step: 'Review the response carefully — sensitive logic was involved.',
    };
  }
  if (mode === 'agentic_workflow') {
    return {
      headline: `Lynkr detected an agentic workflow and routed to ${decision.provider || decision.tier}.`,
      next_step: 'No action needed — autonomous workflows always use cloud providers.',
    };
  }
  if (mode === 'force_local') {
    return {
      headline: 'Lynkr routed to the local tier (greeting or trivial request).',
      next_step: 'No action needed.',
    };
  }
  if (mode === 'force_cloud') {
    return {
      headline: `Lynkr forced cloud routing (${decision.provider || 'cloud'}) for this request.`,
      next_step: 'No action needed.',
    };
  }
  if (mode === 'static') {
    return {
      headline: `Lynkr used the static provider ${decision.provider}.`,
      next_step: 'Tier routing is disabled — set TIER_* env vars to enable.',
    };
  }
  return {
    headline: `Lynkr routed to the ${decision.tier || 'default'} tier (${decision.provider || 'unknown'}).`,
    next_step: 'No action needed.',
  };
}

/**
 * Build the full interaction block.
 *
 * @param {object} decision - The routing decision (from determineProviderSmart
 *   or the pre-route in api/router.js). Must at least have `provider`; ideally
 *   includes `tier`, `model`, `method`, `reason`, `score`, and `risk`.
 * @returns {object}
 */
function buildInteractionBlock(decision) {
  if (!decision || typeof decision !== 'object') return null;
  const { headline, next_step } = copyFor(decision);
  return {
    tool: 'lynkr.route',
    mode: modeFor(decision),
    headline,
    route_label: routeLabel(decision),
    reason: decision.reason || 'unspecified',
    tier: decision.tier || null,
    provider: decision.provider || null,
    model: decision.model || null,
    risk: decision.risk?.level || 'low',
    risk_hits: Array.from(new Set([
      ...(decision.risk?.instructionHits || []),
      ...(decision.risk?.pathHits || []),
    ])),
    complexity_score: typeof decision.score === 'number' ? decision.score : null,
    // Pin-serve turns: the score that originally created the session pin.
    // Lets the badge show both this turn's fresh score and the pin's.
    pin_score: typeof decision._pinScore === 'number' ? decision._pinScore : null,
    estimated_savings_percent: estimateSavingsPercent(decision.tier, decision.provider),
    next_step,
  };
}

/**
 * Attach an interaction block to an Anthropic-format response body.
 * Mutates and returns the body.
 *
 * Anthropic clients ignore unknown top-level fields, so this is safe.
 *
 * @param {object} body
 * @param {object} interaction
 * @returns {object}
 */
function attachToAnthropicResponse(body, interaction) {
  if (!body || !interaction) return body;
  body.lynkr_interaction = interaction;
  return body;
}

/**
 * Attach an interaction block to an OpenAI chat-completions response.
 * Mutates and returns the body.
 *
 * @param {object} body
 * @param {object} interaction
 * @returns {object}
 */
function attachToOpenAIResponse(body, interaction) {
  if (!body || !interaction) return body;
  body.lynkr_interaction = interaction;
  return body;
}

module.exports = {
  buildInteractionBlock,
  attachToAnthropicResponse,
  attachToOpenAIResponse,
  // Exposed for tests
  estimateSavingsPercent,
  modeFor,
  routeLabel,
};
