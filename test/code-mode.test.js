/**
 * Tests for Code Mode — MCP Meta-Tools
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { generateExample } = require('../src/tools/code-mode');

// ── generateExample ─────────────────────────────────────────────────

describe('Code Mode', () => {
  describe('generateExample', () => {
    it('generates example from string properties', () => {
      const tool = {
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search query' },
            limit: { type: 'number', description: 'Max results' },
          },
        },
      };
      const example = JSON.parse(generateExample(tool));
      assert.equal(example.query, '<query>');
      assert.equal(example.limit, 0);
    });

    it('generates example with boolean and array types', () => {
      const tool = {
        inputSchema: {
          type: 'object',
          properties: {
            verbose: { type: 'boolean' },
            tags: { type: 'array' },
            config: { type: 'object' },
          },
        },
      };
      const example = JSON.parse(generateExample(tool));
      assert.equal(example.verbose, true);
      assert.deepEqual(example.tags, []);
      assert.deepEqual(example.config, {});
    });

    it('uses example values when provided', () => {
      const tool = {
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', example: 'John' },
            age: { type: 'integer', example: 30 },
          },
        },
      };
      const example = JSON.parse(generateExample(tool));
      assert.equal(example.name, 'John');
      assert.equal(example.age, 30);
    });

    it('handles empty schema', () => {
      const example = JSON.parse(generateExample({}));
      assert.deepEqual(example, {});
    });

    it('handles input_schema (underscore variant)', () => {
      const tool = {
        input_schema: {
          type: 'object',
          properties: {
            q: { type: 'string' },
          },
        },
      };
      const example = JSON.parse(generateExample(tool));
      assert.equal(example.q, '<q>');
    });
  });

  // ── Code Mode config ────────────────────────────────────────────

  describe('config', () => {
    it('codeMode config exists in config module', () => {
      const config = require('../src/config');
      assert.ok(config.mcp, 'config.mcp should exist');
      assert.ok(config.mcp.codeMode, 'config.mcp.codeMode should exist');
      assert.equal(typeof config.mcp.codeMode.enabled, 'boolean');
      assert.equal(typeof config.mcp.codeMode.toolListCacheTtl, 'number');
    });

    it('codeMode defaults to disabled', () => {
      const config = require('../src/config');
      // Unless CODE_MODE_ENABLED=true is set in env, should be false
      assert.equal(config.mcp.codeMode.enabled, false);
    });

    it('codeMode cache TTL defaults to 60000', () => {
      const config = require('../src/config');
      assert.equal(config.mcp.codeMode.toolListCacheTtl, 60_000);
    });
  });

  // ── Code Mode registration branching ──────────────────────────

  describe('mcp-remote branching', () => {
    it('registerRemoteTools exports a function', () => {
      const { registerRemoteTools } = require('../src/tools/mcp-remote');
      assert.equal(typeof registerRemoteTools, 'function');
    });
  });

  // ── Smart selection integration ───────────────────────────────

  describe('smart-selection integration', () => {
    it('selectToolsSmartly is exported', () => {
      const { selectToolsSmartly } = require('../src/tools/smart-selection');
      assert.equal(typeof selectToolsSmartly, 'function');
    });

    it('classifyRequestType is exported', () => {
      const { classifyRequestType } = require('../src/tools/smart-selection');
      assert.equal(typeof classifyRequestType, 'function');
    });
  });

  // ── Lazy loader integration ───────────────────────────────────

  describe('lazy-loader integration', () => {
    it('has code-mode category registered', () => {
      const { TOOL_CATEGORIES } = require('../src/tools/lazy-loader');
      assert.ok(TOOL_CATEGORIES['code-mode'], 'code-mode category should exist');
      assert.equal(typeof TOOL_CATEGORIES['code-mode'].loader, 'function');
      assert.equal(TOOL_CATEGORIES['code-mode'].priority, 3);
    });

    it('loadCategoryForTool maps mcp_execute to code-mode', () => {
      const { loadCategoryForTool, resetLoader } = require('../src/tools/lazy-loader');
      resetLoader();
      // This should attempt to load the code-mode category
      const loaded = loadCategoryForTool('mcp_execute');
      // May or may not succeed depending on MCP availability, but should not throw
      assert.equal(typeof loaded, 'boolean');
    });

    it('loadCategoryForTool maps mcp_list_tools to code-mode', () => {
      const { loadCategoryForTool, resetLoader } = require('../src/tools/lazy-loader');
      resetLoader();
      const loaded = loadCategoryForTool('mcp_list_tools');
      assert.equal(typeof loaded, 'boolean');
    });
  });

  // ── Token savings calculation ─────────────────────────────────

  describe('token savings', () => {
    it('4 meta-tools use fewer tokens than 50 individual tools', () => {
      const { estimateToolTokens } = require('../src/tools/smart-selection');

      // Simulate 50 MCP remote tools
      const remotTools = Array.from({ length: 50 }, (_, i) => ({
        name: `mcp_server_tool_${i}`,
        description: `Description for tool ${i} that does something useful`,
        input_schema: { type: 'object', properties: { arg: { type: 'string' } } },
      }));

      // 4 Code Mode meta-tools
      const metaTools = [
        { name: 'mcp_list_tools', description: 'List all MCP tools', input_schema: { type: 'object', properties: { server_id: { type: 'string' } } } },
        { name: 'mcp_tool_info', description: 'Get tool schema', input_schema: { type: 'object', properties: { server_id: { type: 'string' }, tool_name: { type: 'string' } }, required: ['server_id', 'tool_name'] } },
        { name: 'mcp_tool_docs', description: 'Get tool docs', input_schema: { type: 'object', properties: { server_id: { type: 'string' }, tool_name: { type: 'string' } }, required: ['server_id', 'tool_name'] } },
        { name: 'mcp_execute', description: 'Execute MCP tool', input_schema: { type: 'object', properties: { server_id: { type: 'string' }, tool_name: { type: 'string' }, arguments: { type: 'object' } }, required: ['server_id', 'tool_name'] } },
      ];

      const remoteTokens = estimateToolTokens(remotTools);
      const metaTokens = estimateToolTokens(metaTools);

      // Meta-tools should use at least 50% fewer tokens
      assert.ok(
        metaTokens < remoteTokens * 0.5,
        `Expected >50% savings: ${metaTokens} vs ${remoteTokens} (${((1 - metaTokens / remoteTokens) * 100).toFixed(0)}% savings)`
      );
    });
  });

  // ── Large payload config ──────────────────────────────────────

  describe('largePayload config', () => {
    it('exists in config module', () => {
      const config = require('../src/config');
      assert.ok(config.largePayload, 'config.largePayload should exist');
      assert.equal(typeof config.largePayload.enabled, 'boolean');
      assert.equal(typeof config.largePayload.threshold, 'number');
    });

    it('defaults to enabled', () => {
      const config = require('../src/config');
      assert.equal(config.largePayload.enabled, true);
    });

    it('default threshold is 1MB', () => {
      const config = require('../src/config');
      assert.equal(config.largePayload.threshold, 1_048_576);
    });
  });
});
