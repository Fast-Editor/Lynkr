/**
 * MCP broker (ROUTING-NOTES Track B — Lynkr was MCP-client-only).
 *
 * Security contract is the load-bearing part:
 *   - disabled by default → 404 (the surface doesn't exist)
 *   - enabled without a token → 503 fail-closed (never unauthenticated)
 *   - wrong/missing bearer → 401
 * Function contract: aggregated namespaced tool list, per-server errors
 * reported rather than hidden, calls proxied to the underlying client.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const express = require('express');

process.env.DATABRICKS_API_KEY = process.env.DATABRICKS_API_KEY || 'test-key';
process.env.DATABRICKS_API_BASE = process.env.DATABRICKS_API_BASE || 'http://test.com';
process.env.LOG_FILE_ENABLED = 'false';

// Mock the MCP module before the broker requires it.
const mcpPath = require.resolve('../src/mcp');
const fakeClients = {
  alpha: {
    request: async (method, params) => {
      if (method === 'tools/list') {
        return { tools: [{ name: 'read_file', description: 'Read a file', inputSchema: { type: 'object' } }] };
      }
      if (method === 'tools/call') return { content: [{ type: 'text', text: `alpha ran ${params.name}` }] };
      throw new Error(`unexpected method ${method}`);
    },
  },
  beta: {
    request: async (method) => {
      if (method === 'tools/list') throw new Error('beta is down');
      throw new Error('beta is down');
    },
  },
};
require.cache[mcpPath] = {
  id: mcpPath,
  filename: mcpPath,
  loaded: true,
  exports: {
    listServers: () => [
      { id: 'alpha', description: 'files' },
      { id: 'beta', description: 'flaky' },
    ],
    getServer: (id) => (['alpha', 'beta'].includes(id) ? { id } : null),
    ensureClient: async (id) => {
      const c = fakeClients[id];
      if (!c) throw new Error(`no client ${id}`);
      return c;
    },
  },
};

const brokerRouter = require('../src/api/mcp-broker');

let server;
let port;

test.before(async () => {
  const app = express();
  app.use(express.json());
  app.use(brokerRouter);
  server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  port = server.address().port;
});

test.after(() => {
  server.close();
  delete require.cache[mcpPath];
});

test.beforeEach(() => {
  delete process.env.LYNKR_MCP_BROKER_ENABLED;
  delete process.env.LYNKR_MCP_BROKER_TOKEN;
  delete process.env.LYNKR_MCP_BROKER_SERVERS;
});

function call(pathname, { method = 'GET', token, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: pathname,
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    }, (res) => {
      let chunks = '';
      res.on('data', (c) => (chunks += c));
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(chunks || '{}') }));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

test('disabled by default: the surface does not exist (404)', async () => {
  const res = await call('/v1/mcp/tools');
  assert.equal(res.status, 404);
});

test('enabled without a token fails CLOSED (503), never serves', async () => {
  process.env.LYNKR_MCP_BROKER_ENABLED = 'true';
  const res = await call('/v1/mcp/tools');
  assert.equal(res.status, 503);
  assert.equal(res.body.error.type, 'broker_misconfigured');
});

test('wrong or missing bearer → 401', async () => {
  process.env.LYNKR_MCP_BROKER_ENABLED = 'true';
  process.env.LYNKR_MCP_BROKER_TOKEN = 'secret-token';
  assert.equal((await call('/v1/mcp/tools')).status, 401);
  assert.equal((await call('/v1/mcp/tools', { token: 'wrong' })).status, 401);
});

test('tool list aggregates across servers, namespaced, with per-server errors reported', async () => {
  process.env.LYNKR_MCP_BROKER_ENABLED = 'true';
  process.env.LYNKR_MCP_BROKER_TOKEN = 'secret-token';
  const res = await call('/v1/mcp/tools', { token: 'secret-token' });
  assert.equal(res.status, 200);
  assert.equal(res.body.tools.length, 1);
  assert.equal(res.body.tools[0].name, 'alpha:read_file');
  assert.equal(res.body.tools[0].server, 'alpha');
  // beta's failure is visible, not silently dropped (§4.3).
  assert.match(res.body.server_errors.beta, /beta is down/);
});

test('tools/call proxies to the underlying client', async () => {
  process.env.LYNKR_MCP_BROKER_ENABLED = 'true';
  process.env.LYNKR_MCP_BROKER_TOKEN = 'secret-token';
  const res = await call('/v1/mcp/tools/call', {
    method: 'POST',
    token: 'secret-token',
    body: { server: 'alpha', tool: 'read_file', arguments: { path: '/x' } },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.result.content[0].text, 'alpha ran read_file');
});

test('unknown server → 404; server allowlist enforced → 403', async () => {
  process.env.LYNKR_MCP_BROKER_ENABLED = 'true';
  process.env.LYNKR_MCP_BROKER_TOKEN = 'secret-token';
  const unknown = await call('/v1/mcp/tools/call', {
    method: 'POST', token: 'secret-token', body: { server: 'nope', tool: 'x' },
  });
  assert.equal(unknown.status, 404);

  process.env.LYNKR_MCP_BROKER_SERVERS = 'beta';
  const blocked = await call('/v1/mcp/tools/call', {
    method: 'POST', token: 'secret-token', body: { server: 'alpha', tool: 'read_file' },
  });
  assert.equal(blocked.status, 403);
});

test('call failure surfaces as an error status, not a fake success', async () => {
  process.env.LYNKR_MCP_BROKER_ENABLED = 'true';
  process.env.LYNKR_MCP_BROKER_TOKEN = 'secret-token';
  const res = await call('/v1/mcp/tools/call', {
    method: 'POST', token: 'secret-token', body: { server: 'beta', tool: 'anything' },
  });
  assert.equal(res.status, 502);
  assert.equal(res.body.error.type, 'tool_call_failed');
});
