/**
 * Smart Tool Selection — Conservative Stripping
 *
 * Strategy: instead of predicting which tools ARE needed (brittle regex),
 * only strip groups we are CERTAIN are irrelevant based on clear absence
 * of intent signals.
 *
 * Rules:
 *   1. Greeting → strip everything
 *   2. No write intent → strip Write / Edit / NotebookEdit
 *   3. No execution intent → strip Bash / KillShell
 *   4. No web intent → strip WebSearch / WebFetch
 *
 * File ops (Read, Grep, Glob) are NEVER stripped — they are the most
 * broadly useful and the most commonly needed unexpectedly.
 */

const logger = require('../logger');

const SYSTEM_REMINDER_PATTERN = /<system-reminder>[\s\S]*?<\/system-reminder>/g;

// Clear greeting — strip all tools
const GREETING_PATTERN = /^(hi|hello|hey|good morning|good afternoon|good evening|howdy|greetings|sup|yo)[\s\.\!\?]*$/i;
const TECHNICAL_KEYWORDS = /code|function|class|file|module|import|export|async|await|promise|api|database|server|component|variable|array|object|\.[a-z]{1,5}\b|npm|git|docker|python|node|bash|run|install/i;

// Intent signals — absence means we strip that group
const WRITE_INTENT   = /write|create\b|add to|update|modify|change|fix|delete|remove|insert|append|replace|save|edit|refactor|rename|move|reorganize|rewrite|implement|generate|produce|scaffold/i;
const EXECUTE_INTENT = /run|execute|test|compile|build|deploy|start|install|launch|boot|npm|yarn|pnpm|git|python|node|docker|bash|sh\b|cmd|script|make|cargo|go run/i;
const WEB_INTENT     = /search online|search the web|search google|look up online|browse|website|https?:\/\//i;

// Tools always kept (file search is never useless)
const ALWAYS_KEEP = new Set([
  'Read', 'Grep', 'Glob',
  'Task', 'TaskOutput', 'TodoWrite', 'TodoRead',
  'AskUserQuestion', 'Skill',
  'EnterPlanMode', 'ExitPlanMode',
]);

// Conditional strips: group → intent pattern that must be present to keep it
const CONDITIONAL_GROUPS = [
  { names: ['Write', 'Edit', 'NotebookEdit'],  intent: WRITE_INTENT   },
  { names: ['Bash', 'KillShell'],              intent: EXECUTE_INTENT },
  { names: ['WebSearch', 'WebFetch'],          intent: WEB_INTENT     },
];

// Legacy map kept for telemetry label compatibility
const TOOL_SELECTION_MAP = {
  conversational:    [],
  simple_qa:         [],
  file_reading:      ['Read', 'Grep', 'Glob'],
  file_modification: ['Read', 'Write', 'Edit', 'Grep', 'Glob', 'Bash'],
  code_execution:    ['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob'],
  coding:            ['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob'],
  research:          ['Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch'],
  complex_task:      ['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob', 'WebSearch', 'WebFetch', 'Task', 'TodoWrite', 'AskUserQuestion'],
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getLastUserContent(payload) {
  if (!Array.isArray(payload.messages)) return '';
  for (let i = payload.messages.length - 1; i >= 0; i--) {
    const msg = payload.messages[i];
    if (msg?.role !== 'user') continue;
    let text = '';
    if (typeof msg.content === 'string') {
      text = msg.content;
    } else if (Array.isArray(msg.content)) {
      text = msg.content.filter(b => b?.type === 'text').map(b => b.text || '').join(' ');
    }
    return text.replace(SYSTEM_REMINDER_PATTERN, '').trim();
  }
  return '';
}

function isGreeting(content) {
  const t = content.trim();
  return GREETING_PATTERN.test(t) || (t.length < 20 && !TECHNICAL_KEYWORDS.test(t));
}

// ─── Classifier (conservative) ───────────────────────────────────────────────

/**
 * Classify request and compute which tool groups to strip.
 * Returns a classification object for logging/telemetry compatibility.
 */
function classifyRequestType(payload) {
  const content = getLastUserContent(payload);
  const lower   = content.toLowerCase();
  const msgCount = payload.messages?.length ?? 0;

  // Greeting → strip everything
  if (isGreeting(lower)) {
    return { type: 'conversational', confidence: 1.0, keywords: ['greeting'], _stripped: ['Write', 'Edit', 'NotebookEdit', 'Bash', 'KillShell', 'WebSearch', 'WebFetch'] };
  }

  const stripped = [];
  for (const { names, intent } of CONDITIONAL_GROUPS) {
    if (!intent.test(lower)) stripped.push(...names);
  }

  // Derive a label for telemetry
  const hasWrite = WRITE_INTENT.test(lower);
  const hasExec  = EXECUTE_INTENT.test(lower);
  const hasWeb   = WEB_INTENT.test(lower);

  const type = hasWrite || hasExec ? 'file_modification'
    : hasWeb   ? 'research'
    : msgCount > 10 ? 'complex_task'
    : 'file_reading';

  return { type, confidence: 0.9, keywords: ['conservative'], _stripped: stripped };
}

// ─── Tool filter ─────────────────────────────────────────────────────────────

function estimateToolTokens(tools) {
  if (!Array.isArray(tools)) return 0;
  return tools.length * 175;
}

/**
 * Apply conservative stripping to the tool list.
 */
function recordStrippingSavings(before, after) {
  if (after >= before) return;
  try {
    const telemetry = require('../routing/telemetry');
    telemetry.recordSavings('tool_stripping', (before - after) * 175);
  } catch { /* telemetry is best-effort */ }
}

function selectToolsSmartly(tools, classification, options = {}) {
  if (!Array.isArray(tools) || tools.length === 0) return tools;

  const { provider = 'databricks' } = options;
  const strippedNames = new Set(classification._stripped ?? []);

  // Greeting: strip everything
  if (classification.type === 'conversational') {
    recordStrippingSavings(tools.length, 0);
    return [];
  }

  // Strip only the flagged groups; always keep ALWAYS_KEEP tools
  let selected = tools.filter(tool => {
    const name = String(tool.name || '');
    if (ALWAYS_KEEP.has(name)) return true;
    return !strippedNames.has(name);
  });

  // Safety: if we somehow stripped everything, return full list
  if (selected.length === 0) return tools;

  // Code Mode meta-tools always included
  const codeConfig = require('../config');
  if (codeConfig.mcp?.codeMode?.enabled) {
    const codeModeNames = new Set(['mcp_list_tools', 'mcp_tool_info', 'mcp_tool_docs', 'mcp_execute']);
    for (const tool of tools) {
      if (codeModeNames.has(tool.name) && !selected.some(t => t.name === tool.name)) {
        selected.push(tool);
      }
    }
  }

  // Ollama has a smaller context — cap at 10 tools
  if (provider === 'ollama' && selected.length > 10) {
    selected = selected.slice(0, 10);
  }

  recordStrippingSavings(tools.length, selected.length);
  return selected;
}

module.exports = {
  classifyRequestType,
  selectToolsSmartly,
  estimateToolTokens,
  TOOL_SELECTION_MAP,
};
