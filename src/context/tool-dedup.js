/**
 * MCP-aware Tool Dedup
 *
 * Strips built-in tool definitions when an equivalent MCP tool is present in
 * the request. Sending both wastes tool-schema tokens and gives the model
 * redundant choices. Rule-based and deterministic.
 *
 * Example: if the Exa or Tavily MCP search tools are present, the built-in
 * WebSearch/WebFetch tools are redundant and dropped.
 *
 * Ported from 9router's toolDeduper. Always on — purely removes redundant
 * tool definitions, never adds.
 *
 * @module context/tool-dedup
 */

const logger = require("../logger");

// Each rule: if any `triggers` tool is present, strip any tools matching
// `strip`. Patterns may be exact strings or RegExp (matched against the name).
const DEDUP_RULES = [
  {
    // Exa MCP present → drop built-in web tools (Exa is preferred).
    triggers: ["mcp__exa__web_search_exa", "mcp__exa__web_fetch_exa"],
    strip: ["WebSearch", "WebFetch", "web_search", "web_fetch", "mcp__workspace__web_fetch"],
  },
  {
    // Tavily MCP present → drop built-in web tools.
    triggers: ["mcp__tavily__tavily_search", "mcp__tavily__tavily_extract"],
    strip: ["WebSearch", "WebFetch", "web_search", "web_fetch", "mcp__workspace__web_fetch"],
  },
  {
    // Browser MCP present → drop a duplicate Chrome-connector tool family.
    triggers: [/^mcp__browsermcp__/],
    strip: [/^mcp__Claude_in_Chrome__/],
  },
];

function getToolName(t) {
  return t?.name || t?.function?.name || "";
}

function matches(name, pattern) {
  if (typeof pattern === "string") return name === pattern;
  return pattern instanceof RegExp ? pattern.test(name) : false;
}

/**
 * Remove redundant built-in tools that are superseded by present MCP tools.
 *
 * @param {Array} tools - Tool definitions (Anthropic or OpenAI shape).
 * @returns {{tools: Array, stripped: string[]}} filtered tools + names removed.
 */
function dedupeTools(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return { tools, stripped: [] };

  const names = tools.map(getToolName);
  const toStrip = new Set();

  for (const rule of DEDUP_RULES) {
    const hasTrigger = names.some((n) => rule.triggers.some((p) => matches(n, p)));
    if (!hasTrigger) continue;
    for (const n of names) {
      // Never strip a tool that is itself a trigger.
      if (rule.triggers.some((p) => matches(n, p))) continue;
      if (rule.strip.some((p) => matches(n, p))) toStrip.add(n);
    }
  }

  if (toStrip.size === 0) return { tools, stripped: [] };

  const out = tools.filter((t) => !toStrip.has(getToolName(t)));
  return { tools: out, stripped: Array.from(toStrip) };
}

/**
 * Apply tool dedup to a payload in place. No-op when nothing is stripped.
 *
 * @param {object} payload - Request body with a `tools` array.
 * @returns {string[]} names of stripped tools.
 */
function applyToolDedup(payload) {
  if (!payload || !Array.isArray(payload.tools)) return [];
  const { tools, stripped } = dedupeTools(payload.tools);
  if (stripped.length > 0) {
    payload.tools = tools;
    logger.debug({ stripped }, "[ToolDedup] Stripped redundant built-in tools (MCP equivalents present)");
  }
  return stripped;
}

module.exports = {
  dedupeTools,
  applyToolDedup,
};
