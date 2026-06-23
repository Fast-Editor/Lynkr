/**
 * Task decomposition — orchestration entry point.
 *
 * Ties the phases together:
 *   1. gate        — decide if decomposing is worth it (cost-aware)
 *   2. planner     — produce a validated subtask DAG (one model call)
 *   3. dispatcher  — run subtasks (parallel within dependency levels, isolated context)
 *   4. synthesizer — combine results into the final answer (one model call)
 *   5. quality     — confidence-score the synthesis; flag low-confidence output
 *   6. telemetry   — record decision + estimated net token savings; shadow mode
 *
 * Opt-in via TASK_DECOMPOSITION_ENABLED=true. Requires AGENTS_ENABLED=true
 * (it builds on the subagent machinery). Any failure degrades gracefully to a
 * non-decomposed result so the caller can solve monolithically.
 */

const config = require("../../config");
const logger = require("../../logger");
const { shouldDecompose } = require("./gate");
const { generatePlan } = require("./planner");
const { dispatchPlan } = require("./dispatcher");
const { synthesize } = require("./synthesizer");
const telemetry = require("./telemetry");
const { analyzeComplexity } = require("../../routing/complexity-analyzer");
const confidenceScorer = require("../../routing/confidence-scorer");

const CODE_HINT_RE = /\b(code|function|implement|refactor|bug|class|api|module|test)\b/i;

function getConfig() {
  return (
    config.taskDecomposition || {
      enabled: false,
      shadow: false,
      planModel: "sonnet",
      synthModel: "sonnet",
      minConfidence: 0.5,
      gate: {},
    }
  );
}

/**
 * @param {string} task - the task text to (maybe) decompose
 * @param {Object} [options]
 * @param {string} [options.sessionId]
 * @param {string} [options.cwd]
 * @param {string} [options.riskLevel] - 'high' disables decomposition
 * @param {Object} [options._inject] - test seams { generatePlan, dispatchPlan, synthesize, analyze }
 * @returns {Promise<Object>} result object (see below)
 */
async function runDecomposedTask(task, options = {}) {
  const cfg = getConfig();
  const inject = options._inject || {};

  if (!cfg.enabled) {
    return { decomposed: false, reason: "disabled" };
  }
  if (!config.agents?.enabled) {
    return { decomposed: false, reason: "agents_disabled" };
  }
  if (!task || typeof task !== "string") {
    return { decomposed: false, reason: "empty_task" };
  }

  const payload = { messages: [{ role: "user", content: task }] };

  let analysis;
  try {
    analysis = await (inject.analyze || analyzeComplexity)(payload);
  } catch (err) {
    logger.warn({ err: err.message }, "[Decomposition] Complexity analysis failed");
    return { decomposed: false, reason: "analysis_failed" };
  }

  const monolithicTokens =
    analysis?.breakdown?.tokens?.estimated || telemetry.estimateTokens(task);

  const gate = shouldDecompose(analysis, payload, {
    config: cfg.gate,
    riskLevel: options.riskLevel,
    taskText: task,
  });

  // Shadow mode: record what we WOULD do, but never actually decompose.
  if (cfg.shadow) {
    telemetry.record({
      mode: "shadow",
      sessionId: options.sessionId,
      gate,
      monolithicTokens,
    });
    return { decomposed: false, reason: "shadow_mode", gate };
  }

  if (!gate.decompose) {
    telemetry.record({ mode: "live", decision: "skip", gate, monolithicTokens });
    return { decomposed: false, reason: gate.reason, gate };
  }

  // Phase 2: plan
  const plan = await (inject.generatePlan || generatePlan)({
    task,
    model: cfg.planModel,
    maxSubtasks: cfg.gate?.maxSubtasks || 6,
  });
  if (!plan) {
    telemetry.record({ mode: "live", decision: "plan_failed", gate, monolithicTokens });
    return { decomposed: false, reason: "plan_failed", gate };
  }

  // Phase 3: dispatch
  const dispatch = await (inject.dispatchPlan || dispatchPlan)(plan, {
    sessionId: options.sessionId,
    cwd: options.cwd,
  });

  // Phase 4: synthesize
  const synth = await (inject.synthesize || synthesize)({
    task,
    subtaskResults: dispatch.results,
    model: cfg.synthModel,
  });

  // Phase 5: quality gate
  const taskType = CODE_HINT_RE.test(task) ? "code" : "reasoning";
  let confidence = 1;
  try {
    confidence = await confidenceScorer.score(
      { content: [{ type: "text", text: synth.text }] },
      { taskType }
    );
  } catch (err) {
    logger.debug({ err: err.message }, "[Decomposition] Confidence scoring failed");
  }
  const belowThreshold = confidence < (cfg.minConfidence ?? 0.5);

  const savings = telemetry.estimateSavings({
    monolithicTokens,
    planUsage: plan.usage,
    dispatchStats: dispatch.stats,
    synthUsage: synth.usage,
  });

  telemetry.record({
    mode: "live",
    decision: "decomposed",
    sessionId: options.sessionId,
    gate,
    subtasks: plan.subtasks.length,
    levels: dispatch.levels.length,
    strategy: plan.strategy,
    confidence,
    belowThreshold,
    synthesisFallback: synth.fallback,
    savings,
  });

  logger.info(
    {
      subtasks: plan.subtasks.length,
      levels: dispatch.levels.length,
      confidence: confidence.toFixed(2),
      savedTokens: savings.savedTokens,
    },
    "[Decomposition] Task decomposed"
  );

  return {
    decomposed: true,
    result: synth.text,
    reason: "decomposed",
    plan,
    subtaskResults: dispatch.results,
    quality: { confidence, belowThreshold, taskType },
    // When confidence is low, the caller should prefer a monolithic re-solve.
    recommendFallback: belowThreshold,
    stats: { ...dispatch.stats, levels: dispatch.levels.length },
    savings,
    gate,
  };
}

module.exports = { runDecomposedTask, getConfig };
