const { registerTool } = require(".");
const { runDecomposedTask } = require("../agents/decomposition");
const logger = require("../logger");

/**
 * DecomposeTask tool — breaks a complex task into focused subtasks with isolated
 * context, runs them (parallel where independent), and synthesizes the result.
 *
 * Opt-in: requires TASK_DECOMPOSITION_ENABLED=true and AGENTS_ENABLED=true.
 * Degrades gracefully — if the gate decides decomposition isn't worth it (or
 * planning fails), it returns ok:true with decomposed:false and a reason so the
 * caller can solve the task monolithically.
 */
function registerDecomposeTool() {
  registerTool(
    "DecomposeTask",
    async ({ args = {} }, context = {}) => {
      const task = args.task || args.prompt || args.description;

      if (!task || typeof task !== "string") {
        return {
          ok: false,
          status: 400,
          content: JSON.stringify({ error: "task is required" }, null, 2),
        };
      }

      logger.info(
        { task: task.slice(0, 100), sessionId: context.sessionId },
        "DecomposeTask: evaluating task for decomposition"
      );

      try {
        const result = await runDecomposedTask(task, {
          sessionId: context.sessionId,
          cwd: context.cwd,
          riskLevel: args.riskLevel || context.riskLevel,
        });

        if (result.decomposed) {
          return {
            ok: true,
            status: 200,
            content: result.result,
            metadata: {
              decomposed: true,
              subtasks: result.plan?.subtasks?.length,
              levels: result.stats?.levels,
              strategy: result.plan?.strategy,
              confidence: result.quality?.confidence,
              recommendFallback: result.recommendFallback,
              savedTokens: result.savings?.savedTokens,
            },
          };
        }

        // Not decomposed — signal the caller to solve monolithically.
        return {
          ok: true,
          status: 200,
          content: JSON.stringify(
            {
              decomposed: false,
              reason: result.reason,
              guidance: "Solve this task directly without decomposition.",
            },
            null,
            2
          ),
          metadata: { decomposed: false, reason: result.reason },
        };
      } catch (error) {
        logger.error({ error: error.message }, "DecomposeTask: error");
        return {
          ok: false,
          status: 500,
          content: JSON.stringify(
            { error: "Decomposition error", message: error.message },
            null,
            2
          ),
        };
      }
    },
    { category: "decompose" }
  );

  logger.info("DecomposeTask tool registered");
}

module.exports = { registerDecomposeTool };
