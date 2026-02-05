const fs = require("fs");
const path = require("path");
const config = require("../config");
const logger = require("../logger");
const McpClient = require("./client");

const servers = new Map();
const clients = new Map();
let manifestLoaded = false;

function normaliseServer(entry) {
  if (!entry || typeof entry !== "object") return null;
  const id = entry.id ?? entry.name ?? entry.label;
  if (!id) return null;
  return {
    id: String(id),
    name: entry.name ?? String(id),
    description: entry.description ?? null,
    command: entry.command ?? null,
    args: Array.isArray(entry.args) ? entry.args.map(String) : [],
    env: entry.env && typeof entry.env === "object" ? entry.env : {},
    transport: entry.transport ?? "stdio",
    metadata: entry.metadata && typeof entry.metadata === "object" ? entry.metadata : {},
    raw: entry,
  };
}

function registerServer(entry) {
  const server = normaliseServer(entry);
  if (!server) return null;
  servers.set(server.id, server);
  return server;
}

function listServers() {
  return Array.from(servers.values());
}

function getServer(id) {
  if (!id) return null;
  return servers.get(String(id)) ?? null;
}

function clearServers() {
  servers.clear();
  manifestLoaded = false;
  clients.forEach((client) => {
    client.close().catch((err) => {
      logger.debug({ err }, "Error closing MCP client");
    });
  });
  clients.clear();
}

function loadServersFromEntries(entries, { source } = {}) {
  let registeredCount = 0;
  entries.forEach((entry) => {
    const registered = registerServer(entry);
    if (registered) {
      registeredCount += 1;
      logger.debug(
        { mcpServer: registered.id, source },
        "Registered MCP server",
      );
    }
  });
  if (registeredCount > 0) {
    logger.info(
      { count: registeredCount, source },
      "Loaded MCP servers",
    );
  }
  return registeredCount;
}

function readManifest(manifestPath) {
  const resolved = path.resolve(manifestPath);
  try {
    const raw = fs.readFileSync(resolved, "utf8");
    const parsed = JSON.parse(raw);
    const entries = Array.isArray(parsed?.servers)
      ? parsed.servers
      : Array.isArray(parsed)
      ? parsed
      : [];
    return { entries, path: resolved };
  } catch (err) {
    logger.warn({ err, manifest: resolved }, "Failed to load MCP server manifest");
    return { entries: [], path: resolved, error: err };
  }
}

function loadFromManifest(manifestPath, { clear = true } = {}) {
  const { entries, path: resolved } = readManifest(manifestPath);
  if (clear) {
    clearServers();
  }
  const registeredCount = loadServersFromEntries(entries, { source: resolved });
  manifestLoaded = manifestLoaded || registeredCount > 0;
  return listServers();
}

function discoverManifestFiles(directories = []) {
  const files = [];
  directories.forEach((dir) => {
    if (typeof dir !== "string" || dir.length === 0) return;
    let stats = null;
    try {
      stats = fs.statSync(dir);
    } catch (err) {
      logger.debug({ dir, err }, "Manifest directory not accessible");
      return;
    }
    if (!stats.isDirectory()) {
      logger.debug({ dir }, "Manifest path is not a directory");
      return;
    }
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      entries.forEach((entry) => {
        if (!entry.isFile()) return;
        if (!entry.name.toLowerCase().endsWith(".json")) return;
        files.push(path.join(dir, entry.name));
      });
    } catch (err) {
      logger.debug({ dir, err }, "Failed to read manifest directory");
    }
  });
  return files;
}

function loadConfiguredServers() {
  const manifestPath = config.mcp?.servers?.manifestPath;
  const manifestDirs = Array.isArray(config.mcp?.servers?.manifestDirs)
    ? config.mcp.servers.manifestDirs
    : [];

  clearServers();
  const seen = new Set();

  if (manifestPath) {
    const resolved = path.resolve(manifestPath);
    seen.add(resolved);
    loadFromManifest(resolved, { clear: false });
  }

  const discovered = discoverManifestFiles(manifestDirs);
  discovered.forEach((filePath) => {
    const resolved = path.resolve(filePath);
    if (seen.has(resolved)) return;
    seen.add(resolved);
    const { entries } = readManifest(resolved);
    loadServersFromEntries(entries, { source: resolved });
  });

  manifestLoaded = true;
  listServers().forEach((server) => {
    ensureClient(server.id).catch((err) => {
      logger.warn({ err, server: server.id }, "Failed to start MCP client");
    });
  });
  return listServers();
}

function hasLoadedManifest() {
  return manifestLoaded;
}

async function ensureClient(serverId) {
  if (!serverId) return null;
  const existing = clients.get(serverId);
  if (existing) return existing;
  const server = getServer(serverId);
  if (!server) return null;
  if (server.transport && server.transport !== "stdio") {
    logger.warn(
      { server: server.id, transport: server.transport },
      "Unsupported MCP transport; only 'stdio' is implemented",
    );
    return null;
  }

  const client = new McpClient(server);
  clients.set(serverId, client);
  try {
    await client.start();
    logger.info({ server: server.id }, "MCP client ready");
  } catch (err) {
    clients.delete(serverId);
    logger.error({ err, server: server.id }, "Failed to start MCP client");
    throw err;
  }
  return client;
}

function getClient(serverId) {
  return clients.get(serverId) ?? null;
}

function listClients() {
  return Array.from(clients.keys());
}

module.exports = {
  registerServer,
  listServers,
  getServer,
  clearServers,
  loadFromManifest,
  loadConfiguredServers,
  hasLoadedManifest,
  ensureClient,
  getClient,
  listClients,
};
