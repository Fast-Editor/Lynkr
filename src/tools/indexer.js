const {
  listWorkspaceFiles,
  searchWorkspace,
  rebuildWorkspaceIndex,
  getProjectSummary,
  searchSymbols,
  searchSymbolReferences,
  findDefinitionNearLocation,
  listDefinitionsBySymbol,
} = require("../indexer");
const { registerTool } = require(".");
const { getTaskSummary } = require("../tasks/store");
const { getTestSummary } = require("../tests");

function registerWorkspaceListTool() {
  registerTool(
    "workspace_list",
    async ({ args = {} }) => {
      // Support both 'pattern' (Glob tool) and 'patterns' (workspace_list)
      const rawPatterns = args.pattern ?? args.patterns;
      const patterns =
        typeof rawPatterns === "string"
          ? [rawPatterns]
          : Array.isArray(rawPatterns)
          ? rawPatterns
          : undefined;
      const ignore =
        typeof args.ignore === "string"
          ? [args.ignore]
          : Array.isArray(args.ignore)
          ? args.ignore
          : undefined;
      const limit = Number.isInteger(args.limit) ? args.limit : undefined;
      const withStats = args.with_stats === true || args.include_stats === true;
      const includeDirectories = args.include_directories === true;

      const entries = await listWorkspaceFiles({
        patterns,
        ignore,
        limit,
        withStats,
        includeDirectories,
      });

      return {
        ok: true,
        status: 200,
        content: JSON.stringify({ entries }, null, 2),
        metadata: {
          total: entries.length,
        },
      };
    },
    { category: "indexing" },
  );
}

function registerWorkspaceSearchTool() {
  registerTool(
    "workspace_search",
    async ({ args = {} }) => {
      const query = args.query ?? args.term ?? args.pattern;
      const regex = args.regex === true || args.is_regex === true;
      const limit = Number.isInteger(args.limit) ? args.limit : undefined;
      const ignore =
        typeof args.ignore === "string"
          ? [args.ignore]
          : Array.isArray(args.ignore)
          ? args.ignore
          : undefined;

      const result = await searchWorkspace({
        query,
        regex,
        limit,
        ignore,
      });

      return {
        ok: true,
        status: 200,
        content: JSON.stringify(result, null, 2),
        metadata: {
          total: result.matches.length,
          engine: result.engine,
        },
      };
    },
    { category: "indexing" },
  );
}

function registerWorkspaceRebuildTool() {
  registerTool(
    "workspace_index_rebuild",
    async ({ args = {} }) => {
      const patterns =
        typeof args.patterns === "string"
          ? [args.patterns]
          : Array.isArray(args.patterns)
          ? args.patterns
          : undefined;
      const ignore =
        typeof args.ignore === "string"
          ? [args.ignore]
          : Array.isArray(args.ignore)
          ? args.ignore
          : undefined;

      const summary = await rebuildWorkspaceIndex({
        patterns,
        ignore,
      });

      return {
        ok: true,
        status: 200,
        content: JSON.stringify(summary, null, 2),
        metadata: {
          fileCount: summary.fileCount,
          languages: summary.languages,
          frameworks: summary.frameworks,
        },
      };
    },
    { category: "indexing" },
  );
}

function registerProjectSummaryTool() {
  registerTool(
    "project_summary",
    async ({ args = {} }) => {
      let summary = getProjectSummary();
      if (args.rebuild === true || args.refresh === true) {
        summary = await rebuildWorkspaceIndex({});
      }

      const tasksLimitRaw =
        args.tasks_limit ?? args.tasksLimit ?? args.tasks_sample ?? args.tasksSample;
      const tasks = getTaskSummary({
        limit:
          tasksLimitRaw === undefined || tasksLimitRaw === null
            ? undefined
            : Number.isFinite(Number(tasksLimitRaw))
            ? Number(tasksLimitRaw)
            : undefined,
      });

      const tests = getTestSummary({
        includeRecent: args.tests_recent === true || args.testsRecent === true,
        recentLimit:
          args.tests_recent_limit ?? args.testsRecentLimit ?? args.tests_recent_sample ?? args.testsRecentSample,
      });

      const payload = {
        ...summary,
        tasks,
        tests,
      };

      return {
        ok: true,
        status: 200,
        content: JSON.stringify(payload, null, 2),
        metadata: {
          fileCount: summary.fileCount,
          languages: summary.languages,
          frameworks: summary.frameworks,
          tasks: tasks.total,
          tests: tests.totalRuns ?? 0,
        },
      };
    },
    { category: "indexing" },
  );
}

