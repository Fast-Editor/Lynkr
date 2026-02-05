/**
 * Lazy Tool Loader
 *
 * Loads tool categories on-demand based on prompt content analysis.
 * Reduces startup time and memory by only loading tools when needed.
 *
 * @module tools/lazy-loader
 */

const logger = require('../logger');

// Track which tool categories have been loaded
const loadedCategories = new Set();

// Core tools that are always loaded at startup
const CORE_CATEGORIES = ['stubs', 'workspace', 'execution'];

// Tool categories with their registration functions and keyword triggers
const TOOL_CATEGORIES = {
  stubs: {
    keywords: [],  // Always loaded
    loader: () => require('./stubs').registerStubTools,
    priority: 0,
  },
  workspace: {
    keywords: ['file', 'read', 'write', 'edit', 'create', 'delete', 'list', 'directory', 'folder', 'path'],
    loader: () => require('./workspace').registerWorkspaceTools,
    priority: 0,
  },
  execution: {
    keywords: ['run', 'execute', 'shell', 'bash', 'command', 'terminal', 'npm', 'node', 'python', 'script'],
    loader: () => require('./execution').registerExecutionTools,
    priority: 0,
  },
  web: {
    keywords: ['web', 'search', 'fetch', 'url', 'http', 'https', 'api', 'request', 'internet', 'online', 'browse', 'website'],
    loader: () => require('./web').registerWebTools,
    priority: 1,
  },
  indexer: {
    keywords: ['index', 'search', 'find', 'symbol', 'reference', 'grep', 'scan', 'codebase'],
    loader: () => require('./indexer').registerIndexerTools,
    priority: 1,
  },
  edits: {
    keywords: ['edit', 'patch', 'modify', 'change', 'update', 'replace', 'refactor'],
    loader: () => require('./edits').registerEditTools,
    priority: 1,
  },
  git: {
    keywords: ['git', 'commit', 'push', 'pull', 'branch', 'merge', 'rebase', 'stash', 'checkout', 'clone', 'diff', 'status', 'log', 'remote', 'fetch', 'pr', 'pull request'],
    loader: () => require('./git').registerGitTools,
    priority: 2,
  },
  tasks: {
    keywords: ['task', 'todo', 'subtask', 'agent', 'spawn', 'background'],
    loader: () => require('./tasks').registerTaskTools,
    priority: 2,
  },
  tests: {
    keywords: ['test', 'jest', 'mocha', 'pytest', 'unittest', 'spec', 'coverage', 'assert'],
    loader: () => require('./tests').registerTestTools,
    priority: 2,
  },
  mcp: {
    keywords: ['mcp', 'server', 'sandbox', 'container', 'docker'],
    loader: () => require('./mcp').registerMcpTools,
    priority: 3,
  },
  agentTask: {
    keywords: ['agent', 'subagent', 'spawn', 'delegate', 'parallel'],
    loader: () => require('./agent-task').registerAgentTaskTool,
    priority: 2,
  },
};

/**
 * Load a specific tool category
 * @param {string} category - Category name
 * @returns {boolean} - True if loaded, false if already loaded or failed
 */
function loadCategory(category) {
  if (loadedCategories.has(category)) {
    return false;
  }

  const config = TOOL_CATEGORIES[category];
  if (!config) {
    logger.warn({ category }, '[LazyLoader] Unknown tool category');
    return false;
  }

  try {
    const registerFn = config.loader();
    if (typeof registerFn === 'function') {
      registerFn();
    }
    loadedCategories.add(category);
    logger.debug({ category }, '[LazyLoader] Tool category loaded');
    return true;
  } catch (err) {
    logger.error({ category, error: err.message }, '[LazyLoader] Failed to load tool category');
    return false;
  }
}

/**
 * Load core tools (called at startup)
 */
function loadCoreTools() {
  const startTime = Date.now();

  for (const category of CORE_CATEGORIES) {
    loadCategory(category);
  }

  logger.info({
    loadedCategories: Array.from(loadedCategories),
    duration: Date.now() - startTime,
  }, '[LazyLoader] Core tools loaded');
}

/**
 * Load all tools (for backwards compatibility or when lazy loading is disabled)
 */
function loadAllTools() {
  const startTime = Date.now();

  for (const category of Object.keys(TOOL_CATEGORIES)) {
    loadCategory(category);
  }

  logger.info({
    loadedCategories: Array.from(loadedCategories),
    duration: Date.now() - startTime,
  }, '[LazyLoader] All tools loaded');
}

/**
 * Analyze prompt content and determine which tool categories are needed
 * @param {string|Array} content - Prompt content (string or messages array)
 * @returns {string[]} - List of category names that should be loaded
 */
