/**
 * Graphify Integration — Knowledge Graph for Code Intelligence
 *
 * Communicates with Graphify's CLI to provide blast radius analysis,
 * god node detection, community cohesion, surprise scoring, and
 * structural complexity signals for intelligent routing decisions.
 *
 * Workspace resolution order (per-request):
 *   1. Explicit workspace passed by caller (e.g. from X-Lynkr-Workspace header)
 *   2. Auto-detected from absolute file paths in the conversation messages
 *   3. CODE_GRAPH_WORKSPACE env var
 *   4. process.cwd() (last resort)
 *
 * Graphify: https://github.com/safishamsi/graphify
 *
 * @module tools/code-graph
 */

const path = require("path");
const { execFile } = require("child_process");
const config = require("../config");
const logger = require("../logger");

// ============================================================================
// CACHE
// ============================================================================

/** @type {Map<string, { data: any, ts: number }>} */
const resultCache = new Map();
const CACHE_TTL_MS = 30_000; // 30 seconds

/**
 * Retrieve a cached value or null if expired / missing.
 * @param {string} key
 * @returns {any|null}
 */
function cacheGet(key) {
  const entry = resultCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL_MS) {
    resultCache.delete(key);
    return null;
  }
  return entry.data;
}

/**
 * Store a value in the cache.
 * @param {string} key
 * @param {any} data
 */
function cacheSet(key, data) {
  resultCache.set(key, { data, ts: Date.now() });

  // Prevent unbounded growth — evict oldest entries beyond 200
  if (resultCache.size > 200) {
    const oldest = resultCache.keys().next().value;
    resultCache.delete(oldest);
  }
}

// ============================================================================
// FAILURE SUPPRESSION
// ============================================================================

/** Timestamp of the last logged warning (0 = never) */
let lastWarningTs = 0;
const WARNING_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Log a warning at most once per cooldown period.
 * @param {string} msg
 * @param {Object} [meta]
 */
function warnOnce(msg, meta = {}) {
  const now = Date.now();
  if (now - lastWarningTs < WARNING_COOLDOWN_MS) return;
  lastWarningTs = now;
  logger.warn(meta, `[graphify] ${msg}`);
}

// ============================================================================
// WORKSPACE DETECTION
// ============================================================================

/**
 * Detect the workspace root from a list of absolute file paths by finding
 * their longest common directory prefix.
 *
 * Example:
 *   ["/Users/bob/app/src/a.js", "/Users/bob/app/src/b.js", "/Users/bob/app/test/c.js"]
 *   → "/Users/bob/app"
 *
 * Returns null if no absolute paths are provided or they share no common root.
 *
 * @param {string[]} filePaths
 * @returns {string|null}
 */
function detectWorkspaceFromPaths(filePaths) {
  // Only consider absolute paths
  const absolute = filePaths.filter((p) => path.isAbsolute(p));
  if (absolute.length === 0) return null;

  // Split each path into segments
  const segmented = absolute.map((p) => p.split(path.sep).filter(Boolean));

  // Find common prefix segments
  const first = segmented[0];
  let commonLength = first.length;

  for (let i = 1; i < segmented.length; i++) {
    const other = segmented[i];
    let j = 0;
    while (j < commonLength && j < other.length && first[j] === other[j]) {
      j++;
    }
    commonLength = j;
  }

  if (commonLength === 0) return null;

  // Reconstruct the common path — must be a directory, not a file
  let common = path.sep + first.slice(0, commonLength).join(path.sep);

  // If the common path looks like a file (has extension), go up one level
  if (path.extname(common)) {
    common = path.dirname(common);
  }

  // Don't return root or home-level paths — too broad to be useful
  const depth = common.split(path.sep).filter(Boolean).length;
  if (depth < 2) return null;

  return common;
}

// ============================================================================
// CONFIGURATION HELPERS
// ============================================================================

/**
 * Return resolved code-graph configuration from config module.
 * @returns {{ enabled: boolean, command: string, defaultWorkspace: string, timeout: number }}
 */
function getConfig() {
  const cfg = config.codeGraph || {};
  return {
    enabled: cfg.enabled === true,
    command: cfg.command || "graphify",
    defaultWorkspace: cfg.workspace || process.cwd(),
    timeout: cfg.timeout || 5000,
  };
}

