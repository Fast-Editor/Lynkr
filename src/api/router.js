const express = require("express");
const { processMessage } = require("../orchestrator");
const { getSession } = require("../sessions");
const metrics = require("../metrics");

const router = express.Router();

/**
 * Estimate token count for messages
 * Uses rough approximation of ~4 characters per token
 * @param {Array} messages - Array of message objects with role and content
 * @param {string|Array} system - System prompt (string or array of content blocks)
 * @returns {number} Estimated input token count
 */
function estimateTokenCount(messages = [], system = null) {
  let totalChars = 0;

  // Count system prompt characters
  if (system) {
    if (typeof system === "string") {
      totalChars += system.length;
    } else if (Array.isArray(system)) {
      system.forEach((block) => {
        if (block.type === "text" && block.text) {
          totalChars += block.text.length;
        }
      });
    }
  }

  // Count message characters
  messages.forEach((msg) => {
    if (msg.content) {
      if (typeof msg.content === "string") {
        totalChars += msg.content.length;
      } else if (Array.isArray(msg.content)) {
        msg.content.forEach((block) => {
          if (block.type === "text" && block.text) {
            totalChars += block.text.length;
          } else if (block.type === "image" && block.source?.data) {
            // Images: rough estimate based on base64 length
            totalChars += Math.floor(block.source.data.length / 6);
          }
        });
      }
    }
  });

  // Estimate tokens: ~4 characters per token
  return Math.ceil(totalChars / 4);
}

router.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

router.get("/debug/session", (req, res) => {
  if (!req.sessionId) {
    return res.status(400).json({ error: "missing_session_id", message: "Provide x-session-id header" });
  }
  const session = getSession(req.sessionId);
  if (!session) {
    return res.status(404).json({ error: "session_not_found", message: "Session not found" });
  }
  res.json({ session });
});

router.post("/v1/messages/count_tokens", async (req, res, next) => {
  try {
    const { messages, system } = req.body;

    // Validate required fields
    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({
        error: {
          type: "invalid_request_error",
          message: "messages must be a non-empty array",
        },
      });
    }

    // Estimate token count
    const inputTokens = estimateTokenCount(messages, system);

    // Return token count in Anthropic API format
    res.json({
      input_tokens: inputTokens,
    });
  } catch (error) {
    next(error);
  }
});

// Stub endpoint for event logging (used by Claude CLI)
router.post("/api/event_logging/batch", (req, res) => {
  // Silently accept and discard event logging requests
  res.status(200).json({ success: true });
});

router.post("/v1/messages", async (req, res, next) => {
  try {
    metrics.recordRequest();
    // Support both query parameter (?stream=true) and body parameter ({"stream": true})
    const wantsStream = Boolean(req.query?.stream === 'true' || req.body?.stream);
    const result = await processMessage({
      payload: req.body,
      headers: req.headers,
      session: req.session,
      options: {
        maxSteps: req.body?.max_steps,
        maxDurationMs: req.body?.max_duration_ms,
      },
    });

    if (wantsStream) {
      metrics.recordStreamingStart();
      res.set({
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      if (typeof res.flushHeaders === "function") {
        res.flushHeaders();
      }

      const eventPayload = {
        type: "message",
        message: result.body,
      };
      res.write(`event: message\n`);
      res.write(`data: ${JSON.stringify(eventPayload)}\n\n`);

      res.write(`event: end\n`);
      res.write(
        `data: ${JSON.stringify({ termination: result.terminationReason ?? "completion" })}\n\n`,
      );

      metrics.recordResponse(result.status);
      res.end();
      return;
    }

    if (result.headers) {
      Object.entries(result.headers).forEach(([key, value]) => {
        if (value !== undefined) {
          res.setHeader(key, value);
        }
      });
    }

    metrics.recordResponse(result.status);
    res.status(result.status).send(result.body);
  } catch (error) {
    next(error);
  }
});

module.exports = router;
