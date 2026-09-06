/**
 * MCP broker (ROUTING-NOTES Track B / §1 gap: Lynkr was MCP-client-only).
 *
 * Exposes Lynkr's configured MCP servers to OTHER clients over HTTP, so one
 * Lynkr install can act as the single MCP access point for a team/toolchain
 * instead of every client wiring up (and holding credentials for) every
 * server separately. The credential-injection property falls out of the
 * existing registry design: downstream server env/credentials live in
 * Lynkr's MCP config and never leave this process — callers see only tool
 * names and results.
 *
 * Surface (all JSON):
 *   GET  /v1/mcp/servers      configured servers (id + tool count)
 *   GET  /v1/mcp/tools        aggregated tools/list across servers,
 *                             namespaced "<server>:<tool>"
 *   POST /v1/mcp/tools/call   { server, tool, arguments } → tool result
 *
 * Security: OFF by default. Enabling requires BOTH
 *   LYNKR_MCP_BROKER_ENABLED=true
 *   LYNKR_MCP_BROKER_TOKEN=<secret>       (Bearer-checked on every call)
 * Enabled-without-token fails CLOSED (503 + loud log) — an exposed tool
 * surface must never be reachable unauthenticated (§4.4 rule: a live
 * caller's input is never silently trusted). Optional allowlist:
 *   LYNKR_MCP_BROKER_SERVERS=id1,id2      (default: all configured)
 *
 * @module api/mcp-broker
 */

const express = require('express');
const crypto = require('crypto');
const logger = require('../logger');
const mcp = require('../mcp');

const router = express.Router();

const CALL_TIMEOUT_MS = Number.parseInt(process.env.LYNKR_MCP_BROKER_CALL_TIMEOUT_MS, 10) || 60_000;

function _enabled() {
  return process.env.LYNKR_MCP_BROKER_ENABLED === 'true';
}

function _allowedServers() {
  const raw = process.env.LYNKR_MCP_BROKER_SERVERS;
  if (!raw) return null; // null = all configured servers
  return new Set(raw.split(',').map((s) => s.trim()).filter(Boolean));
}

function _timingSafeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function brokerAuth(req, res, next) {
  if (!_enabled()) {
    return res.status(404).json({ error: { type: 'not_found', message: 'MCP broker is not enabled' } });
  }
  const token = process.env.LYNKR_MCP_BROKER_TOKEN;
  if (!token) {
    // Fail closed: enabled-but-tokenless must never serve.
    logger.error('[McpBroker] LYNKR_MCP_BROKER_ENABLED=true but LYNKR_MCP_BROKER_TOKEN is unset — refusing to serve. Set a token to activate the broker.');
    return res.status(503).json({
      error: { type: 'broker_misconfigured', message: 'MCP broker enabled without LYNKR_MCP_BROKER_TOKEN; refusing to serve unauthenticated' },
    });
  }
  const auth = req.headers.authorization || '';
  const presented = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!presented || !_timingSafeEqual(presented, token)) {
    return res.status(401).json({ error: { type: 'unauthorized', message: 'Invalid or missing bearer token' } });
  }
  next();
}

function _visibleServers() {
  const allow = _allowedServers();
  return mcp.listServers().filter((s) => !allow || allow.has(s.id));
}

async function _clientFor(serverId) {
  const allow = _allowedServers();
  if (allow && !allow.has(serverId)) {
    const err = new Error(`server "${serverId}" is not allowlisted for the broker`);
    err.status = 403;
    throw err;
  }
  const server = mcp.getServer(serverId);
  if (!server) {
    const err = new Error(`unknown MCP server "${serverId}"`);
    err.status = 404;
    throw err;
  }
  return mcp.ensureClient(serverId);
}

router.get('/v1/mcp/servers', brokerAuth, async (_req, res) => {
  const servers = _visibleServers().map((s) => ({
    id: s.id,
    description: s.description ?? null,
  }));
  res.json({ servers });
});

router.get('/v1/mcp/tools', brokerAuth, async (_req, res) => {
  const results = [];
  const errors = {};
  await Promise.all(_visibleServers().map(async (server) => {
    try {
      const client = await mcp.ensureClient(server.id);
      const listed = await client.request('tools/list', {});
      for (const tool of listed?.tools ?? []) {
        results.push({
          name: `${server.id}:${tool.name}`,
          server: server.id,
          tool: tool.name,
          description: tool.description ?? null,
          input_schema: tool.inputSchema ?? tool.input_schema ?? null,
        });
      }
    } catch (err) {
      // Per-server failure is reported, not hidden — a dead server must not
      // silently vanish from the tool list (§4.3: no invisible degradation).
      errors[server.id] = err.message;
    }
  }));
  res.json({ tools: results, ...(Object.keys(errors).length ? { server_errors: errors } : {}) });
});

router.post('/v1/mcp/tools/call', brokerAuth, async (req, res) => {
  const { server, tool, arguments: args } = req.body || {};
  if (!server || !tool) {
    return res.status(400).json({ error: { type: 'invalid_request', message: 'body must include { server, tool, arguments? }' } });
  }
  try {
    const client = await _clientFor(server);
    const result = await Promise.race([
      client.request('tools/call', { name: tool, arguments: args ?? {} }),
      new Promise((_, reject) =>
        setTimeout(() => reject(Object.assign(new Error('tool call timed out'), { status: 504 })), CALL_TIMEOUT_MS).unref?.()
      ),
    ]);
    res.json({ server, tool, result });
  } catch (err) {
    const status = err.status ?? 502;
    logger.warn({ server, tool, error: err.message }, '[McpBroker] tool call failed');
    res.status(status).json({ error: { type: 'tool_call_failed', message: err.message, server, tool } });
  }
});

module.exports = router;