function analyzePromptForTools(content) {
  // Extract text from various input formats
  let text = '';

  if (typeof content === 'string') {
    text = content.toLowerCase();
  } else if (Array.isArray(content)) {
    // Extract from messages array
    text = content
      .map(msg => {
        if (typeof msg.content === 'string') {
          return msg.content;
        }
        if (Array.isArray(msg.content)) {
          return msg.content
            .filter(part => part.type === 'text' || part.type === 'input_text')
            .map(part => part.text || part.input_text || '')
            .join(' ');
        }
        return '';
      })
      .join(' ')
      .toLowerCase();
  }

  if (!text) return [];

  const neededCategories = new Set();

  // Check each category's keywords
  for (const [category, config] of Object.entries(TOOL_CATEGORIES)) {
    // Skip already loaded categories
    if (loadedCategories.has(category)) continue;

    // Check if any keyword matches
    for (const keyword of config.keywords) {
      if (text.includes(keyword.toLowerCase())) {
        neededCategories.add(category);
        break;
      }
    }
  }

  // Sort by priority (lower = load first)
  return Array.from(neededCategories).sort((a, b) => {
    return (TOOL_CATEGORIES[a]?.priority ?? 99) - (TOOL_CATEGORIES[b]?.priority ?? 99);
  });
}

/**
 * Ensure tools needed for a prompt are loaded
 * @param {string|Array} content - Prompt content
 * @returns {{ loaded: string[], alreadyLoaded: string[] }}
 */
function ensureToolsForPrompt(content) {
  const neededCategories = analyzePromptForTools(content);
  const loaded = [];
  const alreadyLoaded = [];

  for (const category of neededCategories) {
    if (loadedCategories.has(category)) {
      alreadyLoaded.push(category);
    } else if (loadCategory(category)) {
      loaded.push(category);
    }
  }

  if (loaded.length > 0) {
    logger.info({ loaded, triggered: content?.substring?.(0, 100) }, '[LazyLoader] Loaded tools for prompt');
  }

  return { loaded, alreadyLoaded };
}

/**
 * Load a tool category by tool name (called when a tool is requested but not found)
 * @param {string} toolName - Name of the tool being requested
 * @returns {boolean} - True if a category was loaded
 */
function loadCategoryForTool(toolName) {
  if (!toolName) return false;

  const lowerName = toolName.toLowerCase();

  // Map tool names to categories
  const toolToCategory = {
    // Git tools
    'workspace_git_status': 'git',
    'workspace_git_stage': 'git',
    'workspace_git_unstage': 'git',
    'workspace_git_commit': 'git',
    'workspace_git_push': 'git',
    'workspace_git_pull': 'git',
    'workspace_git_branches': 'git',
    'workspace_git_checkout': 'git',
    'workspace_git_stash': 'git',
    'workspace_git_merge': 'git',
    'workspace_git_rebase': 'git',
    'workspace_git_conflicts': 'git',
    'workspace_diff': 'git',
    'workspace_diff_review': 'git',
    'workspace_diff_summary': 'git',
    'workspace_diff_by_commit': 'git',
    'workspace_release_notes': 'git',
    'workspace_changelog_generate': 'git',
    'workspace_pr_template_generate': 'git',
    'workspace_git_patch_plan': 'git',

    // Web tools
    'web_search': 'web',
    'web_fetch': 'web',

    // Indexer tools
    'workspace_search': 'indexer',
    'workspace_symbol_search': 'indexer',
    'workspace_symbol_references': 'indexer',
    'workspace_index_rebuild': 'indexer',

    // Edit tools
    'edit_patch': 'edits',

    // Task tools
    'task_create': 'tasks',
    'task_update': 'tasks',
    'task_list': 'tasks',

    // Test tools
    'workspace_test_run': 'tests',
    'workspace_test_summary': 'tests',
    'workspace_test_history': 'tests',

    // MCP tools
    'workspace_sandbox_sessions': 'mcp',
    'workspace_mcp_servers': 'mcp',

    // Agent task
    'agent_task': 'agentTask',
  };

  // Direct mapping
  const category = toolToCategory[lowerName];
  if (category && !loadedCategories.has(category)) {
    return loadCategory(category);
  }

  // Fuzzy matching by prefix
  for (const [toolPattern, cat] of Object.entries(toolToCategory)) {
    if (lowerName.startsWith(toolPattern.split('_')[0]) && !loadedCategories.has(cat)) {
      return loadCategory(cat);
    }
  }

  return false;
}

/**
 * Get statistics about loaded tools
 */
function getLoaderStats() {
  const allCategories = Object.keys(TOOL_CATEGORIES);
  return {
    loaded: Array.from(loadedCategories),
    notLoaded: allCategories.filter(c => !loadedCategories.has(c)),
    totalCategories: allCategories.length,
    loadedCount: loadedCategories.size,
  };
}

/**
 * Check if a category is loaded
 * @param {string} category
 * @returns {boolean}
 */
function isCategoryLoaded(category) {
  return loadedCategories.has(category);
}

/**
 * Reset loader state (for testing)
 */
function resetLoader() {
  loadedCategories.clear();
}

module.exports = {
  loadCoreTools,
  loadAllTools,
  loadCategory,
  loadCategoryForTool,
  analyzePromptForTools,
  ensureToolsForPrompt,
  getLoaderStats,
  isCategoryLoaded,
  resetLoader,
  TOOL_CATEGORIES,
  CORE_CATEGORIES,
};
