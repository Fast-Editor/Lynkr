/**
 * Code Mode — Meta-Tools for MCP Token Optimization
 *
 * Replaces 100+ individual MCP tool definitions with 4 meta-tools,
 * reducing tool-catalog token overhead from ~17,500 to ~700 tokens.
 *
 * Inspired by Bifrost's Code Mode. Instead of sending every MCP tool
 * schema in every request, the LLM discovers tools lazily:
 *   1. mcp_list_tools   → discover available tools (compact)
 *   2. mcp_tool_info    → load full schema for one tool
 *   3. mcp_tool_docs    → get usage examples
 *   4. mcp_execute      → execute a tool by name
 *
 * Activation: CODE_MODE_ENABLED=true
 *
 * @module tools/code-mode
 */

const { registerTool } = require('.');
const { listServers, ensureClient } = require('../mcp');
const config = require('../config');
const logger = require('../logger');

// ── Tool List Cache ─────────────────────────────────────────────────

let toolListCache = null;
let toolListCacheTs = 0;

function getCacheTtl() {
  return config.mcp?.codeMode?.toolListCacheTtl || 60_000;
}

/**
 * Fetch tool lists from all MCP servers, with caching.
 * @param {string} [filterServerId] - Optional: only fetch from this server
 * @param {boolean} [forceRefresh] - Bypass cache
 * @returns {Promise<Object>} { serverId: [{ name, description }] }
 */
async function fetchToolList(filterServerId, forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && toolListCache && (now - toolListCacheTs < getCacheTtl())) {
    if (filterServerId) {
      return { [filterServerId]: toolListCache[filterServerId] || [] };
    }
    return toolListCache;
  }

  const servers = listServers();
  const result = {};

  await Promise.all(
    servers.map(async (server) => {
      if (filterServerId && server.id !== filterServerId) return;
      try {
        const client = await ensureClient(server.id);
        if (!client) {
          result[server.id] = { error: 'Server not available' };
          return;
        }
        const response = await client.request('tools/list', {});
        const tools = Array.isArray(response?.tools) ? response.tools : [];
        result[server.id] = tools.map(t => ({
          name: t.name ?? t.method ?? 'unknown',
          description: (t.description || '').substring(0, 100),
        }));
      } catch (err) {
        result[server.id] = { error: err.message };
      }
    })
  );

  // Update cache if we fetched all servers
  if (!filterServerId) {
    toolListCache = result;
    toolListCacheTs = now;
  }

  return filterServerId ? { [filterServerId]: result[filterServerId] || [] } : result;
}

/**
 * Fetch full tool schema for a specific tool on a specific server.
 * @param {string} serverId
 * @param {string} toolName
 * @returns {Promise<Object|null>}
 */
async function fetchToolSchema(serverId, toolName) {
  const client = await ensureClient(serverId);
  if (!client) return null;

  const response = await client.request('tools/list', {});
  const tools = Array.isArray(response?.tools) ? response.tools : [];
  return tools.find(t => (t.name ?? t.method) === toolName) || null;
}

/**
 * Generate a usage example from a tool's input schema.
 * @param {Object} tool - Tool definition with inputSchema
 * @returns {string} Example JSON
 */
function generateExample(tool) {
  const schema = tool.inputSchema || tool.input_schema || {};
  const props = schema.properties || {};
  const example = {};

  for (const [key, def] of Object.entries(props)) {
    if (def.type === 'string') example[key] = def.example || `<${key}>`;
    else if (def.type === 'number' || def.type === 'integer') example[key] = def.example || 0;
    else if (def.type === 'boolean') example[key] = def.example ?? true;
    else if (def.type === 'array') example[key] = [];
    else if (def.type === 'object') example[key] = {};
    else example[key] = null;
  }

  return JSON.stringify(example, null, 2);
}

// ── Meta-Tool Registration ──────────────────────────────────────────

