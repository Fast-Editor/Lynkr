/**
 * Smart Tool Selection Module
 *
 * Intelligently selects relevant tools based on request type classification.
 * Reduces tool token overhead by 50-70% for non-coding queries.
 *
 * @module tools/smart-selection
 */

const logger = require('../logger');

// Strip system-reminder blocks injected by the CLI before classification
const SYSTEM_REMINDER_PATTERN = /<system-reminder>[\s\S]*?<\/system-reminder>/g;

// Pre-compiled regex patterns for performance (avoid recompiling on every request)
const GREETING_PATTERN = /^(hi|hello|hey|good morning|good afternoon|good evening|howdy|greetings|sup|yo)[\s\.\!\?]*$/i;
const QUESTION_PATTERN = /^(what is|what's|how does|when|where|why|define|tell me about|can you explain)/i;
const TECHNICAL_KEYWORDS = /code|function|class|file|module|import|export|async|await|promise|callback|api|database|server|client|component|method|variable|array|object|string|number/i;
const EXPLANATION_PATTERN = /explain|describe|summarize|what does|how does|tell me about|give me an overview|clarify|elaborate/i;
const WEB_PATTERN = /search|lookup|find info|google|documentation|docs|website|url|link|online|internet|browse/i;
const READ_PATTERN = /\bread\b|show|display|view|\bcat\b|\bcheck\b|inspect|look at|see|examine|review|print|output|\blist\b/i;
const WRITE_PATTERN = /write|create|add|update|modify|change|fix|delete|remove|insert|append|replace|save|put|make|generate|produce|copy/i;
const EDIT_PATTERN = /edit|refactor|rename|move|reorganize|restructure|rewrite/i;
const EXECUTION_PATTERN = /\brun\b|execute|\btest\b|compile|build|deploy|\bstart\b|install|launch|boot|fire up|npm|npx|yarn|pnpm|pip|git|python|node|docker|bash|\bsh\b|\bcmd\b|\bls\b|\bpwd\b|\bcd\b|grep|curl|wget|\bmake\b|\bbd\b/i;
const COMPLEX_PATTERN = /implement|build|create|develop|design|architect|plan|strategy|approach|help with|work on|improve|optimize|enhance|refactor|migrate/i;

// Catches short shell/tool commands that should not be classified as conversational
const COMMAND_PATTERN = /^\s*(ls|cd|pwd|cat|git|npm|npx|yarn|pnpm|pip|bd|run|edit|read|write|grep|find|curl|wget|make|docker|bash|sh|node|python|test|check|install|create|delete|remove|rename|move|copy|open|save|build|compile|deploy|start|stop|kill)\b/i;

/**
 * Tool selection map: request type → relevant tools
 */
const TOOL_SELECTION_MAP = {
  conversational: [],  // No tools needed for greetings
  simple_qa: [],       // No tools needed for simple questions

  research: [
    'Read', 'Grep', 'Glob',           // File search
    'WebSearch', 'WebFetch'           // Web research
  ],

  file_reading: [
    'Read', 'Grep', 'Glob'            // Read-only tools
  ],

  file_modification: [
    'Read', 'Write', 'Edit', 'edit_patch',  // Full I/O
    'Grep', 'Glob', 'Bash',                 // Support tools
    'NotebookEdit'
  ],

  code_execution: [
    'Read', 'Write', 'Edit', 'edit_patch',  // File operations
    'Bash', 'Grep', 'Glob'                  // Execution + search
  ],

  coding: [
    'Read', 'Write', 'Edit', 'edit_patch',  // Core file ops
    'Bash', 'Grep', 'Glob'                  // Support tools
  ],

  complex_task: [
    'Read', 'Write', 'Edit', 'edit_patch',            // Tier 1
    'Bash', 'Grep', 'Glob',                           // Tier 1
    'WebSearch', 'WebFetch',                          // Tier 2
    'NotebookEdit',                                    // Tier 2
    'Task', 'TodoWrite', 'AskUserQuestion'            // Tier 3+4
  ]
};

/**
 * Extract content from last user message
 */
function getLastUserMessage(payload) {
  if (!Array.isArray(payload.messages) || payload.messages.length === 0) {
    return null;
  }

  // Find last user message
  for (let i = payload.messages.length - 1; i >= 0; i--) {
    const msg = payload.messages[i];
    if (msg?.role === 'user') {
      return msg;
    }
  }

  return null;
}

/**
 * Extract text content from message (handles string or array format)
 */
function extractContent(message) {
  if (!message) return '';

  if (typeof message.content === 'string') {
    return message.content;
  }

  if (Array.isArray(message.content)) {
    return message.content
      .filter(block => block?.type === 'text')
      .map(block => block.text || '')
      .join(' ');
  }

  return '';
}

/**
 * Check if content matches greeting patterns
 */
function isGreeting(content) {
  return GREETING_PATTERN.test(content.trim());
}

/**
 * Check if content is short and non-technical
 */
function isShortNonTechnical(content) {
  const trimmed = content.trim();
  return trimmed.length < 20
    && !TECHNICAL_KEYWORDS.test(trimmed)
    && !COMMAND_PATTERN.test(trimmed);
}

/**
 * Check if content is a simple question
 */
function isSimpleQuestion(content) {
  return QUESTION_PATTERN.test(content.trim()) && !COMMAND_PATTERN.test(content.trim());
}

/**
 * Check for technical keywords
 */
function hasTechnicalKeywords(content) {
  return TECHNICAL_KEYWORDS.test(content);
}

/**
 * Check for explanation/research keywords
 */
function hasExplanationKeywords(content) {
  return EXPLANATION_PATTERN.test(content);
}

/**
 * Check for web/search keywords
 */
function hasWebKeywords(content) {
  return WEB_PATTERN.test(content);
}

/**
 * Check for file reading keywords
 */
function hasReadKeywords(content) {
  return READ_PATTERN.test(content);
}

/**
 * Check for file writing/modification keywords
 */
function hasWriteKeywords(content) {
  return WRITE_PATTERN.test(content);
}

/**
 * Check for edit/refactor keywords
 */
function hasEditKeywords(content) {
  return EDIT_PATTERN.test(content);
}

/**
 * Check for execution/testing keywords
 */
function hasExecutionKeywords(content) {
  return EXECUTION_PATTERN.test(content);
}

/**
 * Check for complex task keywords
 */
function hasComplexKeywords(content) {
  return COMPLEX_PATTERN.test(content);
}

/**
 * Classify request type based on content analysis
 *
 * @param {Object} payload - Request payload with messages
 * @returns {Object} Classification result { type, confidence, keywords }
 */
function classifyRequestType(payload) {
  const lastMessage = getLastUserMessage(payload);

  if (!lastMessage) {
    return { type: 'coding', confidence: 0.5, keywords: [] };
  }

  const rawContent = extractContent(lastMessage);
  // Strip <system-reminder> blocks before classification to prevent
  // CLI-injected keywords (search, explain, documentation) from polluting results
  const content = rawContent.replace(SYSTEM_REMINDER_PATTERN, '').trim();
  const contentLower = content.toLowerCase();
  const messageCount = payload.messages?.length ?? 0;

  // 1. Conversational — exact greeting match (no tools)
  if (isGreeting(contentLower)) {
    return { type: 'conversational', confidence: 1.0, keywords: ['greeting'] };
  }

  // 2. Research/Explanation (minimal tools) — before simple_qa so "explain X" → research
  if (hasExplanationKeywords(contentLower)) {
    return { type: 'research', confidence: 0.85, keywords: ['explanation'] };
  }

  if (hasWebKeywords(contentLower)) {
    return { type: 'research', confidence: 0.9, keywords: ['web', 'search'] };
  }

  // 3. Simple Q&A (no tools) — after explanation so "explain X" isn't caught here
  if (isSimpleQuestion(contentLower) && !hasTechnicalKeywords(contentLower)) {
    return { type: 'simple_qa', confidence: 0.9, keywords: ['question', 'non-technical'] };
  }

  // 4. Execution/Testing (execution tools) — before read/write
  //    because commands like "check git status" contain both read and exec keywords
  if (hasExecutionKeywords(contentLower)) {
    return { type: 'code_execution', confidence: 0.8, keywords: ['execution'] };
  }

  // 5. File reading (read-only tools)
  if (hasReadKeywords(contentLower) && !hasWriteKeywords(contentLower)) {
    return { type: 'file_reading', confidence: 0.8, keywords: ['read'] };
  }

  // 6. File modification (full I/O tools)
  if (hasWriteKeywords(contentLower) || hasEditKeywords(contentLower)) {
    return { type: 'file_modification', confidence: 0.85, keywords: ['write', 'edit'] };
  }

  // 7. Complex task (all tools)
  if (hasComplexKeywords(contentLower)) {
    return { type: 'complex_task', confidence: 0.75, keywords: ['complex'] };
  }

  // 8. Short non-technical fallback — only after all keyword checks have had a chance
  if (isShortNonTechnical(contentLower)) {
    return { type: 'conversational', confidence: 0.8, keywords: ['short', 'non-technical'] };
  }

  // Long conversations likely need more tools
  if (messageCount > 10) {
    return { type: 'complex_task', confidence: 0.7, keywords: ['long_conversation'] };
  }

  // Default: coding (core tools)
  return { type: 'coding', confidence: 0.6, keywords: ['default'] };
}

/**
 * Estimate token count for tools (rough approximation)
 */
function estimateToolTokens(tools) {
  if (!Array.isArray(tools)) return 0;

  // Average: ~175 tokens per tool (based on STANDARD_TOOLS analysis)
  return tools.length * 175;
}

/**
 * Select relevant tools based on classification
 *
 * @param {Array} tools - Available tools
 * @param {Object} classification - Classification result from classifyRequestType
 * @param {Object} options - Selection options (provider, tokenBudget, config)
 * @returns {Array} Filtered list of relevant tools
 */
function selectToolsSmartly(tools, classification, options = {}) {
  if (!Array.isArray(tools) || tools.length === 0) {
    return tools;
  }

  const { provider = 'databricks', tokenBudget = 2500, config = {} } = options;
  const requestType = classification.type || 'coding';

  // Get relevant tool names for this request type
  const relevantToolNames = TOOL_SELECTION_MAP[requestType] || TOOL_SELECTION_MAP.coding;

  // Filter to relevant tools only
  let selectedTools = tools.filter(tool => relevantToolNames.includes(tool.name));

  // Mode-specific adjustments
  if (config.mode === 'aggressive') {
    // Aggressive: Further reduce tools for ambiguous cases
    if (classification.confidence < 0.7 && selectedTools.length > 4) {
      selectedTools = selectedTools.slice(0, 4);
    }
  } else if (config.mode === 'conservative') {
    // Conservative: Include one extra tier of tools for safety
    if (requestType === 'file_reading' && !relevantToolNames.includes('Bash')) {
      const bashTool = tools.find(t => t.name === 'Bash');
      if (bashTool) selectedTools.push(bashTool);
    }
  }

  // Provider-specific limits
  if (provider === 'ollama' && selectedTools.length > 8) {
    selectedTools = selectedTools.slice(0, 8);
  }

  // Token budget enforcement
  const estimatedTokens = estimateToolTokens(selectedTools);
  if (estimatedTokens > tokenBudget) {
    const targetCount = Math.floor(tokenBudget / 175);
    selectedTools = selectedTools.slice(0, Math.max(targetCount, 0));
  }

  // Minimal mode override (if configured)
  if (config.minimalMode) {
    const minimalTools = ['Read', 'Write', 'Edit', 'Bash'];
    selectedTools = selectedTools.filter(t => minimalTools.includes(t.name));
  }

  return selectedTools;
}

module.exports = {
  classifyRequestType,
  selectToolsSmartly,
  estimateToolTokens,
  TOOL_SELECTION_MAP
};
