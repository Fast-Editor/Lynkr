const logger = require("../logger");
const { truncateToolOutput } = require("./truncate");

const registry = new Map();
const registryLowercase = new Map();

// Lazy loader reference (set after module load to avoid circular deps)
let lazyLoader = null;

/**
 * Set the lazy loader module (called from server.js)
 * @param {Object} loader - The lazy-loader module
 */
function setLazyLoader(loader) {
  lazyLoader = loader;
}

const TOOL_ALIASES = {
  bash: "shell",
  shell: "shell",
  sh: "shell",
  terminal: "shell",
  grep: "workspace_search",
  search: "workspace_search",
  find: "workspace_search",
  websearch: "web_search",
  web_search: "web_search",
  "Web Search": "web_search",
  WebSearch: "web_search",
  web_fetch: "web_fetch",
  webfetch: "web_fetch",
  task: "fs_write",
  write: "fs_write",
  filewrite: "fs_write",
  read: "fs_read",
  fileread: "fs_read",
  patch: "edit_patch",
  edit: "edit_patch",
  list: "workspace_list",
  ls: "workspace_list",
  dir: "workspace_list",
  summary: "project_summary",
  projectsummary: "project_summary",
  overview: "project_summary",
  reindex: "workspace_index_rebuild",
  index: "workspace_index_rebuild",
  scan: "workspace_index_rebuild",
  history: "workspace_edit_history",
  edits: "workspace_edit_history",
  undo: "workspace_edit_revert",
  revert: "workspace_edit_revert",
  diff: "workspace_diff",
  diffsummary: "workspace_diff_summary",
  summarizediff: "workspace_diff_summary",
  diffsum: "workspace_diff_summary",
  symbol: "workspace_symbol_search",
  symbols: "workspace_symbol_search",
  findsymbol: "workspace_symbol_search",
  symbolsearch: "workspace_symbol_search",
  references: "workspace_symbol_references",
  ref: "workspace_symbol_references",
  findreferences: "workspace_symbol_references",
  usages: "workspace_symbol_references",
  status: "workspace_git_status",
  stage: "workspace_git_stage",
  unstage: "workspace_git_unstage",
  commit: "workspace_git_commit",
  push: "workspace_git_push",
  pull: "workspace_git_pull",
  branches: "workspace_git_branches",
  checkout: "workspace_git_checkout",
  branch: "workspace_git_checkout",
  stash: "workspace_git_stash",
  review: "workspace_diff_review",
  releasenotes: "workspace_release_notes",
  diffstat: "workspace_diff_by_commit",
  merge: "workspace_git_merge",
  rebase: "workspace_git_rebase",
  conflicts: "workspace_git_conflicts",
  patchplan: "workspace_git_patch_plan",
  changelog: "workspace_changelog_generate",
  prtemplate: "workspace_pr_template_generate",
  sandbox: "workspace_sandbox_sessions",
  mcpsessions: "workspace_sandbox_sessions",
  mcpservers: "workspace_mcp_servers",
  tests: "workspace_test_summary",
  testrun: "workspace_test_run",
  runtests: "workspace_test_run",
  testsummary: "workspace_test_summary",
  testhistory: "workspace_test_history",
  // Glob has dedicated tool in src/tools/indexer.js (registerGlobTool)
  // - returns plain text format instead of JSON
  // glob: "workspace_list",
  // Glob: "workspace_list",
};

/**
 * Recursively parse string values that look like JSON arrays/objects.
 * Some providers double-serialize nested parameters (e.g. questions: "[{...}]"
 * instead of questions: [{...}]), which causes schema validation failures.
 */
function deepParseStringifiedJson(obj) {
  if (typeof obj !== "object" || obj === null) return obj;
  if (Array.isArray(obj)) return obj.map(deepParseStringifiedJson);

  const result = {};
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (
        (trimmed.startsWith("[") && trimmed.endsWith("]")) ||
        (trimmed.startsWith("{") && trimmed.endsWith("}"))
      ) {
        try {
          result[key] = deepParseStringifiedJson(JSON.parse(trimmed));
          continue;
        } catch {
          // Not valid JSON, keep as string
        }
      }
    }
    result[key] =
      typeof value === "object" ? deepParseStringifiedJson(value) : value;
  }
  return result;
}

