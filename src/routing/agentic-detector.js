/**
 * Agentic Workflow Detector
 * Detects multi-step tool chains and autonomous agent patterns
 * Used to boost complexity tier for agentic workloads
 */

const logger = require('../logger');

// Agent type classification with tier requirements
const AGENT_TYPES = {
  SINGLE_SHOT: {
    minTier: 'SIMPLE',
    scoreBoost: 0,
    description: 'Simple request-response, no tool chains',
  },
  TOOL_CHAIN: {
    minTier: 'MEDIUM',
    scoreBoost: 15,
    requiresToolUse: true,
    description: 'Sequential tool usage (read -> edit -> test)',
  },
  ITERATIVE: {
    minTier: 'COMPLEX',
    scoreBoost: 25,
    requiresToolUse: true,
    description: 'Retry loops, debugging cycles, iterative refinement',
  },
  AUTONOMOUS: {
    minTier: 'REASONING',
    scoreBoost: 35,
    requiresToolUse: true,
    description: 'Open-ended tasks, full autonomy, complex decision making',
  },
};

// Detection patterns
const PATTERNS = {
  // Tool chain indicators
  toolChain: /\b(then\s+use|after\s+that|next\s+step|finally|first.*then|step\s*\d+)\b/i,

  // Iterative work indicators
  iterative: /\b(keep\s+trying|until|repeat|loop|retry|iterate|fix.*again|try.*different|debug)\b/i,

  // Autonomous work indicators
  autonomous: /\b(figure\s+out|solve|complete\s+the\s+task|do\s+whatever|make\s+it\s+work|find\s+a\s+way|whatever\s+it\s+takes)\b/i,

  // Multi-file work
  multiFile: /\b(multiple\s+files?|across\s+(the\s+)?codebase|all\s+files?|refactor\s+entire|whole\s+project|everywhere)\b/i,

  // Planning indicators
  planning: /\b(plan|design|architect|strategy|roadmap|approach|how\s+would\s+you)\b/i,

  // Implementation indicators
  implementation: /\b(implement|build|create|develop|write|code|add\s+feature)\b/i,

  // Analysis indicators
  analysis: /\b(analyze|investigate|understand|explain|why\s+is|what\s+causes|root\s+cause)\b/i,

  // Testing indicators
  testing: /\b(test|verify|validate|check|ensure|confirm|make\s+sure)\b/i,
};

// High-complexity tools that indicate agentic work
const AGENTIC_TOOLS = new Set([
  // Execution tools
  'Bash', 'bash', 'shell', 'execute', 'run_command',
  // Write tools
  'Write', 'write_file', 'fs_write', 'create_file',
  // Edit tools
  'Edit', 'edit_file', 'fs_edit', 'edit_patch', 'str_replace_editor',
  // Agent tools
  'Task', 'agent_task', 'spawn_agent', 'delegate',
  // Git tools
  'Git', 'git_commit', 'git_push', 'git_create_branch',
  // Test tools
  'Test', 'run_tests', 'pytest', 'jest',
  // Notebook tools
  'NotebookEdit', 'notebook_edit',
]);

// Read-only tools (lower complexity)
const READ_ONLY_TOOLS = new Set([
  'Read', 'read_file', 'fs_read',
  'Glob', 'glob', 'find_files',
  'Grep', 'grep', 'search', 'ripgrep',
  'WebFetch', 'web_fetch', 'fetch_url',
  'WebSearch', 'web_search',
]);

