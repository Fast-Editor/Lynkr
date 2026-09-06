/**
 * Routing decision core — the harness-shaped, standalone pieces of the
 * per-request model decision, extracted from routing/index.js so they can be
 * consumed by more than one caller:
 *
 *   - routing/index.js (the live request path, unchanged behavior)
 *   - the off-policy evaluator (WS4 follow-up), which must re-derive a
 *     candidate policy's π(a|x) on logged rows using the exact same context
 *     vector and candidate-eligibility rules the live policy used
 *   - a future remote decision endpoint, which needs decide-shaped logic
 *     that doesn't reach into request/response plumbing
 *
 * Deliberately excluded: session pins, the escalation ladder, kNN confidence
 * branching, deadline/tenant overrides. Those are decision *inputs and
 * post-passes* owned by the caller; this module owns only "given a context
 * and a candidate set, pick one and report the probability of that pick."
 *
 * Nothing here catches errors — callers keep their existing
 * degradation.record() wrapping so failure accounting stays where it was.
 */

const { getBandit } = require('./bandit');

/**
 * Task-type one-hot vocabulary. Order is load-bearing: it defines feature
 * indices 6..11 of the context vector, and every persisted bandit arm was
 * trained against this order. Do not reorder or insert — append only, and
 * only together with a bandit-state migration.
 */
const TASK_TYPES = ['code_gen', 'summarization', 'reasoning', 'factoid', 'chat', 'other'];

/**
 * Build the 12-dim context vector the bandit (and any off-policy estimator
 * replaying its decisions) scores against.
 *
 * Layout: [score, log-tokens, has-tools, streaming, risk, agentic,
 *          ...one-hot task type (6)].
 *
 * @param {object} args
 * @param {object} args.analysis — complexity analysis ({ score, breakdown })
 * @param {object} [args.payload] — request payload (for tools presence)
 * @param {object} [args.options] — routing options (for streaming flag)
 * @param {object} [args.risk] — risk analysis ({ level })
 * @param {object} [args.agenticResult] — agentic detection ({ isAgentic })
 * @returns {number[]} 12-dim feature vector
 */
function buildContextVector({ analysis, payload, options, risk, agenticResult }) {
  const inferredTask = (analysis?.breakdown?.taskType?.reason || 'other').toLowerCase();
  const taskIdx = Math.max(0, TASK_TYPES.findIndex(t => inferredTask.includes(t)));
  return [
    (analysis?.score || 0) / 100,
    Math.log(Math.max(1, analysis?.breakdown?.tokenCount || 0) + 1) / 15,
    ((payload?.tools?.length ?? 0) > 0) ? 1 : 0,
    options?.streaming ? 1 : 0,
    risk?.level === 'high' ? 1 : risk?.level === 'medium' ? 0.5 : 0,
    agenticResult?.isAgentic ? 1 : 0,
    ...TASK_TYPES.map((_, i) => i === taskIdx ? 1 : 0),
  ];
}

/**
 * Build the bandit's candidate set: the current selection plus the kNN
 * alternative, if it differs AND is configured in some TIER_* entry.
 *
 * Tier-aware filter: the bandit may explore freely across the user's
 * configured tiers (e.g. swap a SIMPLE request to the COMPLEX-tier model),
 * but never pick a credentialed-but-untiered model (e.g. an Azure deployment
 * present in .env for another purpose but referenced by no TIER_*). Tier
 * routing stays the source of truth for eligibility.
 *
 * @param {{ provider: string, model: string }} current
 * @param {{ provider: string, model: string }|null} alternative
 * @returns {Array<{ provider: string, model: string }>}
 */
function buildCandidates(current, alternative) {
  const candidates = [{ provider: current.provider, model: current.model }];
  if (alternative && alternative.model && alternative.model !== current.model) {
    const configured = require('./model-tiers').getModelTierSelector().getAllConfiguredModels();
    const inConfig = configured.some(
      m => m.provider === alternative.provider && m.model === alternative.model
    );
    if (inConfig) {
      candidates.push({ provider: alternative.provider, model: alternative.model });
    }
  }
  return candidates;
}

/**
 * The decision core: given a tier, a candidate set, and a context vector,
 * have the bandit pick one and report the pick's propensity.
 *
 * Returns null when there's nothing to adjudicate (fewer than 2 candidates)
 * or the bandit declined — callers keep their pre-existing selection.
 *
 * @param {string} tier
 * @param {Array<{ provider, model }>} candidates
 * @param {number[]} ctx — from buildContextVector
 * @returns {null | { provider, model, ucb, explored, propensity, candidates, context }}
 */
function decide(tier, candidates, ctx) {
  if (!candidates || candidates.length < 2) return null;
  const picked = getBandit().pick(tier, candidates, ctx);
  if (!picked) return null;
  return { ...picked, candidates, context: ctx };
}

/**
 * Stamp propensity/candidates/_banditContext onto a built decision (WS4.2).
 *
 * Collapse rule: the bandit's propensity only describes the served choice if
 * the served (provider, model) is still one of the bandit's candidates. If a
 * deterministic downstream override (deadline / tenant) swapped the served
 * model out of that set — or the bandit never ran — collapse to
 * propensity=1.0 with a single-entry candidate list, so off-policy
 * estimators treat the row as a deterministic decision.
 *
 * _banditContext is underscored so it never leaks to response headers; the
 * feedback path consumes it to call bandit.update().
 *
 * @param {object} decision — mutated in place (matches prior inline behavior)
 * @param {{ provider: string, model: string }} served
 * @param {null | { propensity, candidates, context }} banditResult — from decide()
 * @returns {object} the same decision, for chaining
 */
function stampPropensity(decision, served, banditResult) {
  const banditPickedServed = banditResult?.candidates
    && banditResult.candidates.some(
      c => c.provider === served.provider && c.model === served.model
    );
  if (banditPickedServed) {
    decision.propensity = banditResult.propensity ?? 1.0;
    decision.candidates = banditResult.candidates;
    decision._banditContext = banditResult.context;
  } else {
    decision.propensity = 1.0;
    decision.candidates = [{ provider: served.provider, model: served.model }];
    decision._banditContext = null;
  }
  return decision;
}

module.exports = {
  TASK_TYPES,
  buildContextVector,
  buildCandidates,
  decide,
  stampPropensity,
};