function coerceString(value) {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function normalizeHandlerResult(result) {
  if (typeof result === "string") {
    return {
      ok: true,
      status: 200,
      content: result,
      metadata: {},
    };
  }
  if (result === undefined || result === null) {
    return {
      ok: true,
      status: 200,
      content: "",
      metadata: {},
    };
  }
  const ok = result.ok ?? true;
  const status = result.status ?? (ok ? 200 : 500);
  const content = coerceString(result.content ?? result.output ?? result.data ?? "");
  const metadata = result.metadata ?? {};
  return { ok, status, content, metadata };
}

function parseArguments(call, providerType = null) {
  const raw = call?.function?.arguments;

  // DEBUG: Log full call structure for diagnosis
  logger.info({
    providerType,
    fullCall: JSON.stringify(call),
    hasFunction: !!call?.function,
    functionKeys: call?.function ? Object.keys(call.function) : [],
    argumentsType: typeof raw,
    argumentsValue: raw,
    argumentsIsNull: raw === null,
    argumentsIsUndefined: raw === undefined,
  }, "=== PARSING TOOL ARGUMENTS ===");

  // Ollama sends arguments as an object, OpenAI as a JSON string
  if (typeof raw === "object" && raw !== null) {
    if (providerType !== "ollama") {
      logger.warn({
        providerType,
        expectedProvider: "ollama",
        argumentsType: typeof raw,
        arguments: raw
      }, `Received object arguments but provider is ${providerType || "unknown"}, expected ollama format. Continuing with object.`);
    } else {
      logger.info({
        type: "object",
        arguments: raw
      }, "Tool arguments already parsed (Ollama format)");
    }
    return deepParseStringifiedJson(raw);
  }

  if (typeof raw !== "string" || raw.trim().length === 0) {
    logger.warn({
      argumentsType: typeof raw,
      argumentsEmpty: !raw || raw.trim().length === 0,
      providerType
    }, "Arguments not a string or empty - returning {}");
    return {};
  }

  try {
    const parsed = JSON.parse(raw);
    logger.info({ parsed }, "Parsed JSON string arguments");
    return deepParseStringifiedJson(parsed);
  } catch (err) {
    logger.warn({ err, raw }, "Failed to parse tool arguments");
    return {};
  }
}

function normaliseToolCall(call, providerType = null) {
  const name = call?.function?.name ?? call?.name;
  const id = call?.id ?? `${name ?? "tool"}_${Date.now()}`;
  return {
    id,
    name,
    arguments: parseArguments(call, providerType),
    raw: call,
  };
}

function registerTool(name, handler, options = {}) {
  if (!name || typeof name !== "string") {
    throw new Error("Tool name must be a non-empty string.");
  }
  if (typeof handler !== "function") {
    throw new Error(`Tool "${name}" must be registered with a function handler.`);
  }
  registry.set(name, { handler, options });
  registryLowercase.set(name.toLowerCase(), { handler, options, original: name });
  logger.debug({ tool: name }, "Tool registered");
}

function hasTool(name) {
  return registry.has(name);
}

function getTool(name) {
  logger.debug({ tool: name }, "Getting tool");
  if (!name) return undefined;
  const direct = registry.get(name);
  if (direct) return direct;
  const lower = registryLowercase.get(name.toLowerCase());
  if (lower) return registry.get(lower.original);
  const aliasTarget = TOOL_ALIASES[name.toLowerCase()];
  if (aliasTarget) {
    const aliasEntry = registry.get(aliasTarget);
    if (aliasEntry) return aliasEntry;
  }
  return undefined;
}

function listTools() {
  return Array.from(registry.keys());
}

async function executeToolCall(call, context = {}) {
  const providerType = context?.providerType || context?.provider || null;  
  const normalisedCall = normaliseToolCall(call, providerType);
  let registered = registry.get(normalisedCall.name);
  if (!registered) {
    const aliasTarget = TOOL_ALIASES[normalisedCall.name.toLowerCase()];
    if (aliasTarget) {
      registered = registry.get(aliasTarget);
      if (registered) {
        normalisedCall.name = aliasTarget;
      }
    }
  }
  if (!registered) {
    const lowerEntry = registryLowercase.get(normalisedCall.name.toLowerCase());
    if (lowerEntry) {
      registered = registry.get(lowerEntry.original);
      normalisedCall.name = lowerEntry.original;
    }
  }

  // Lazy loading: If tool not found, try to load its category
  if (!registered && lazyLoader) {
    const loaded = lazyLoader.loadCategoryForTool(normalisedCall.name);
    if (loaded) {
      // Retry lookup after loading
      registered = registry.get(normalisedCall.name);
      if (!registered) {
        const aliasTarget = TOOL_ALIASES[normalisedCall.name.toLowerCase()];
        if (aliasTarget) {
          registered = registry.get(aliasTarget);
          if (registered) normalisedCall.name = aliasTarget;
        }
      }
      if (!registered) {
        const lowerEntry = registryLowercase.get(normalisedCall.name.toLowerCase());
        if (lowerEntry) {
          registered = registry.get(lowerEntry.original);
          normalisedCall.name = lowerEntry.original;
        }
      }
    }
  }

  if (!registered) {
    logger.warn({
      tool: normalisedCall.name,
      id: normalisedCall.id
    }, "Tool not registered");
    const content = coerceString({
      error: "tool_not_registered",
      tool: normalisedCall.name,
      input: normalisedCall.arguments,
    });
    return {
      id: normalisedCall.id,
      name: normalisedCall.name,
      arguments: normalisedCall.arguments,
      ok: false,
      status: 404,
      content,
      metadata: { registered: false },
    };
  }

  // Log tool invocation with full details for debugging
  logger.info({
    tool: normalisedCall.name,
    id: normalisedCall.id,
    args: normalisedCall.arguments,
    argsKeys: Object.keys(normalisedCall.arguments || {}),
    rawCall: JSON.stringify(normalisedCall.raw)
  }, "=== EXECUTING TOOL ===");

  startTime = Date.now()

  try {
    const result = await registered.handler(
      {
        id: normalisedCall.id,
        name: normalisedCall.name,
        args: normalisedCall.arguments,
        raw: normalisedCall.raw,
      },
      context,
    );
    const formatted = normalizeHandlerResult(result);

    // Apply tool output truncation for token efficiency
    const truncatedContent = truncateToolOutput(normalisedCall.name, formatted.content);

    const durationMs = Date.now() - startTime;

    // Log successful execution
    logger.info({
      tool: normalisedCall.name,
      id: normalisedCall.id,
      status: formatted.status,
      durationMs,
      outputLength: truncatedContent?.length || 0,
      truncated: truncatedContent !== formatted.content
    }, "Tool execution completed");

    return {
      id: normalisedCall.id,
      name: normalisedCall.name,
      arguments: normalisedCall.arguments,
      ...formatted,
      content: truncatedContent,
      metadata: {
        ...(formatted.metadata ?? {}),
        registered: true,
        truncated: truncatedContent !== formatted.content,
        originalLength: formatted.content?.length,
        truncatedLength: truncatedContent?.length,
        durationMs
      },
    };
  } catch (err) {
    const durationMs = Date.now() - startTime;

    logger.error({
      err,
      tool: normalisedCall.name,
      id: normalisedCall.id,
      durationMs
    }, "Tool execution failed");

    return {
      id: normalisedCall.id,
      name: normalisedCall.name,
      arguments: normalisedCall.arguments,
      ok: false,
      status: 500,
      content: coerceString({
        error: "tool_execution_failed",
        tool: normalisedCall.name,
        message: err.message,
      }),
      metadata: {
        registered: true,
        error: true,
        durationMs
      },
      error: err,
    };
  }
}

module.exports = {
  registerTool,
  hasTool,
  getTool,
  listTools,
  executeToolCall,
  setLazyLoader,
  TOOL_ALIASES,
};