function registerCodeModeTools() {
  // 1. mcp_list_tools — discover available tools
  registerTool(
    'mcp_list_tools',
    async ({ args = {} }) => {
      const serverId = args.server_id || null;
      const forceRefresh = args.force_refresh === true;
      const result = await fetchToolList(serverId, forceRefresh);

      // Add summary stats
      let totalTools = 0;
      for (const tools of Object.values(result)) {
        if (Array.isArray(tools)) totalTools += tools.length;
      }

      return {
        ok: true,
        status: 200,
        content: JSON.stringify({ total_tools: totalTools, servers: result }, null, 2),
      };
    },
    {
      category: 'code-mode',
      description: 'List all available MCP tools across all servers. Returns tool names and brief descriptions. Use this first to discover what tools are available.',
      input_schema: {
        type: 'object',
        properties: {
          server_id: { type: 'string', description: 'Optional: filter to a specific MCP server ID' },
          force_refresh: { type: 'boolean', description: 'Bypass cache and refresh tool list' },
        },
      },
    }
  );

  // 2. mcp_tool_info — load full schema for one tool
  registerTool(
    'mcp_tool_info',
    async ({ args = {} }) => {
      const serverId = args.server_id;
      const toolName = args.tool_name;

      if (!serverId || !toolName) {
        throw new Error('mcp_tool_info requires server_id and tool_name');
      }

      const tool = await fetchToolSchema(serverId, toolName);
      if (!tool) {
        throw new Error(`Tool "${toolName}" not found on server "${serverId}"`);
      }

      return {
        ok: true,
        status: 200,
        content: JSON.stringify({
          server: serverId,
          name: tool.name ?? tool.method,
          description: tool.description || '',
          inputSchema: tool.inputSchema || tool.input_schema || {},
        }, null, 2),
      };
    },
    {
      category: 'code-mode',
      description: 'Get the full schema and detailed description for a specific MCP tool. Use after mcp_list_tools to get the exact parameters needed before calling mcp_execute.',
      input_schema: {
        type: 'object',
        properties: {
          server_id: { type: 'string', description: 'MCP server ID' },
          tool_name: { type: 'string', description: 'Tool name from mcp_list_tools' },
        },
        required: ['server_id', 'tool_name'],
      },
    }
  );

  // 3. mcp_tool_docs — usage examples
  registerTool(
    'mcp_tool_docs',
    async ({ args = {} }) => {
      const serverId = args.server_id;
      const toolName = args.tool_name;

      if (!serverId || !toolName) {
        throw new Error('mcp_tool_docs requires server_id and tool_name');
      }

      const tool = await fetchToolSchema(serverId, toolName);
      if (!tool) {
        throw new Error(`Tool "${toolName}" not found on server "${serverId}"`);
      }

      const schema = tool.inputSchema || tool.input_schema || {};
      const params = Object.entries(schema.properties || {}).map(([name, def]) => ({
        name,
        type: def.type || 'any',
        required: (schema.required || []).includes(name),
        description: def.description || '',
      }));

      return {
        ok: true,
        status: 200,
        content: JSON.stringify({
          server: serverId,
          tool: tool.name ?? tool.method,
          description: tool.description || '',
          parameters: params,
          example_arguments: generateExample(tool),
          usage: `Use mcp_execute with server_id="${serverId}", tool_name="${toolName}", and arguments matching the schema above.`,
        }, null, 2),
      };
    },
    {
      category: 'code-mode',
      description: 'Get usage documentation, parameter details, and example arguments for an MCP tool.',
      input_schema: {
        type: 'object',
        properties: {
          server_id: { type: 'string', description: 'MCP server ID' },
          tool_name: { type: 'string', description: 'Tool name' },
        },
        required: ['server_id', 'tool_name'],
      },
    }
  );

  // 4. mcp_execute — execute a tool by name
  registerTool(
    'mcp_execute',
    async ({ args = {} }) => {
      const serverId = args.server_id;
      const toolName = args.tool_name;
      const toolArgs = args.arguments ?? {};

      if (!serverId || !toolName) {
        throw new Error('mcp_execute requires server_id and tool_name');
      }

      const client = await ensureClient(serverId.trim());
      if (!client) {
        throw new Error(`MCP server "${serverId}" is not available.`);
      }

      const result = await client.request(toolName.trim(), toolArgs);

      return {
        ok: true,
        status: 200,
        content: JSON.stringify({
          server: serverId,
          tool: toolName,
          result,
        }, null, 2),
        metadata: { server: serverId, tool: toolName },
      };
    },
    {
      category: 'code-mode',
      description: 'Execute an MCP tool by name with JSON arguments. First use mcp_list_tools to discover tools, then mcp_tool_info to get the schema, then this tool to execute.',
      input_schema: {
        type: 'object',
        properties: {
          server_id: { type: 'string', description: 'MCP server ID' },
          tool_name: { type: 'string', description: 'Tool method name' },
          arguments: {
            type: 'object',
            description: 'JSON arguments matching the tool input schema',
            additionalProperties: true,
          },
        },
        required: ['server_id', 'tool_name'],
      },
    }
  );

  logger.info('[code-mode] Registered 4 meta-tools: mcp_list_tools, mcp_tool_info, mcp_tool_docs, mcp_execute');
}

module.exports = {
  registerCodeModeTools,
  // Exported for testing
  fetchToolList,
  fetchToolSchema,
  generateExample,
};
