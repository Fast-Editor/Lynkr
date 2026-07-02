const logger = require("../logger");

/**
 * Reflector - Analyzes agent executions and extracts sophisticated patterns
 * Inspired by ACE framework's Reflector role
 */
class Reflector {
  /**
   * Reflect on execution and generate skill recommendations
   * @param {Object} context - Execution context
   * @param {boolean} successful - Whether execution succeeded
   * @returns {Array} - Array of skill objects
   */
  static reflect(context, successful) {
    const skills = [];

    // Skip trivial executions
    if (context.steps < 2) {
      return skills;
    }

    // Analyze tool usage patterns
    const toolPatterns = this._analyzeToolUsage(context);
    skills.push(...toolPatterns);

    // Analyze execution efficiency
    const efficiencyPatterns = this._analyzeEfficiency(context, successful);
    skills.push(...efficiencyPatterns);

    // Analyze error handling
    const errorPatterns = this._analyzeErrors(context, successful);
    skills.push(...errorPatterns);

    // Analyze task-specific patterns
    const taskPatterns = this._analyzeTaskPatterns(context, successful);
    skills.push(...taskPatterns);

    logger.debug({
      agentType: context.agentName,
      skillsExtracted: skills.length,
      successful
    }, "Reflection complete");

    return skills;
  }

  /**
   * Analyze tool usage patterns
   */
  static _analyzeToolUsage(context) {
    const patterns = [];
    const transcript = context.transcript || [];

    // Extract tool sequence
    const toolSequence = transcript
      .filter(entry => entry.type === "tool_call" && !entry.error)
      .map(entry => entry.toolName);

    if (toolSequence.length === 0) {
      return patterns;
    }

    // Pattern 1: Common tool combinations
    if (toolSequence.length >= 2) {
      const uniqueTools = [...new Set(toolSequence)];
      const taskType = this._inferTaskType(context.taskPrompt);

      if (taskType) {
        patterns.push({
          pattern: `${taskType} requires ${uniqueTools.length} tools`,
          action: `Use: ${uniqueTools.join(" → ")}`,
          reasoning: `Observed successful sequence for ${taskType.toLowerCase()}`,
          tools: uniqueTools,
          confidence: 0.6
        });
      }
    }

    // Pattern 2: Tool repetition (indicates iteration/refinement)
    const toolCounts = {};
    toolSequence.forEach(tool => {
      toolCounts[tool] = (toolCounts[tool] || 0) + 1;
    });

    const repeatedTools = Object.entries(toolCounts)
      .filter(([_, count]) => count > 1)
      .map(([tool, _]) => tool);

    if (repeatedTools.length > 0) {
      patterns.push({
        pattern: "Iterative refinement needed",
        action: `Multiple calls to: ${repeatedTools.join(", ")}`,
        reasoning: "Task required iterative approach",
        tools: repeatedTools,
        confidence: 0.5
      });
    }

    // Pattern 3: First tool used (often indicates primary approach)
    if (toolSequence.length > 0) {
      const firstTool = toolSequence[0];
      const taskType = this._inferTaskType(context.taskPrompt);

      if (taskType) {
        patterns.push({
          pattern: `Start ${taskType} with exploration`,
          action: `Begin with ${firstTool}`,
          reasoning: `${firstTool} is effective starting point`,
          tools: [firstTool],
          confidence: 0.55
        });
      }
    }

    return patterns;
  }

  /**
   * Analyze execution efficiency
   */
  static _analyzeEfficiency(context, successful) {
    const patterns = [];

    if (!successful) {
      return patterns; // Only analyze successful executions for efficiency
    }

    const efficiency = context.steps / context.maxSteps;

    // Pattern 1: Highly efficient (< 50% of max steps)
    if (efficiency < 0.5) {
      const toolsUsed = this._extractUniqueTools(context);

      patterns.push({
        pattern: "Efficient execution pattern",
        action: `Quick resolution in ${context.steps} steps using ${toolsUsed.join(", ")}`,
        reasoning: `Completed efficiently (${Math.round(efficiency * 100)}% of max steps)`,
        tools: toolsUsed,
        confidence: 0.75
      });
    }

    // Pattern 2: Near max steps (> 80% of max)
    if (efficiency > 0.8) {
      patterns.push({
        pattern: "Complex task requiring many steps",
        action: "Consider breaking down or optimizing approach",
        reasoning: `Used ${context.steps}/${context.maxSteps} steps - may need optimization`,
        tools: this._extractUniqueTools(context),
        confidence: 0.4
      });
    }

    // Pattern 3: Token usage efficiency
    const tokensPerStep = (context.inputTokens + context.outputTokens) / context.steps;
    if (tokensPerStep < 1000) {
      patterns.push({
        pattern: "Token-efficient approach",
        action: "Concise tool usage and responses",
        reasoning: `Low token usage per step (~${Math.round(tokensPerStep)} tokens)`,
        tools: [],
        confidence: 0.6
      });
    }

    return patterns;
  }

