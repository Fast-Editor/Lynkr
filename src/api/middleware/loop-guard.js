/**
 * Loop guard — runaway-agent circuit breaker (WS: multi-agent cost controls).
 *
 * Agent frameworks (LangGraph, CrewAI, AutoGen) resend the full growing
 * conversation every round-trip, so an uncapped tool loop compounds: each
 * turn pays for every previous turn again. Real-world failure mode this
 * guards: an AutoGen deployment ran 40% over budget in its first month from
 * exactly this (uncapped reviewer<->coder loops).
 *
 * The guard is STATELESS — it reads loop depth from the incoming payload
 * itself rather than tracking sessions:
 *   - message count  ≈ total turns so far
 *   - tool_result count ≈ tool-loop iterations so far
 * Both survive proxy restarts and need no session affinity.
 *
 * Disabled by default (caps unset/0). Enable per deployment:
 *   LYNKR_MAX_SESSION_TURNS=80    reject when messages[] exceeds 80 entries
 *   LYNKR_MAX_TOOL_TURNS=25       reject when tool_result blocks exceed 25
 *
 * Rejections use 429 + a machine-readable error type so agent frameworks
 * surface them as a hard stop instead of retrying blindly.
 */

const logger = require("../../logger");

function _countToolResults(messages) {
  let n = 0;
  for (const m of messages) {
    if (!Array.isArray(m?.content)) continue;
    for (const block of m.content) {
      if (block?.type === "tool_result") n++;
    }
  }
  return n;
}

function _cap(name) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : null;
}

function loopGuard(req, res, next) {
  const maxTurns = _cap("LYNKR_MAX_SESSION_TURNS");
  const maxToolTurns = _cap("LYNKR_MAX_TOOL_TURNS");
  if (!maxTurns && !maxToolTurns) return next();

  const messages = Array.isArray(req.body?.messages) ? req.body.messages : [];

  if (maxTurns && messages.length > maxTurns) {
    logger.warn(
      { messageCount: messages.length, cap: maxTurns, path: req.path },
      "[LoopGuard] conversation exceeded turn cap"
    );
    return res.status(429).json({
      error: {
        type: "loop_cap_exceeded",
        message:
          `Conversation has ${messages.length} messages, over the configured ` +
          `cap of ${maxTurns} (LYNKR_MAX_SESSION_TURNS). This usually means an ` +
          `agent loop is not converging — inspect the conversation before raising the cap.`,
      },
    });
  }

  if (maxToolTurns) {
    const toolResults = _countToolResults(messages);
    if (toolResults > maxToolTurns) {
      logger.warn(
        { toolResults, cap: maxToolTurns, path: req.path },
        "[LoopGuard] conversation exceeded tool-turn cap"
      );
      return res.status(429).json({
        error: {
          type: "loop_cap_exceeded",
          message:
            `Conversation carries ${toolResults} tool results, over the configured ` +
            `cap of ${maxToolTurns} (LYNKR_MAX_TOOL_TURNS). This usually means a ` +
            `tool loop is stuck — inspect the last few tool calls before raising the cap.`,
        },
      });
    }
  }

  return next();
}

module.exports = { loopGuard, _countToolResults };