class AgenticDetector {
  /**
   * Detect agentic workflow patterns
   * @param {Object} payload - Request payload with messages and tools
   * @returns {Object} Detection result
   */
  detect(payload) {
    const messages = payload?.messages || [];
    const tools = payload?.tools || [];
    const content = this._extractContent(messages);

    let score = 0;
    const signals = [];

    // Signal 1: Tool count (many tools = likely multi-step)
    const toolCount = tools.length;
    if (toolCount > 10) {
      score += 25;
      signals.push({ signal: 'very_high_tool_count', value: toolCount, weight: 25 });
    } else if (toolCount > 5) {
      score += 15;
      signals.push({ signal: 'high_tool_count', value: toolCount, weight: 15 });
    } else if (toolCount > 3) {
      score += 8;
      signals.push({ signal: 'moderate_tool_count', value: toolCount, weight: 8 });
    }

    // Signal 2: Agentic tools present (Bash, Write, Edit, Task)
    const agenticToolCount = tools.filter(t => {
      const name = t.name || t.function?.name || '';
      return AGENTIC_TOOLS.has(name);
    }).length;

    if (agenticToolCount > 3) {
      score += 25;
      signals.push({ signal: 'many_agentic_tools', value: agenticToolCount, weight: 25 });
    } else if (agenticToolCount > 1) {
      score += 15;
      signals.push({ signal: 'has_agentic_tools', value: agenticToolCount, weight: 15 });
    } else if (agenticToolCount === 1) {
      score += 8;
      signals.push({ signal: 'single_agentic_tool', value: agenticToolCount, weight: 8 });
    }

    // Signal 3: Prior tool results (already in agentic loop)
    const toolResultCount = this._countToolResults(messages);
    if (toolResultCount > 5) {
      score += 30;
      signals.push({ signal: 'deep_tool_loop', value: toolResultCount, weight: 30 });
    } else if (toolResultCount > 2) {
      score += 20;
      signals.push({ signal: 'active_tool_loop', value: toolResultCount, weight: 20 });
    } else if (toolResultCount > 0) {
      score += 10;
      signals.push({ signal: 'has_tool_results', value: toolResultCount, weight: 10 });
    }

    // Signal 4: Pattern matching on content
    if (PATTERNS.autonomous.test(content)) {
      score += 25;
      signals.push({ signal: 'autonomous_pattern', weight: 25 });
    }

    if (PATTERNS.iterative.test(content)) {
      score += 20;
      signals.push({ signal: 'iterative_pattern', weight: 20 });
    }

    if (PATTERNS.toolChain.test(content)) {
      score += 15;
      signals.push({ signal: 'tool_chain_pattern', weight: 15 });
    }

    if (PATTERNS.multiFile.test(content)) {
      score += 15;
      signals.push({ signal: 'multi_file_work', weight: 15 });
    }

    if (PATTERNS.planning.test(content)) {
      score += 10;
      signals.push({ signal: 'planning_required', weight: 10 });
    }

    if (PATTERNS.implementation.test(content) && PATTERNS.testing.test(content)) {
      score += 15;
      signals.push({ signal: 'implementation_with_testing', weight: 15 });
    }

    // Signal 5: Conversation depth
    const messageCount = messages.length;
    if (messageCount > 15) {
      score += 20;
      signals.push({ signal: 'very_deep_conversation', value: messageCount, weight: 20 });
    } else if (messageCount > 8) {
      score += 12;
      signals.push({ signal: 'deep_conversation', value: messageCount, weight: 12 });
    } else if (messageCount > 4) {
      score += 6;
      signals.push({ signal: 'ongoing_conversation', value: messageCount, weight: 6 });
    }

    // Signal 6: Content length (longer prompts often = more complex tasks)
    if (content.length > 2000) {
      score += 10;
      signals.push({ signal: 'long_prompt', value: content.length, weight: 10 });
    }

    // Determine agent type
    const agentType = this._classifyAgentType(score, signals);
    const isAgentic = score >= 25;

    const result = {
      isAgentic,
      agentType,
      confidence: Math.min(score / 100, 1),
      score,
      signals,
      minTier: AGENT_TYPES[agentType].minTier,
      scoreBoost: AGENT_TYPES[agentType].scoreBoost,
      description: AGENT_TYPES[agentType].description,
    };

    if (isAgentic) {
      logger.debug({
        agentType,
        score,
        signalCount: signals.length,
        toolCount,
        toolResultCount,
      }, '[AgenticDetector] Agentic workflow detected');
    }

    return result;
  }

  /**
   * Classify agent type based on score and signals
   */
  _classifyAgentType(score, signals) {
    // Check for specific signal combinations
    const hasAutonomousPattern = signals.some(s => s.signal === 'autonomous_pattern');
    const hasDeepToolLoop = signals.some(s => s.signal === 'deep_tool_loop');
    const hasManyAgenticTools = signals.some(s => s.signal === 'many_agentic_tools');

    // Autonomous: high score + autonomous pattern or very deep tool usage
    if (score >= 60 || (hasAutonomousPattern && score >= 40)) {
      return 'AUTONOMOUS';
    }

    // Iterative: moderate-high score with tool loops
    if (score >= 40 || (hasDeepToolLoop && score >= 30)) {
      return 'ITERATIVE';
    }

    // Tool chain: some tool usage indicated
    if (score >= 20 || hasManyAgenticTools) {
      return 'TOOL_CHAIN';
    }

    return 'SINGLE_SHOT';
  }

  /**
   * Extract user content from messages
   */
  _extractContent(messages) {
    const userMsgs = messages.filter(m => m?.role === 'user');
    if (userMsgs.length === 0) return '';

    // Get last user message
    const last = userMsgs[userMsgs.length - 1];

    if (typeof last.content === 'string') {
      return last.content;
    }

    if (Array.isArray(last.content)) {
      return last.content
        .filter(block => block?.type === 'text')
        .map(block => block.text || '')
        .join(' ');
    }

    return '';
  }

  /**
   * Count tool results in conversation
   */
  _countToolResults(messages) {
    let count = 0;

    for (const msg of messages) {
      if (msg?.role === 'user' && Array.isArray(msg.content)) {
        count += msg.content.filter(c => c?.type === 'tool_result').length;
      }
    }

    return count;
  }

  /**
   * Get detection stats for debugging
   */
  getPatternStats(content) {
    const stats = {};
    for (const [name, pattern] of Object.entries(PATTERNS)) {
      stats[name] = pattern.test(content);
    }
    return stats;
  }
}

// Singleton instance
let instance = null;

function getAgenticDetector() {
  if (!instance) {
    instance = new AgenticDetector();
  }
  return instance;
}

module.exports = {
  AgenticDetector,
  getAgenticDetector,
  AGENT_TYPES,
  PATTERNS,
  AGENTIC_TOOLS,
  READ_ONLY_TOOLS,
};
