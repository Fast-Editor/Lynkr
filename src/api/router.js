const express = require("express");
const { processMessage } = require("../orchestrator");
const { getSession } = require("../sessions");
const metrics = require("../metrics");
const { createRateLimiter } = require("./middleware/rate-limiter");
const openaiRouter = require("./openai-router");
const providersRouter = require("./providers-handler");
const { getRoutingHeaders, getRoutingStats, analyzeComplexity } = require("../routing");

const router = express.Router();

// Create rate limiter middleware
const rateLimiter = createRateLimiter();

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

// Routing stats endpoint (Phase 3: Metrics)
router.get("/routing/stats", (req, res) => {
  const stats = getRoutingStats();
  res.json({
    status: "ok",
    stats: stats || { message: "No routing decisions recorded yet" },
  });
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

router.post("/v1/messages/count_tokens", rateLimiter, async (req, res, next) => {
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

router.post("/v1/messages", rateLimiter, async (req, res, next) => {
  try {
    metrics.recordRequest();
    // Support both query parameter (?stream=true) and body parameter ({"stream": true})
    const wantsStream = Boolean(req.query?.stream === 'true' || req.body?.stream);
    const hasTools = Array.isArray(req.body?.tools) && req.body.tools.length > 0;

    // Analyze complexity for routing headers (Phase 3)
    const complexity = analyzeComplexity(req.body);
    const routingHeaders = getRoutingHeaders({
      provider: complexity.recommendation === 'local' ? 'ollama' : 'cloud',
      score: complexity.score,
      threshold: complexity.threshold,
      method: 'complexity',
      reason: complexity.breakdown?.taskType?.reason || complexity.recommendation,
    });

    // For true streaming: only support non-tool requests for MVP
    // Tool requests require buffering for agent loop
    if (wantsStream && !hasTools) {
      // True streaming path for text-only requests
      metrics.recordStreamingStart();
      res.set({
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        ...routingHeaders,  // Include routing headers
      });
      if (typeof res.flushHeaders === "function") {
        res.flushHeaders();
      }

      const result = await processMessage({
        payload: req.body,
        headers: req.headers,
        session: req.session,
        options: {
          maxSteps: req.body?.max_steps,
          maxDurationMs: req.body?.max_duration_ms,
        },
      });

      // Check if we got a stream back
      if (result.stream) {
        // Parse SSE stream from provider and forward to client
        const reader = result.stream.getReader();
        const decoder = new TextDecoder();
        const bufferChunks = []; // Use array to avoid string concatenation overhead

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            const chunk = decoder.decode(value, { stream: true });
            bufferChunks.push(chunk);

            // Join buffer and split by lines
            const buffer = bufferChunks.join('');
            const lines = buffer.split('\n');

            // Keep last incomplete line in buffer chunks
            const remaining = lines.pop() || '';
            bufferChunks.length = 0;
            if (remaining) bufferChunks.push(remaining);

            for (const line of lines) {
              if (line.trim()) {
                res.write(line + '\n');
              }
            }

            // Flush after each chunk
            if (typeof res.flush === 'function') {
              res.flush();
            }
          }

          // Send any remaining buffer
          const remaining = bufferChunks.join('');
          if (remaining.trim()) {
            res.write(remaining + '\n');
          }

          metrics.recordResponse(200);
          res.end();
          return;
        } catch (streamError) {
          logger.error({ error: streamError }, "Error streaming response");

          // Cancel stream on error
          try {
            await reader.cancel();
          } catch (cancelError) {
            logger.debug({ error: cancelError }, "Failed to cancel stream");
          }

          if (!res.headersSent) {
            res.status(500).json({ error: "Streaming error" });
          } else {
            res.end();
          }
          return;
        } finally {
          // CRITICAL: Always release lock
          try {
            reader.releaseLock();
          } catch (releaseError) {
            // Lock may already be released, ignore
            logger.debug({ error: releaseError }, "Stream lock already released");
          }
        }
      }

      // Fallback: if no stream, wrap buffered response in proper Anthropic SSE format
      // Check if result.body exists
      if (!result || !result.body) {
        res.write(`event: error\n`);
        res.write(`data: ${JSON.stringify({ type: "error", error: { message: "Empty response from provider" } })}\n\n`);
        res.end();
        return;
      }

      const msg = result.body;

      // 1. message_start
      res.write(`event: message_start\n`);
      res.write(`data: ${JSON.stringify({
        type: "message_start",
        message: {
          id: msg.id,
          type: "message",
          role: "assistant",
          content: [],
          model: msg.model,
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: msg.usage?.input_tokens || 0, output_tokens: 1 }
        }
      })}\n\n`);

      // 2. content_block_start and content_block_delta for each content block
      const contentBlocks = msg.content || [];
      for (let i = 0; i < contentBlocks.length; i++) {
        const block = contentBlocks[i];

        if (block.type === "text") {
          res.write(`event: content_block_start\n`);
          res.write(`data: ${JSON.stringify({
            type: "content_block_start",
            index: i,
            content_block: { type: "text", text: "" }
          })}\n\n`);

          // Send text in chunks
          const text = block.text || "";
          const chunkSize = 20;
          for (let j = 0; j < text.length; j += chunkSize) {
            const chunk = text.slice(j, j + chunkSize);
            res.write(`event: content_block_delta\n`);
            res.write(`data: ${JSON.stringify({
              type: "content_block_delta",
              index: i,
              delta: { type: "text_delta", text: chunk }
            })}\n\n`);
          }

          res.write(`event: content_block_stop\n`);
          res.write(`data: ${JSON.stringify({ type: "content_block_stop", index: i })}\n\n`);
        } else if (block.type === "tool_use") {
          res.write(`event: content_block_start\n`);
          res.write(`data: ${JSON.stringify({
            type: "content_block_start",
            index: i,
            content_block: { type: "tool_use", id: block.id, name: block.name, input: {} }
          })}\n\n`);

          res.write(`event: content_block_delta\n`);
          res.write(`data: ${JSON.stringify({
            type: "content_block_delta",
            index: i,
            delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) }
          })}\n\n`);

          res.write(`event: content_block_stop\n`);
          res.write(`data: ${JSON.stringify({ type: "content_block_stop", index: i })}\n\n`);
        }
      }

      // 3. message_delta with stop_reason
      res.write(`event: message_delta\n`);
      res.write(`data: ${JSON.stringify({
        type: "message_delta",
        delta: { stop_reason: msg.stop_reason || "end_turn", stop_sequence: null },
        usage: { output_tokens: msg.usage?.output_tokens || 0 }
      })}\n\n`);

      // 4. message_stop
      res.write(`event: message_stop\n`);
      res.write(`data: ${JSON.stringify({ type: "message_stop" })}\n\n`);

      metrics.recordResponse(result.status);
      res.end();
      return;
    }

    // Non-streaming or tool-based requests (buffered path)
    const result = await processMessage({
      payload: req.body,
      headers: req.headers,
      session: req.session,
      options: {
        maxSteps: req.body?.max_steps,
        maxDurationMs: req.body?.max_duration_ms,
      },
    });

    // Legacy streaming wrapper (for tool-based requests that requested streaming)
    if (wantsStream && hasTools) {
      metrics.recordStreamingStart();
      res.set({
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      if (typeof res.flushHeaders === "function") {
        res.flushHeaders();
      }

      // Check if result.body exists
      if (!result || !result.body) {
        res.write(`event: error\n`);
        res.write(`data: ${JSON.stringify({ type: "error", error: { message: "Empty response from provider" } })}\n\n`);
        res.end();
        return;
      }

      // Use proper Anthropic SSE format
      const msg = result.body;

      // 1. message_start
      res.write(`event: message_start\n`);
      res.write(`data: ${JSON.stringify({
        type: "message_start",
        message: {
          id: msg.id,
          type: "message",
          role: "assistant",
          content: [],
          model: msg.model,
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: msg.usage?.input_tokens || 0, output_tokens: 1 }
        }
      })}\n\n`);

      // 2. content_block_start and content_block_delta for each content block
      const contentBlocks = msg.content || [];
      for (let i = 0; i < contentBlocks.length; i++) {
        const block = contentBlocks[i];

        if (block.type === "text") {
          res.write(`event: content_block_start\n`);
          res.write(`data: ${JSON.stringify({
            type: "content_block_start",
            index: i,
            content_block: { type: "text", text: "" }
          })}\n\n`);

          const text = block.text || "";
          const chunkSize = 20;
          for (let j = 0; j < text.length; j += chunkSize) {
            const chunk = text.slice(j, j + chunkSize);
            res.write(`event: content_block_delta\n`);
            res.write(`data: ${JSON.stringify({
              type: "content_block_delta",
              index: i,
              delta: { type: "text_delta", text: chunk }
            })}\n\n`);
          }

          res.write(`event: content_block_stop\n`);
          res.write(`data: ${JSON.stringify({ type: "content_block_stop", index: i })}\n\n`);
        } else if (block.type === "tool_use") {
          res.write(`event: content_block_start\n`);
          res.write(`data: ${JSON.stringify({
            type: "content_block_start",
            index: i,
            content_block: { type: "tool_use", id: block.id, name: block.name, input: {} }
          })}\n\n`);

          res.write(`event: content_block_delta\n`);
          res.write(`data: ${JSON.stringify({
            type: "content_block_delta",
            index: i,
            delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) }
          })}\n\n`);

          res.write(`event: content_block_stop\n`);
          res.write(`data: ${JSON.stringify({ type: "content_block_stop", index: i })}\n\n`);
        }
      }

      // 3. message_delta with stop_reason
      res.write(`event: message_delta\n`);
      res.write(`data: ${JSON.stringify({
        type: "message_delta",
        delta: { stop_reason: msg.stop_reason || "end_turn", stop_sequence: null },
        usage: { output_tokens: msg.usage?.output_tokens || 0 }
      })}\n\n`);

      // 4. message_stop
      res.write(`event: message_stop\n`);
      res.write(`data: ${JSON.stringify({ type: "message_stop" })}\n\n`);

      metrics.recordResponse(result.status);
      res.end();
      return;
    }

    // Add routing headers (Phase 3)
    Object.entries(routingHeaders).forEach(([key, value]) => {
      if (value !== undefined) {
        res.setHeader(key, value);
      }
    });

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

// List available agents (must come before parameterized routes)
router.get("/v1/agents", (req, res) => {
  try {
    const { listAgents } = require("../agents");
    const agents = listAgents();
    res.json({ agents });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Agent stats endpoint (specific path before parameterized)
router.get("/v1/agents/stats", (req, res) => {
  try {
    const { getAgentStats } = require("../agents");
    const stats = getAgentStats();
    res.json({ stats });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Read agent transcript (specific path with param before catch-all)
router.get("/v1/agents/:agentId/transcript", (req, res) => {
  try {
    const ContextManager = require("../agents/context-manager");
    const cm = new ContextManager();
    const transcript = cm.readTranscript(req.params.agentId);

    if (!transcript) {
      return res.status(404).json({ error: "Transcript not found" });
    }

    res.json({ transcript });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Agent execution details (parameterized - must come last)
router.get("/v1/agents/:executionId", (req, res) => {
  try {
    const { getAgentExecution } = require("../agents");
    const details = getAgentExecution(req.params.executionId);

    if (!details) {
      return res.status(404).json({ error: "Execution not found" });
    }

    res.json(details);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Token usage statistics for a session
router.get("/api/sessions/:sessionId/tokens", (req, res) => {
  try {
    const tokens = require("../utils/tokens");
    const { sessionId } = req.params;
    const session = getSession(sessionId);

    if (!session) {
      return res.status(404).json({ error: "Session not found" });
    }

    const stats = tokens.getSessionTokenStats(session);

    res.json({
      sessionId,
      stats: {
        turns: stats.turns,
        totalTokens: stats.totalTokens,
        totalCost: parseFloat(stats.totalCost.toFixed(4)),
        averageTokensPerTurn: stats.averageTokensPerTurn,
        cacheHitRate: parseFloat(stats.cacheHitRate) + '%'
      },
      breakdown: stats.breakdown.map(turn => ({
        turn: turn.turn,
        timestamp: turn.timestamp,
        model: turn.model,
        estimated: turn.estimated.total,
        actual: {
          input: turn.actual.inputTokens,
          output: turn.actual.outputTokens,
          cached: turn.actual.cacheReadTokens,
          total: turn.actual.totalTokens
        },
        cost: parseFloat(turn.cost.total.toFixed(6))
      }))
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Global token usage statistics (all sessions)
router.get("/api/tokens/stats", (req, res) => {
  try {
    const tokens = require("../utils/tokens");
    const { getAllSessions } = require("../sessions");
    const allSessions = getAllSessions();

    let totalTokens = 0;
    let totalCost = 0;
    let totalTurns = 0;
    let totalSessions = 0;

    for (const session of allSessions) {
      const stats = tokens.getSessionTokenStats(session);
      if (stats.turns > 0) {
        totalTokens += stats.totalTokens;
        totalCost += stats.totalCost;
        totalTurns += stats.turns;
        totalSessions++;
      }
    }

    res.json({
      global: {
        sessions: totalSessions,
        turns: totalTurns,
        totalTokens,
        totalCost: parseFloat(totalCost.toFixed(4)),
        averageTokensPerTurn: totalTurns > 0 ? Math.round(totalTokens / totalTurns) : 0,
        averageTokensPerSession: totalSessions > 0 ? Math.round(totalTokens / totalSessions) : 0
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Mount OpenAI-compatible endpoints for Cursor IDE support
router.use("/v1", openaiRouter);

// Mount Anthropic-compatible provider discovery endpoints (cc-relay style)
// These provide /v1/models and /v1/providers for Claude Code CLI compatibility
router.use("/v1", providersRouter);

// Headroom compression endpoints
router.get("/metrics/compression", async (req, res) => {
  try {
    const { getCombinedMetrics } = require("../headroom");
    const metrics = await getCombinedMetrics();
    res.json(metrics);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get("/health/headroom", async (req, res) => {
  try {
    const { getHeadroomManager } = require("../headroom");
    const manager = getHeadroomManager();
    const health = await manager.getHealth();
    res.status(health.healthy ? 200 : 503).json(health);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get("/headroom/status", async (req, res) => {
  try {
    const { getHeadroomManager } = require("../headroom");
    const manager = getHeadroomManager();
    const status = await manager.getDetailedStatus();
    res.json(status);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post("/headroom/restart", async (req, res) => {
  try {
    const { getHeadroomManager } = require("../headroom");
    const manager = getHeadroomManager();
    const result = await manager.restart();
    res.json({ success: true, ...result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get("/headroom/logs", async (req, res) => {
  try {
    const { getHeadroomManager } = require("../headroom");
    const manager = getHeadroomManager();
    const tail = parseInt(req.query.tail || "100", 10);
    const logs = await manager.getLogs(tail);

    if (logs === null) {
      return res.status(400).json({ error: "Docker management is disabled" });
    }

    res.type("text/plain").send(logs);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
