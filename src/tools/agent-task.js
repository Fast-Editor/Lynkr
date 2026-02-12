const { registerTool } = require(".");
const { spawnAgent, autoSelectAgent } = require("../agents");
const logger = require("../logger");

/**
 * Extract text from Anthropic content blocks format
 * Handles: [{"type":"text","text":"..."}] -> "..."
 */
function extractTextFromContentBlocks(content) {
  if (typeof content !== 'string') {
    return content;
  }

  const trimmed = content.trim();
  if (!trimmed.startsWith('[')) {
    return content;
  }

  try {
    const parsed = JSON.parse(trimmed);
    if (!Array.isArray(parsed)) {
      return content;
    }

    // Extract text from content blocks
    const textParts = parsed
      .filter(block => block && typeof block === 'object')
      .map(block => {
        if (block.type === 'text' && typeof block.text === 'string') {
          return block.text;
        }
        if (typeof block.text === 'string') {
          return block.text;
        }
        return null;
      })
      .filter(text => text !== null);

    if (textParts.length > 0) {
      return textParts.join('\n\n');
    }

    return content;
  } catch {
    return content;
  }
}

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
          // Extract text from Anthropic content blocks if present
          const cleanContent = extractTextFromContentBlocks(result.result);

          return {
            ok: true,
            status: 200,
            content: cleanContent,
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