/**
 * Resolve the workspace for a given request.
 *
 * Priority:
 *   1. Explicit workspace (from header or caller)
 *   2. Auto-detected from file paths
 *   3. CODE_GRAPH_WORKSPACE env var
 *   4. process.cwd()
 *
 * @param {Object} [options]
 * @param {string} [options.workspace] - Explicit workspace from caller/header
 * @param {string[]} [options.filePaths] - File paths from the conversation
 * @returns {string}
 */
function resolveWorkspace(options = {}) {
  // 1. Explicit workspace
  if (options.workspace && typeof options.workspace === "string") {
    return options.workspace;
  }

  // 2. Auto-detect from file paths
  if (Array.isArray(options.filePaths) && options.filePaths.length > 0) {
    const detected = detectWorkspaceFromPaths(options.filePaths);
    if (detected) {
      logger.debug({ workspace: detected }, "[graphify] auto-detected workspace from file paths");
      return detected;
    }
  }

  // 3/4. Static config or cwd
  return getConfig().defaultWorkspace;
}

// ============================================================================
// COMMAND EXECUTION
// ============================================================================

/**
 * Execute a Graphify CLI command and parse JSON output.
 *
 * Graphify CLI: `graphify query --workspace <path> <query>`
 * or:           `graphify --workspace <path>` (builds graph + reports)
 *
 * @param {string} subcommand  — e.g. "query", "benchmark", or null for build
 * @param {string[]} [args]    — additional CLI arguments
 * @param {string} [workspace] — resolved workspace path
 * @returns {Promise<Object|null>} Parsed JSON or null on failure
 */
function execGraph(subcommand, args = [], workspace = null) {
  const cfg = getConfig();
  if (!cfg.enabled) return Promise.resolve(null);

  const ws = workspace || cfg.defaultWorkspace;
  const parts = cfg.command.split(/\s+/);
  const bin = parts[0];
  const baseArgs = parts.slice(1);

  const fullArgs = [
    ...baseArgs,
    ...(subcommand ? [subcommand] : []),
    "--workspace",
    ws,
    ...args,
  ];

  return new Promise((resolve) => {
    execFile(
      bin,
      fullArgs,
      { timeout: cfg.timeout, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          warnOnce(`command failed: ${subcommand || 'build'}`, {
            err: err.message,
            stderr: (stderr || "").slice(0, 200),
          });
          return resolve(null);
        }
        try {
          const data = JSON.parse(stdout);
          return resolve(data);
        } catch (parseErr) {
          // Graphify may output non-JSON for build commands — try reading report
          warnOnce(`failed to parse JSON for: ${subcommand || 'build'}`, {
            err: parseErr.message,
          });
          return resolve(null);
        }
      }
    );
  });
}

// ============================================================================
// AVAILABILITY CHECK
// ============================================================================

/** Cached availability result per workspace */
const availabilityCache = new Map(); // workspace → { value, ts }
const AVAILABILITY_TTL_MS = 60_000; // 1 minute

/**
 * Check whether Graphify is configured and responsive.
 * Result is cached per workspace for 60 seconds.
 *
 * @param {Object} [options]
 * @param {string} [options.workspace] - Explicit workspace
 * @param {string[]} [options.filePaths] - File paths for auto-detection
 * @returns {Promise<boolean>}
 */
async function isAvailable(options = {}) {
  const cfg = getConfig();
  if (!cfg.enabled) return false;

  const ws = resolveWorkspace(options);
  const now = Date.now();
  const cached = availabilityCache.get(ws);
  if (cached && cached.value !== null && now - cached.ts < AVAILABILITY_TTL_MS) {
    return cached.value;
  }

  const result = await execGraph("query", ["graph_stats"], ws);
  const available = result !== null;
  availabilityCache.set(ws, { value: available, ts: now });

  if (available) {
    logger.debug({ workspace: ws }, "[graphify] available");
  }

  return available;
}

// ============================================================================
// PUBLIC API
// ============================================================================

/**
 * @typedef {Object} CodeGraphOptions
 * @property {string} [workspace] - Explicit workspace path (e.g. from X-Lynkr-Workspace header)
 * @property {string[]} [filePaths] - File paths from conversation (used for auto-detection)
 */

