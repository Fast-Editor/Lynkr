const { registerTool } = require(".");
const { spawnAgent, autoSelectAgent } = require("../agents");
const logger = require("../logger");

function registerAgentTaskTool() {
  registerTool(
    "Task",
    async ({ args = {} }, context = {}) => {
      let subagentType = args.subagent_type || args.type;
      const prompt = args.prompt;
      const description = args.description || "Agent task";

      if (!prompt) {
        return {
          ok: false,
          status: 400,
          content: JSON.stringify({
            error: "prompt is required"
          }, null, 2)
        };
      }

      // Auto-select agent if not specified
      if (!subagentType) {
        const selected = autoSelectAgent(prompt);
        if (selected) {
          subagentType = selected.name;
          logger.info({
            selectedAgent: subagentType,
            prompt: prompt.slice(0, 50)
          }, "Auto-selected subagent");
        } else {
          subagentType = "Explore"; // Default fallback
        }
      }

      logger.info({
        subagentType,
        prompt: prompt.slice(0, 100),
        sessionId: context.sessionId,
        cwd: context.cwd
      }, "Task tool: spawning subagent");

      try {
        const result = await spawnAgent(subagentType, prompt, {
          sessionId: context.sessionId,
          cwd: context.cwd, // Pass client CWD to subagent
          mainContext: context.mainContext // Pass minimal context
        });

        if (result.success) {
          return {
            ok: true,
            status: 200,
            content: result.result,
            metadata: {
              agentType: subagentType,
              agentId: result.stats.agentId,
              steps: result.stats.steps,
              durationMs: result.stats.durationMs
            }
          };
        } else {
          return {
            ok: false,
            status: 500,
            content: JSON.stringify({
              error: "Subagent execution failed",
              message: result.error
            }, null, 2)
          };
        }

      } catch (error) {
        logger.error({
          error: error.message,
          subagentType
        }, "Task tool: subagent error");

        return {
          ok: false,
          status: 500,
          content: JSON.stringify({
            error: "Subagent error",
            message: error.message
          }, null, 2)
        };
      }
    },
    { category: "agents" }
  );

  logger.info("Task tool registered");
}

module.exports = {
  registerAgentTaskTool
};