function registerSymbolSearchTool() {
  registerTool(
    "workspace_symbol_search",
    async ({ args = {} }) => {
      const query = args.query ?? args.name ?? args.symbol;
      const limit =
        typeof args.limit === "number" && args.limit > 0 ? Math.min(args.limit, 100) : 50;
      const language =
        typeof args.language === "string" ? args.language.toLowerCase() : undefined;
      const file =
        typeof args.path === "string"
          ? args.path
          : typeof args.file === "string"
          ? args.file
          : undefined;

      const results = searchSymbols({
        query,
        language,
        limit,
        filePath: file,
      });

      return {
        ok: true,
        status: 200,
        content: JSON.stringify(
          {
            query,
            language,
            file,
            results,
          },
          null,
          2,
        ),
        metadata: {
          total: results.length,
        },
      };
    },
    { category: "indexing" },
  );
}

function registerSymbolReferencesTool() {
  registerTool(
    "workspace_symbol_references",
    async ({ args = {} }) => {
      const symbol = args.symbol ?? args.name ?? args.query;
      const limit =
        typeof args.limit === "number" && args.limit > 0 ? Math.min(args.limit, 100) : 50;
      const file =
        typeof args.path === "string"
          ? args.path
          : typeof args.file === "string"
          ? args.file
          : undefined;

      const results = searchSymbolReferences({
        symbol,
        filePath: file,
        limit,
      });

      return {
        ok: true,
        status: 200,
        content: JSON.stringify(
          {
            symbol,
            file,
            results,
          },
          null,
          2,
        ),
        metadata: {
          total: results.length,
        },
      };
    },
    { category: "indexing" },
  );
}


/**
 * Dedicated Glob tool for Claude Code compatibility (maybe others?).
 *
 * Why this exists (instead of using workspace_list alias):
 * - Claude Code's Glob tool returns plain text (one path per line)
 * - workspace_list returns JSON with entries array
 * - Models expect plain text format from Glob tool
 *
 * See also: TOOL_ALIASES in src/tools/index.js (commented glob entries)
 */
function registerGlobTool() {
  registerTool(
    "Glob",
    async ({ args = {} }) => {
      const pattern = args.pattern;
      const basePath = args.path;

      let patterns;
      if (basePath) {
        const cleanPath = basePath.replace(/\/+$/, "");
        patterns = pattern ? [`${cleanPath}/${pattern}`] : [`${cleanPath}/**/*`];
      } else {
        patterns = pattern ? [pattern] : undefined;
      }

      const entries = await listWorkspaceFiles({ patterns, limit: 1000 });

      // Plain text output: one path per line (Claude Code format)
      return {
        ok: true,
        status: 200,
        content: entries.map((e) => e.path).join("\n"),
      };
    },
    { category: "indexing" },
  );
}

function registerGotoDefinitionTool() {
  registerTool(
    "workspace_goto_definition",
    async ({ args = {} }) => {
      const filePath =
        typeof args.file === "string"
          ? args.file
          : typeof args.path === "string"
          ? args.path
          : null;
      const line =
        typeof args.line === "number"
          ? args.line
          : typeof args.row === "number"
          ? args.row
          : null;
      const column =
        typeof args.column === "number"
          ? args.column
          : typeof args.col === "number"
          ? args.col
          : null;
      const symbolName =
        typeof args.symbol === "string"
          ? args.symbol
          : typeof args.name === "string"
          ? args.name
          : null;

      if (filePath && line) {
        const rows = findDefinitionNearLocation({ filePath, line, column });
        return {
          ok: true,
          status: 200,
          content: JSON.stringify(
            {
              filePath,
              line,
              column: column ?? null,
              results: rows.map((row) => ({
                symbol: row.name,
                kind: row.kind,
                definition: {
                  filePath: row.definition_path,
                  line: row.definition_line,
                  column: row.definition_column,
                },
                reference: {
                  filePath: row.reference_path,
                  line: row.reference_line,
                  column: row.reference_column,
                  snippet: row.snippet ?? null,
                },
              })),
            },
            null,
            2,
          ),
        };
      }

      if (symbolName) {
        const rows = listDefinitionsBySymbol({ name: symbolName });
        return {
          ok: true,
          status: 200,
          content: JSON.stringify(
            {
              symbol: symbolName,
              definitions: rows,
            },
            null,
            2,
          ),
        };
      }

      throw new Error(
        "workspace_goto_definition requires either (file,line[,column]) or symbol name.",
      );
    },
    { category: "indexing" },
  );
}

function registerIndexerTools() {
  registerWorkspaceListTool();
  registerWorkspaceSearchTool();
  registerWorkspaceRebuildTool();
  registerProjectSummaryTool();
  registerSymbolSearchTool();
  registerSymbolReferencesTool();
  registerGotoDefinitionTool();
  registerGlobTool();
}

module.exports = {
  registerIndexerTools,
};
