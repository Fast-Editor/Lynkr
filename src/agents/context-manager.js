const fs = require("fs");
const path = require("path");
const logger = require("../logger");

class ContextManager {
  constructor() {
    this.transcriptsDir = path.join(process.cwd(), "data", "agent-transcripts");
    this.ensureTranscriptsDir();
  }

  ensureTranscriptsDir() {
    if (!fs.existsSync(this.transcriptsDir)) {
      fs.mkdirSync(this.transcriptsDir, { recursive: true });
    }
  }

  /**
   * Create fresh context for subagent
   * @param {Object} agentDef - Agent definition
   * @param {string} taskPrompt - Task from main agent
   * @param {Object} mainContext - Minimal context from main agent
   * @returns {Object} - Fresh context for subagent
   */
  createSubagentContext(agentDef, taskPrompt, mainContext = {}) {
    const agentId = this.generateAgentId();
    const transcriptPath = path.join(this.transcriptsDir, `agent-${agentId}.jsonl`);

    // Initialize transcript file
    fs.writeFileSync(transcriptPath, "");

    // Build minimal context (NOT full main agent history)
    const messages = [];

    // System prompt from agent definition
    messages.push({
      role: "system",
      content: agentDef.systemPrompt
    });

    // Optional: Add minimal context from main agent
    if (mainContext.relevant_context) {
      messages.push({
        role: "system",
        content: `Context from main agent:\n${mainContext.relevant_context}`
      });
    }

    // Task prompt
    messages.push({
      role: "user",
      content: taskPrompt
    });

    const context = {
      agentId,
      agentName: agentDef.name,
      transcriptPath,
      messages,
      steps: 0,
      maxSteps: agentDef.maxSteps,
      model: agentDef.model,
      allowedTools: agentDef.allowedTools,
      startTime: Date.now(),

      // Original task prompt — consumed by the Reflector to infer task type.
      taskPrompt,

      // In-memory transcript mirror of the JSONL file — consumed by the
      // Reflector for tool-usage / error-recovery analysis. The JSONL file
      // remains the durable record; this array is the hot-path copy.
      transcript: [],

      // Token tracking
      inputTokens: 0,
      outputTokens: 0,

      // State
      terminated: false,
      result: null
    };

    this.writeTranscriptEntry(transcriptPath, {
      type: "agent_start",
      agentId,
      agentName: agentDef.name,
      taskPrompt,
      timestamp: Date.now()
    });

    logger.info({ agentId, agentName: agentDef.name }, "Created fresh subagent context");

    return context;
  }

  /**
   * Add message to subagent context
   */
  addMessage(context, message) {
    context.messages.push(message);

    this.writeTranscriptEntry(context.transcriptPath, {
      type: "message",
      agentId: context.agentId,
      message,
      timestamp: Date.now()
    });
  }

  /**
   * Record tool execution in transcript
   */
  recordToolCall(context, toolName, input, output, error = null) {
    const entry = {
      type: "tool_call",
      agentId: context.agentId,
      step: context.steps,
      toolName,
      input,
      output: error ? null : output,
      error: error ? error.message : null,
      timestamp: Date.now()
    };

    // Keep the in-memory transcript in sync so the Reflector (which reads
    // context.transcript) sees tool calls without re-parsing the JSONL file.
    if (Array.isArray(context.transcript)) {
      context.transcript.push(entry);
    }

    this.writeTranscriptEntry(context.transcriptPath, entry);
  }

  /**
   * Complete subagent execution
   */
  completeExecution(context, result) {
    context.terminated = true;
    context.result = result;

    this.writeTranscriptEntry(context.transcriptPath, {
      type: "agent_complete",
      agentId: context.agentId,
      result,
      stats: {
        steps: context.steps,
        durationMs: Date.now() - context.startTime,
        inputTokens: context.inputTokens,
        outputTokens: context.outputTokens
      },
      timestamp: Date.now()
    });

    logger.info({
      agentId: context.agentId,
      steps: context.steps,
      durationMs: Date.now() - context.startTime
    }, "Subagent execution completed");
  }

  /**
   * Fail subagent execution
   */
  failExecution(context, error) {
    context.terminated = true;

    this.writeTranscriptEntry(context.transcriptPath, {
      type: "agent_failed",
      agentId: context.agentId,
      error: error.message,
      stats: {
        steps: context.steps,
        durationMs: Date.now() - context.startTime
      },
      timestamp: Date.now()
    });

    logger.error({
      agentId: context.agentId,
      error: error.message
    }, "Subagent execution failed");
  }

  /**
   * Write entry to transcript file (JSONL format)
   */
  writeTranscriptEntry(transcriptPath, entry) {
    try {
      fs.appendFileSync(transcriptPath, JSON.stringify(entry) + "\n");
    } catch (error) {
      logger.warn({ error: error.message }, "Failed to write transcript entry");
    }
  }

  /**
   * Read transcript for debugging
   */
  readTranscript(agentId) {
    const transcriptPath = path.join(this.transcriptsDir, `agent-${agentId}.jsonl`);

    if (!fs.existsSync(transcriptPath)) {
      return null;
    }

    const lines = fs.readFileSync(transcriptPath, "utf8").split("\n").filter(l => l.trim());
    return lines.map(line => JSON.parse(line));
  }

  /**
   * Generate unique agent ID
   */
  generateAgentId() {
    return `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  }

  /**
   * Clean old transcripts (older than 7 days)
   */
  cleanOldTranscripts() {
    const maxAge = 7 * 24 * 60 * 60 * 1000; // 7 days
    const now = Date.now();

    const files = fs.readdirSync(this.transcriptsDir);

    for (const file of files) {
      const filePath = path.join(this.transcriptsDir, file);
      const stats = fs.statSync(filePath);

      if (now - stats.mtimeMs > maxAge) {
        fs.unlinkSync(filePath);
        logger.debug({ file }, "Cleaned old transcript");
      }
    }
  }
}

module.exports = ContextManager;
