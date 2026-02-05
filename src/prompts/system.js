/**
 * Dynamic System Prompt Optimization
 *  * Provides utilities for optimizing system prompts and tool descriptions
 * to reduce token usage while maintaining functionality.
 *
 */

const logger = require('../logger');
const config = require('../config');

/**
 * Agent Delegation Instructions
 *
 * These instructions tell all models how to use the Task tool for spawning subagents.
 * Added to system prompt when Task tool is available.
 */
const AGENT_DELEGATION_INSTRUCTIONS = `
## Task Delegation (Subagents)

You have access to the **Task** tool which spawns specialized agents to handle complex work autonomously.

### WHEN TO USE the Task Tool:

| User Request Keywords | Action |
|----------------------|--------|
| "explore", "dig into", "understand", "analyze" the codebase | \`Task(subagent_type="Explore")\` |
| "plan", "design", "architect" an implementation | \`Task(subagent_type="Plan")\` |
| Complex multi-file research or investigation | \`Task(subagent_type="general-purpose")\` |

### HOW TO CALL the Task Tool:

\`\`\`
Task(
  subagent_type: "Explore",
  description: "Explore project structure",
  prompt: "Find main entry points, understand the architecture, read key configuration files, and provide a comprehensive summary of what this project does and how it's organized."
)
\`\`\`

### AGENT TYPES:

- **Explore**: Fast codebase exploration using Glob, Grep, Read tools. Use for searching files, understanding project structure, finding code patterns.
- **Plan**: Implementation planning and architecture design. Use for designing features, planning refactoring, or architectural decisions.
- **general-purpose**: Complex multi-step tasks with access to all tools.

### IMPORTANT:
- Subagents run independently and return a summary of their findings
- Use Explore agent for ANY codebase navigation or search tasks instead of doing it yourself
- The subagent will handle all the file reading and searching, then return results to you
`;

/**
 * Compress tool descriptions to minimal format
 *
 * Converts verbose tool schemas to minimal versions by:
 * - Shortening descriptions
 * - Removing optional fields when not critical
 * - Using concise parameter descriptions
 *
 * @param {Array} tools - Array of Anthropic-format tool definitions
 * @param {string} mode - 'minimal' or 'full' (default: from config)
 * @returns {Array} Optimized tool definitions
 */
function compressToolDescriptions(tools, mode = null) {
  if (!tools || tools.length === 0) return tools;

  mode = mode || config.systemPrompt?.toolDescriptions || 'minimal';

  if (mode !== 'minimal') {
    return tools; // Return unmodified if not in minimal mode
  }

  return tools.map(tool => {
    const compressed = {
      name: tool.name,
      input_schema: {
        type: tool.input_schema.type,
        properties: {},
        required: tool.input_schema.required || [],
      }
    };

    // Add minimal description only if it exists
    if (tool.description) {
      compressed.description = compressText(tool.description, 50);
    }

    // Compress property descriptions
    if (tool.input_schema.properties) {
      for (const [key, value] of Object.entries(tool.input_schema.properties)) {
        compressed.input_schema.properties[key] = {
          type: value.type,
        };

        // Only include description if it's critical
        if (value.description && !isObviousFromName(key)) {
          compressed.input_schema.properties[key].description = compressText(value.description, 30);
        }

        // Preserve enum, format, and other critical constraints
        if (value.enum) compressed.input_schema.properties[key].enum = value.enum;
        if (value.format) compressed.input_schema.properties[key].format = value.format;
        if (value.items) compressed.input_schema.properties[key].items = value.items;
        if (value.additionalProperties !== undefined) {
          compressed.input_schema.properties[key].additionalProperties = value.additionalProperties;
        }
      }
    }

    // Preserve additionalProperties if set
    if (tool.input_schema.additionalProperties !== undefined) {
      compressed.input_schema.additionalProperties = tool.input_schema.additionalProperties;
    }

    return compressed;
  });
}

/**
 * Compress text to maximum length while preserving meaning
 * @param {string} text - Text to compress
 * @param {number} maxLength - Maximum length
 * @returns {string} Compressed text
 */
function compressText(text, maxLength) {
  if (!text || text.length <= maxLength) return text;

  // Try to cut at sentence/word boundary
  let cut = text.substring(0, maxLength);
  const lastPeriod = cut.lastIndexOf('.');
  const lastSpace = cut.lastIndexOf(' ');

  if (lastPeriod > maxLength * 0.7) {
    return cut.substring(0, lastPeriod + 1);
  } else if (lastSpace > maxLength * 0.8) {
    return cut.substring(0, lastSpace);
  }

  return cut;
}