  /**
   * Analyze error handling patterns
   */
  static _analyzeErrors(context, successful) {
    const patterns = [];
    const transcript = context.transcript || [];

    const errorEntries = transcript.filter(entry =>
      entry.type === "tool_call" && entry.error
    );

    if (errorEntries.length === 0) {
      return patterns;
    }

    // Pattern 1: Recovered from errors
    if (successful) {
      const failedTools = errorEntries.map(e => e.toolName);
      // Tools invoked *after* the last error entry are the recovery path.
      // Use the entry's position in the transcript, not its timestamp
      // (slicing by a ~1.7e12 timestamp always yielded []).
      const lastErrorEntry = errorEntries[errorEntries.length - 1];
      const lastErrorIndex = transcript.indexOf(lastErrorEntry);
      const recoveryTools = transcript
        .slice(lastErrorIndex + 1)
        .filter(e => e.type === "tool_call" && !e.error)
        .map(e => e.toolName);

      patterns.push({
        pattern: "Error recovery strategy",
        action: `After ${failedTools[0]} fails, try ${recoveryTools[0] || "alternative approach"}`,
        reasoning: `Successfully recovered from ${errorEntries.length} error(s)`,
        tools: [...new Set([...failedTools, ...recoveryTools])],
        confidence: 0.65
      });
    }

    // Pattern 2: Failed due to errors
    if (!successful) {
      const failedTools = [...new Set(errorEntries.map(e => e.toolName))];

      patterns.push({
        pattern: `Avoid ${failedTools.join(", ")} for this task type`,
        action: "Use alternative tools",
        reasoning: `These tools failed for ${this._inferTaskType(context.taskPrompt)}`,
        tools: failedTools,
        confidence: 0.3
      });
    }

    return patterns;
  }

  /**
   * Analyze task-specific patterns
   */
  static _analyzeTaskPatterns(context, successful) {
    const patterns = [];

    if (!successful) {
      return patterns;
    }

    const taskType = this._inferTaskType(context.taskPrompt);
    if (!taskType) {
      return patterns;
    }

    const tools = this._extractUniqueTools(context);
    const steps = context.steps;

    // Build comprehensive task-specific pattern
    patterns.push({
      pattern: `${taskType} methodology`,
      action: `Use ${tools.length} tools in sequence: ${tools.slice(0, 3).join(" → ")}${tools.length > 3 ? "..." : ""}`,
      reasoning: `Proven approach for ${taskType.toLowerCase()} (${steps} steps, ${successful ? "success" : "failed"})`,
      tools: tools,
      confidence: this._calculatePatternConfidence(context, successful)
    });

    return patterns;
  }

  /**
   * Infer task type from prompt
   */
  static _inferTaskType(prompt) {
    // Guard against a missing/non-string prompt so reflection never throws
    // (a throw here previously aborted all learning silently).
    if (typeof prompt !== "string" || prompt.length === 0) {
      return null;
    }
    const lower = prompt.toLowerCase();

    const taskTypes = [
      { keywords: ["find", "search", "locate", "where"], type: "Search task" },
      { keywords: ["list", "show", "display", "enumerate"], type: "Listing task" },
      { keywords: ["explain", "understand", "analyze", "examine"], type: "Analysis task" },
      { keywords: ["fix", "repair", "debug", "solve"], type: "Fix task" },
      { keywords: ["test", "verify", "check", "validate"], type: "Testing task" },
      { keywords: ["refactor", "improve", "clean", "optimize"], type: "Refactoring task" },
      { keywords: ["implement", "create", "add", "build"], type: "Implementation task" },
      { keywords: ["document", "write", "describe"], type: "Documentation task" }
    ];

    for (const { keywords, type } of taskTypes) {
      if (keywords.some(keyword => lower.includes(keyword))) {
        return type;
      }
    }

    return null;
  }

  /**
   * Extract unique tools from context
   */
  static _extractUniqueTools(context) {
    const transcript = context.transcript || [];
    const toolsUsed = transcript
      .filter(entry => entry.type === "tool_call" && !entry.error)
      .map(entry => entry.toolName);

    return [...new Set(toolsUsed)];
  }

  /**
   * Calculate pattern confidence based on execution quality
   */
  static _calculatePatternConfidence(context, successful) {
    if (!successful) {
      return 0.25;
    }

    let confidence = 0.5;

    // Boost for efficient execution
    const efficiency = context.steps / context.maxSteps;
    if (efficiency < 0.5) {
      confidence += 0.2;
    }

    // Boost for no errors
    const errorCount = (context.transcript || [])
      .filter(e => e.type === "tool_call" && e.error).length;

    if (errorCount === 0) {
      confidence += 0.15;
    } else {
      confidence -= (errorCount * 0.05);
    }

    // Boost for comprehensive tool usage (2-5 tools)
    const toolCount = this._extractUniqueTools(context).length;
    if (toolCount >= 2 && toolCount <= 5) {
      confidence += 0.1;
    }

    return Math.max(0.2, Math.min(0.9, confidence));
  }
}

module.exports = Reflector;
