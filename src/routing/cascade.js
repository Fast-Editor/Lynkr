/**
 * Small-first cascade with confidence-based deferral (Phase 3.3).
 *
 * For tier-MEDIUM/COMPLEX requests, optionally try a smaller model first.
 * If the response confidence (from confidence-scorer) ≥ threshold, accept it.
 * Otherwise, escalate to the originally-routed tier model.
 *
 * Off by default for streaming (can't retry mid-stream cleanly).
 * Opt-in via LYNKR_CASCADE_ENABLED=true.
 */

const logger = require('../logger');
const confidenceScorer = require('./confidence-scorer');

const DEFAULT_THRESHOLD = 0.85;
const TIERS_ELIGIBLE = ['MEDIUM', 'COMPLEX'];

function isEnabled() {
  return process.env.LYNKR_CASCADE_ENABLED === 'true';
}

/**
 * @param {object} args
 * @param {string} args.tier — the originally selected tier
 * @param {boolean} args.streaming — true if the request is streaming
 * @param {boolean} args.hasTools — true if tools are present
 * @returns {boolean}
 */
function shouldCascade(args) {
  if (!isEnabled()) return false;
  if (args.streaming) return false; // streaming responses can't be retried cleanly
  if (args.hasTools) return false; // tool calls have side effects; don't double-run
  if (!TIERS_ELIGIBLE.includes(args.tier)) return false;
  return true;
}

/**
 * Run a small-first cascade.
 *
 * @param {object} args
 * @param {object} args.payload — the request payload
 * @param {object} args.smallModel — { provider, model }
 * @param {object} args.bigModel — { provider, model }
 * @param {function} args.invoke — async (provider, model, payload) → response
 * @param {string} args.taskType — used by confidence scorer
 * @param {number} args.threshold — confidence threshold, defaults to 0.85
 * @param {function} args.judge — optional judge LLM for reasoning tasks
 * @returns {Promise<{ response, usedModel, cascadeStats }>}
 */
async function run(args) {
  const threshold = args.threshold ?? DEFAULT_THRESHOLD;
  const start = Date.now();
  let smallLatency = 0;
  let bigLatency = 0;

  // Try small model
  let smallResponse;
  try {
    const t0 = Date.now();
    smallResponse = await args.invoke(args.smallModel.provider, args.smallModel.model, args.payload);
    smallLatency = Date.now() - t0;
  } catch (err) {
    logger.debug({ err: err.message }, '[Cascade] Small model failed, escalating');
    const t0 = Date.now();
    const bigResponse = await args.invoke(args.bigModel.provider, args.bigModel.model, args.payload);
    bigLatency = Date.now() - t0;
    return {
      response: bigResponse,
      usedModel: args.bigModel,
      cascadeStats: { accepted: false, reason: 'small_failed', smallLatency, bigLatency, totalLatency: Date.now() - start },
    };
  }

  const confidence = await confidenceScorer.score(smallResponse, {
    taskType: args.taskType,
    question: args.payload?.messages?.[args.payload.messages.length - 1]?.content,
    judge: args.judge,
  });

  if (confidence >= threshold) {
    return {
      response: smallResponse,
      usedModel: args.smallModel,
      cascadeStats: { accepted: true, confidence, smallLatency, bigLatency: 0, totalLatency: Date.now() - start },
    };
  }

  // Escalate
  const t0 = Date.now();
  const bigResponse = await args.invoke(args.bigModel.provider, args.bigModel.model, args.payload);
  bigLatency = Date.now() - t0;
  return {
    response: bigResponse,
    usedModel: args.bigModel,
    cascadeStats: {
      accepted: false,
      confidence,
      threshold,
      smallLatency,
      bigLatency,
      totalLatency: Date.now() - start,
    },
  };
}

module.exports = { run, shouldCascade, isEnabled, DEFAULT_THRESHOLD };