/**
 * Get blast radius for a set of file paths.
 *
 * Uses Graphify's `query get_neighbors` on each file to find affected nodes,
 * then aggregates into blast radius metrics.
 *
 * @param {string[]} filePaths — list of file paths to analyze
 * @param {CodeGraphOptions} [options]
 * @returns {Promise<{ affected_files: number, affected_functions: number, affected_tests: number, dependency_depth: number, risk_score: number }|null>}
 */
async function getBlastRadius(filePaths, options = {}) {
  if (!Array.isArray(filePaths) || filePaths.length === 0) return null;

  const ws = resolveWorkspace({ ...options, filePaths });
  const cacheKey = `blast:${ws}:${filePaths.sort().join(",")}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  // Query neighbors for each file to estimate blast radius
  const result = await execGraph(
    "query",
    ["get_neighbors", "--files", ...filePaths, "--depth", "2", "--json"],
    ws
  );
  if (!result) return null;

  // Normalize Graphify output into our standard blast radius format
  const nodes = result.nodes || result.neighbors || [];
  const affectedFiles = new Set();
  const affectedFunctions = [];
  const affectedTests = [];
  let maxDepth = 0;

  for (const node of nodes) {
    const src = node.source_file || node.source || "";
    if (src) affectedFiles.add(src);
    const label = (node.label || node.id || "").toLowerCase();
    if (label.includes("test") || src.includes("test")) {
      affectedTests.push(node);
    } else {
      affectedFunctions.push(node);
    }
    if (node.depth && node.depth > maxDepth) maxDepth = node.depth;
  }

  // Risk score: based on affected count and depth
  const riskScore = Math.min(100,
    affectedFiles.size * 3 +
    affectedFunctions.length * 2 +
    maxDepth * 5
  );

  const normalized = {
    affected_files: affectedFiles.size,
    affected_functions: affectedFunctions.length,
    affected_tests: affectedTests.length,
    dependency_depth: maxDepth,
    risk_score: riskScore,
  };

  cacheSet(cacheKey, normalized);
  return normalized;
}

/**
 * Get relevant file paths that should be included as context.
 *
 * Uses Graphify's BFS-based query to find related nodes.
 *
 * @param {string[]} filePaths — seed file paths
 * @param {number} [maxFiles=20] — maximum files to return
 * @param {CodeGraphOptions} [options]
 * @returns {Promise<string[]|null>}
 */
async function getRelevantContext(filePaths, maxFiles = 20, options = {}) {
  if (!Array.isArray(filePaths) || filePaths.length === 0) return null;

  const ws = resolveWorkspace({ ...options, filePaths });
  const cacheKey = `ctx:${ws}:${filePaths.sort().join(",")}:${maxFiles}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  // Use query_graph with BFS to find related files
  const searchTerms = filePaths.map(f => path.basename(f, path.extname(f))).join(" ");
  const result = await execGraph(
    "query",
    ["query_graph", searchTerms, "--max-tokens", String(maxFiles * 100), "--json"],
    ws
  );
  if (!result) return null;

  // Extract unique source files from result nodes
  const nodes = result.nodes || result.results || [];
  const fileSet = new Set();
  for (const node of nodes) {
    const src = node.source_file || node.source || "";
    if (src) fileSet.add(src);
  }

  const files = [...fileSet].slice(0, maxFiles);
  if (files.length === 0) return null;

  cacheSet(cacheKey, files);
  return files;
}

/**
 * Get complexity signals for routing decisions.
 *
 * Queries Graphify for god nodes, community cohesion, and structural signals
 * that indicate how complex a code change is.
 *
 * @param {string[]} filePaths — list of file paths to analyze
 * @param {CodeGraphOptions} [options]
 * @returns {Promise<{ blast_radius: number, dependency_depth: number, test_coverage_pct: number, is_infrastructure: boolean, god_node_touched: boolean, community_count: number, cohesion: number }|null>}
 */
