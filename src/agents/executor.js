const logger = require("../logger");
const { executeToolCall, listTools } = require("../tools");
const { invokeModel } = require("../clients/databricks");
const { STANDARD_TOOLS } = require("../clients/standard-tools");
const ContextManager = require("./context-manager");
const Skillbook = require("./skillbook");
const Reflector = require("./reflector");

const contextManager = new ContextManager();

class SubagentExecutor {
  /**
   * Execute a single subagent
   * @param {Object} agentDef - Agent definition
   * @param {string} taskPrompt - Task to perform
   * @param {Object} options - sessionId, mainContext, etc.
   * @returns {Promise<Object>} - { success, result, stats }
   */
  async execute(agentDef, taskPrompt, options = {}) {
    // Create fresh isolated context
    const context = contextManager.createSubagentContext(
      agentDef,
      taskPrompt,
      options.mainContext
    );

    // Store client CWD in context for tool execution
    context.cwd = options.cwd;

    try {
      // Set timeout
      const timeout = options.timeout || 120000; // 2 minutes
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error("Subagent timeout")), timeout);
      });

      const executionPromise = this._runAgentLoop(context, options.sessionId);

      await Promise.race([executionPromise, timeoutPromise]);

      // Extract final result (summary only, not intermediate steps)
      const finalResult = this._extractFinalResult(context);

      contextManager.completeExecution(context, finalResult);

      // Learn from successful execution (async, non-blocking)
      this._learnFromExecution(context, true).catch(err => {
        logger.warn({
          agentType: agentDef.name,
          error: err.message
        }, "Failed to learn from execution");
      });

      return {
        success: true,
        result: finalResult,
        stats: {
          agentId: context.agentId,
          steps: context.steps,
          durationMs: Date.now() - context.startTime,
          inputTokens: context.inputTokens,
          outputTokens: context.outputTokens
        }
      };

    } catch (error) {
      contextManager.failExecution(context, error);

      // Learn from failed execution (async, non-blocking)
      this._learnFromExecution(context, false).catch(err => {
        logger.debug({
          agentType: agentDef.name,
          error: err.message
        }, "Failed to learn from failed execution");
      });

      return {
        success: false,
        error: error.message,
        stats: {
          agentId: context.agentId,
          steps: context.steps,
          durationMs: Date.now() - context.startTime
        }
      };
    }
  }

  /**
   * Run agent loop (similar to main orchestrator but isolated)
   */
  async _runAgentLoop(context, sessionId) {
    while (context.steps < context.maxSteps && !context.terminated) {
      context.steps++;

      logger.debug({
        agentId: context.agentId,
        step: context.steps,
        messageCount: context.messages.length
      }, "Subagent step starting");

      // Call model with filtered tools
      const response = await this._callModel(context);

      // Update token usage
      context.inputTokens += response.usage?.input_tokens || 0;
      context.outputTokens += response.usage?.output_tokens || 0;

      // Check stop reason
      if (response.stop_reason === "end_turn" || response.stop_reason === "stop_sequence") {
        // Agent finished - extract result
        context.result = this._extractTextFromContent(response.content);
        context.terminated = true;

        contextManager.addMessage(context, {
          role: "assistant",
          content: response.content
        });

        break;
      }

      // Execute tool calls if any
      if (response.stop_reason === "tool_use") {
        await this._executeTools(context, response.content, sessionId);
      } else {
        logger.warn({
          agentId: context.agentId,
          stopReason: response.stop_reason
        }, "Unexpected stop reason in subagent");

        context.result = this._extractTextFromContent(response.content);
        context.terminated = true;
        break;
      }
    }

    if (context.steps >= context.maxSteps && !context.terminated) {
      logger.warn({
        agentId: context.agentId,
        maxSteps: context.maxSteps
      }, "Subagent reached max steps");

      context.result = "Subagent incomplete - reached maximum steps";
    }
  }

  /**
   * Call model with subagent context
   */
  async _callModel(context) {
    const payload = {
      model: this._resolveModel(context.model),
      messages: context.messages,
      max_tokens: 4096,
      temperature: 0.3
    };

    // Add filtered tools for subagent (based on allowedTools)
    const filteredTools = this._getFilteredTools(context.allowedTools);
    if (filteredTools.length > 0) {
      payload.tools = filteredTools;
    }

    // Subagents always use the same provider as the main session
    const config = require('../config');
    const forceProvider = config.modelProvider?.type || null;

    // For Ollama: agent definitions use Claude names ("haiku" → "claude-3-haiku-20240307")
    // which Ollama doesn't know. Override to use the configured Ollama model.
    if (forceProvider === 'ollama' && config.ollama?.model) {
      payload.model = config.ollama.model;
    }

    logger.debug({
      agentId: context.agentId,
      model: payload.model,
      forceProvider,
      messageCount: context.messages.length,
      toolCount: filteredTools.length,
      toolNames: filteredTools.map(t => t.name)
    }, "Calling model for subagent");

    // Use invokeModel with forceProvider to ensure correct model routing
    const response = await invokeModel(payload, { forceProvider });

    if (!response.json) {
      throw new Error("Invalid model response");
    }

    return response.json;
  }

  /**
   * Execute tools (with restrictions)
   */
  async _executeTools(context, content, sessionId) {
    const toolUseBlocks = content.filter(block => block.type === "tool_use");

    if (toolUseBlocks.length === 0) {
      return;
    }

    // Add assistant message with tool calls
    contextManager.addMessage(context, {
      role: "assistant",
      content: content
    });

    // Execute each tool (sequentially for now, can parallelize later)
    const toolResults = [];

    for (const toolUse of toolUseBlocks) {
      const toolStart = Date.now();

      try {
        // Check if tool is allowed
        if (context.allowedTools.length > 0 && !this._isToolAllowed(toolUse.name, context.allowedTools)) {
          throw new Error(`Tool ${toolUse.name} not allowed for agent ${context.agentName}`);
        }

        // CRITICAL: Block Task tool for subagents (prevents recursion)
        if (toolUse.name === "Task") {
          throw new Error("Subagents cannot spawn other subagents");
        }

        logger.debug({
          agentId: context.agentId,
          step: context.steps,
          toolName: toolUse.name
        }, "Subagent executing tool");

        // Execute tool
        const result = await executeToolCall({
          name: toolUse.name,
          arguments: toolUse.input
        }, {
          sessionId: sessionId,
          agentId: context.agentId,
          cwd: context.cwd,
          isSubagent: true
        });

        const toolDuration = Date.now() - toolStart;

        // Record in transcript
        contextManager.recordToolCall(
          context,
          toolUse.name,
          toolUse.input,
          result.content,
          null
        );

        toolResults.push({
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: result.content
        });

      } catch (error) {
        const toolDuration = Date.now() - toolStart;

        logger.warn({
          agentId: context.agentId,
          toolName: toolUse.name,
          error: error.message
        }, "Subagent tool execution failed");

        contextManager.recordToolCall(
          context,
          toolUse.name,
          toolUse.input,
          null,
          error
        );

        toolResults.push({
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: `Error: ${error.message}`,
          is_error: true
        });
      }
    }

    // Add tool results as user message
    contextManager.addMessage(context, {
      role: "user",
      content: toolResults
    });
  }

  /**
   * Get filtered tools for subagent (based on allowedTools)
   * Returns tools in Anthropic format (conversion to OpenAI happens in invokeModel)
   */
  _getFilteredTools(allowedTools) {
    if (!allowedTools || allowedTools.length === 0) {
      return [];
    }

    // Filter STANDARD_TOOLS based on allowedTools list
    // Exclude Task tool (subagents cannot spawn other subagents)
    return STANDARD_TOOLS.filter(tool => {
      if (tool.name === "Task") {
        return false; // Never allow subagents to spawn subagents
      }
      return this._isToolAllowed(tool.name, allowedTools);
    });
  }

  /**
   * Check if tool is allowed (case-insensitive)
   */
  _isToolAllowed(toolName, allowedTools) {
    const normalized = toolName.toLowerCase();
    return allowedTools.some(allowed => allowed.toLowerCase() === normalized);
  }

  /**
   * Extract text from content blocks
   */
  _extractTextFromContent(content) {
    if (!Array.isArray(content)) {
      return String(content);
    }

    const textBlocks = content.filter(block => block.type === "text");
    return textBlocks.map(block => block.text).join("\n");
  }

  /**
   * Extract FINAL RESULT only (not intermediate steps)
   */
  _extractFinalResult(context) {
    if (context.result) {
      return context.result;
    }

    // Look for summary markers in last assistant message
    const reversedMessages = [...context.messages].reverse();
    const lastMessage = reversedMessages.find(m => m.role === "assistant");

    if (lastMessage && lastMessage.content) {
      const text = this._extractTextFromContent(lastMessage.content);

      // Look for summary markers
      const markers = [
        "EXPLORATION COMPLETE:",
        "IMPLEMENTATION PLAN:",
        "TASK COMPLETE:",
        "SUMMARY:",
        "FINDINGS:"
      ];

      for (const marker of markers) {
        const index = text.indexOf(marker);
        if (index !== -1) {
          return text.substring(index);
        }
      }

      return text;
    }

    return "Subagent completed with no result";
  }

  /**
   * Resolve model name to full model identifier
   */
  _resolveModel(modelName) {
    const modelMap = {
      "haiku": "claude-3-haiku-20240307",
      "sonnet": "claude-3-5-sonnet-20241022",
      "opus": "claude-3-opus-20240229",
      "gpt-4o-mini": "gpt-4o-mini",
      "gpt-4o": "gpt-4o"
    };

    return modelMap[modelName] || modelName;
  }

  /**
   * Learn from execution (async, non-blocking)
   * Uses Reflector to extract patterns and updates skillbook
   */
  async _learnFromExecution(context, successful) {
    try {
      // Use Reflector to extract sophisticated patterns
      const patterns = Reflector.reflect(context, successful);

      if (patterns.length === 0) {
        return; // Nothing to learn
      }

      // Load skillbook for this agent type
      const skillbook = await Skillbook.load(context.agentName);

      // Add each learned pattern
      for (const pattern of patterns) {
        skillbook.addSkill(pattern);
      }

      // Save skillbook (persists learning)
      await skillbook.save();

      logger.info({
        agentType: context.agentName,
        patternsLearned: patterns.length,
        totalSkills: skillbook.skills.size,
        successful
      }, "Agent learned from execution");

    } catch (error) {
      // Don't throw - learning failures shouldn't break execution
      logger.warn({
        agentType: context.agentName,
        error: error.message
      }, "Learning failed");
    }
  }

}

module.exports = SubagentExecutor;