/**
 * Check if property name is self-explanatory
 * @param {string} name - Property name
 * @returns {boolean} True if name is obvious
 */
function isObviousFromName(name) {
  const obvious = [
    'id', 'name', 'type', 'value', 'data', 'text', 'content',
    'message', 'query', 'command', 'url', 'path', 'file', 'filename',
    'email', 'username', 'password', 'token', 'key', 'timeout',
    'limit', 'offset', 'page', 'size', 'count', 'total', 'status'
  ];
  return obvious.includes(name.toLowerCase());
}

/**
 * Optimize system prompt based on context
 *
 * Analyzes the system prompt and removes or compresses sections
 * that aren't relevant to the current context.
 *
 * @param {string|Array} system - System prompt (string or content blocks)
 * @param {Object} context - Context information
 * @param {Array} context.tools - Tools available in this request
 * @param {Array} context.messages - Recent messages
 * @param {string} mode - 'dynamic' or 'full' (default: from config)
 * @returns {string|Array} Optimized system prompt
 */
function optimizeSystemPrompt(system, context = {}, mode = null) {
  if (!system) return system;

  mode = mode || config.systemPrompt?.mode || 'dynamic';

  if (mode !== 'dynamic') {
    return system; // Return unmodified if not in dynamic mode
  }

  // Convert to string if array of blocks
  let text = typeof system === 'string' ? system : flattenBlocks(system);

  const optimizations = [];
  const originalLength = text.length;

  // 1. Remove verbose tool usage examples if no tools present
  if (!context.tools || context.tools.length === 0) {
    text = removeSection(text, /# Tool Usage Examples?[\s\S]*?(?=\n#|\n\n[A-Z]|$)/gi, optimizations, 'tool examples');
    text = removeSection(text, /<tool_usage>[\s\S]*?<\/tool_usage>/gi, optimizations, 'tool usage blocks');
  }

  // 2. Remove file operation guidelines if no file tools
  const hasFileTools = context.tools?.some(t =>
    ['Read', 'Write', 'Edit', 'Glob', 'Grep'].includes(t.name)
  );
  if (!hasFileTools) {
    text = removeSection(text, /# File Operations?[\s\S]*?(?=\n#|\n\n[A-Z]|$)/gi, optimizations, 'file operations');
  }

  // 3. Remove git guidelines if no git tools
  const hasGitTools = context.tools?.some(t =>
    t.name.toLowerCase().includes('git')
  );
  if (!hasGitTools) {
    text = removeSection(text, /# Git.*?[\s\S]*?(?=\n#|\n\n[A-Z]|$)/gi, optimizations, 'git guidelines');
    text = removeSection(text, /## Committing changes[\s\S]*?(?=\n#|\n\n[A-Z]|$)/gi, optimizations, 'git commit guidelines');
  }

  // 4. Remove web search guidelines if no web tools
  const hasWebTools = context.tools?.some(t =>
    ['WebSearch', 'WebFetch'].includes(t.name)
  );
  if (!hasWebTools) {
    text = removeSection(text, /# Web.*?[\s\S]*?(?=\n#|\n\n[A-Z]|$)/gi, optimizations, 'web guidelines');
  }

  // 5. Compress code review guidelines if no recent code edits
  const hasRecentEdits = context.messages?.some(m =>
    typeof m.content === 'string' && m.content.toLowerCase().includes('edit')
  );
  if (!hasRecentEdits) {
    text = removeSection(text, /# Code Review[\s\S]*?(?=\n#|\n\n[A-Z]|$)/gi, optimizations, 'code review');
  }

  // 6. Remove verbose examples and keep only essential instructions
  text = text.replace(/(<example>[\s\S]*?<\/example>\s*){3,}/g, (match) => {
    // Keep first two examples, remove rest
    const examples = match.match(/<example>[\s\S]*?<\/example>/g) || [];
    optimizations.push('excessive examples');
    return examples.slice(0, 2).join('\n\n');
  });

  // 7. Compress whitespace
  text = text.replace(/\n{4,}/g, '\n\n\n'); // Max 2 blank lines
  text = text.replace(/[ \t]+\n/g, '\n'); // Remove trailing spaces

  const finalLength = text.length;
  const saved = originalLength - finalLength;

  if (saved > 100 && optimizations.length > 0) {
    logger.debug({
      originalLength,
      finalLength,
      saved,
      percentage: ((saved / originalLength) * 100).toFixed(1),
      optimizations: [...new Set(optimizations)]
    }, 'System prompt optimization applied');
  }

  // Return in original format (string or blocks)
  return typeof system === 'string' ? text : text;
}

/**
 * Remove a section from text using regex
 * @param {string} text - Text to modify
 * @param {RegExp} pattern - Pattern to match
 * @param {Array} optimizations - Array to track optimizations
 * @param {string} label - Label for this optimization
 * @returns {string} Modified text
 */
function removeSection(text, pattern, optimizations, label) {
  const matches = text.match(pattern);
  if (matches && matches.length > 0) {
    optimizations.push(label);
    return text.replace(pattern, '');
  }
  return text;
}

/**
 * Flatten content blocks to text
 * @param {Array} blocks - Content blocks
 * @returns {string} Flattened text
 */
function flattenBlocks(blocks) {
  if (!Array.isArray(blocks)) return String(blocks || '');

  return blocks
    .map(block => {
      if (typeof block === 'string') return block;
      if (block.type === 'text' && block.text) return block.text;
      if (block.text) return block.text;
      return '';
    })
    .filter(Boolean)
    .join('\n\n');
}

/**
 * Analyze context to determine what optimizations are safe
 * @param {Object} context - Request context
 * @returns {Object} Analysis results
 */
function analyzeContext(context) {
  const analysis = {
    hasTools: Boolean(context.tools && context.tools.length > 0),
    toolCount: context.tools?.length || 0,
    toolNames: context.tools?.map(t => t.name) || [],
    messageCount: context.messages?.length || 0,
    hasFileOps: false,
    hasGitOps: false,
    hasWebOps: false,
    hasBashOps: false,
  };

  if (context.tools) {
    analysis.hasFileOps = context.tools.some(t =>
      ['Read', 'Write', 'Edit', 'Glob', 'Grep'].includes(t.name)
    );
    analysis.hasGitOps = context.tools.some(t =>
      t.name.toLowerCase().includes('git')
    );
    analysis.hasWebOps = context.tools.some(t =>
      ['WebSearch', 'WebFetch'].includes(t.name)
    );
    analysis.hasBashOps = context.tools.some(t =>
      ['Bash', 'BashOutput', 'KillShell'].includes(t.name)
    );
  }

  return analysis;
}

/**
 * Calculate token savings from optimizations
 * @param {string|Array} original - Original system prompt
 * @param {string|Array} optimized - Optimized system prompt
 * @returns {Object} Savings statistics
 */
function calculateSavings(original, optimized) {
  const origText = typeof original === 'string' ? original : flattenBlocks(original);
  const optText = typeof optimized === 'string' ? optimized : flattenBlocks(optimized);

  const origLength = origText.length;
  const optLength = optText.length;
  const saved = origLength - optLength;

  // Rough token estimate (4 chars ≈ 1 token)
  const tokensOriginal = Math.ceil(origLength / 4);
  const tokensOptimized = Math.ceil(optLength / 4);
  const tokensSaved = tokensOriginal - tokensOptimized;

  return {
    originalChars: origLength,
    optimizedChars: optLength,
    charsSaved: saved,
    tokensOriginal,
    tokensOptimized,
    tokensSaved,
    percentage: origLength > 0 ? ((saved / origLength) * 100).toFixed(1) : '0.0'
  };
}

/**
 * Inject agent delegation instructions into system prompt
 * @param {string} systemPrompt - Existing system prompt
 * @param {Array} tools - Available tools
 * @returns {string} System prompt with agent instructions added
 */
function injectAgentInstructions(systemPrompt, tools = []) {
  // Check if Task tool is available
  const hasTaskTool = tools?.some(t =>
    t.name === 'Task' || t.function?.name === 'Task'
  );

  if (!hasTaskTool) {
    return systemPrompt;
  }

  // Don't add if already present
  if (systemPrompt && systemPrompt.includes('Task Delegation')) {
    return systemPrompt;
  }

  // Append agent instructions
  const basePrompt = systemPrompt || '';
  return basePrompt + '\n\n' + AGENT_DELEGATION_INSTRUCTIONS;
}

module.exports = {
  compressToolDescriptions,
  optimizeSystemPrompt,
  analyzeContext,
  calculateSavings,
  compressText,
  flattenBlocks,
  injectAgentInstructions,
  AGENT_DELEGATION_INSTRUCTIONS,
};