async function getComplexitySignals(filePaths, options = {}) {
  if (!Array.isArray(filePaths) || filePaths.length === 0) return null;

  const ws = resolveWorkspace({ ...options, filePaths });
  const cacheKey = `complexity:${ws}:${filePaths.sort().join(",")}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  // Run parallel queries: neighbors (blast radius) + god_nodes + graph_stats
  const [neighborsResult, godNodesResult, statsResult] = await Promise.all([
    execGraph("query", ["get_neighbors", "--files", ...filePaths, "--depth", "2", "--json"], ws),
    execGraph("query", ["god_nodes", "--json"], ws),
    execGraph("query", ["graph_stats", "--json"], ws),
  ]);

  // If all queries failed (tool not available), return null
  if (!neighborsResult && !godNodesResult && !statsResult) return null;

  // Compute blast radius from neighbors
  let blastRadius = 0;
  let depthMax = 0;
  const affectedFiles = new Set();
  if (neighborsResult) {
    const nodes = neighborsResult.nodes || neighborsResult.neighbors || [];
    for (const node of nodes) {
      if (node.source_file) affectedFiles.add(node.source_file);
      if (node.depth && node.depth > depthMax) depthMax = node.depth;
    }
    blastRadius = affectedFiles.size;
  }

  // Check if any touched file contains a god node
  let godNodeTouched = false;
  if (godNodesResult) {
    const godNodes = godNodesResult.god_nodes || godNodesResult.nodes || godNodesResult || [];
    const godFiles = new Set(
      (Array.isArray(godNodes) ? godNodes : []).map(n => n.source_file || n.source || "")
    );
    godNodeTouched = filePaths.some(fp => {
      const base = path.basename(fp);
      for (const gf of godFiles) {
        if (gf.includes(base) || base.includes(path.basename(gf))) return true;
      }
      return false;
    });
  }

  // Extract community/cohesion from stats
  let communityCount = 0;
  let cohesion = 1;
  if (statsResult) {
    communityCount = statsResult.communities || statsResult.community_count || 0;
    cohesion = statsResult.avg_cohesion ?? statsResult.cohesion ?? 1;
  }

  // Detect infrastructure files
  const infraPatterns = [
    /docker/i, /compose/i, /makefile/i, /webpack/i, /babel/i, /eslint/i,
    /tsconfig/i, /package\.json/i, /\.github/i, /ci/i, /cd/i, /deploy/i,
    /terraform/i, /ansible/i, /k8s/i, /kubernetes/i, /helm/i,
  ];
  const isInfrastructure = filePaths.some(fp =>
    infraPatterns.some(pattern => pattern.test(fp))
  );

  // Estimate test coverage from graph — ratio of test files to affected files
  const testFiles = [...affectedFiles].filter(f => /test|spec|__test/i.test(f));
  const testCoveragePct = affectedFiles.size > 0
    ? Math.round((testFiles.length / affectedFiles.size) * 100)
    : 100; // Assume covered if we can't tell

  const normalized = {
    blast_radius: blastRadius,
    dependency_depth: depthMax,
    test_coverage_pct: testCoveragePct,
    is_infrastructure: isInfrastructure,
    god_node_touched: godNodeTouched,
    community_count: communityCount,
    cohesion,
  };

  cacheSet(cacheKey, normalized);
  return normalized;
}

/**
 * Get overall graph statistics.
 *
 * @param {CodeGraphOptions} [options]
 * @returns {Promise<{ total_files: number, total_functions: number, total_edges: number, languages: string[], communities: number, god_nodes: string[] }|null>}
 */
async function getGraphStats(options = {}) {
  const ws = resolveWorkspace(options);
  const cacheKey = `stats:${ws}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const result = await execGraph("query", ["graph_stats", "--json"], ws);
  if (!result) return null;

  const normalized = {
    total_files: result.total_files ?? result.files ?? 0,
    total_functions: result.total_functions ?? result.nodes ?? 0,
    total_edges: result.total_edges ?? result.edges ?? 0,
    languages: Array.isArray(result.languages) ? result.languages : [],
    communities: result.communities ?? result.community_count ?? 0,
    god_nodes: Array.isArray(result.god_nodes) ? result.god_nodes.map(n => n.label || n.id || n) : [],
  };

  cacheSet(cacheKey, normalized);
  return normalized;
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  isAvailable,
  getBlastRadius,
  getRelevantContext,
  getComplexitySignals,
  getGraphStats,
  resolveWorkspace,
  detectWorkspaceFromPaths,
};
