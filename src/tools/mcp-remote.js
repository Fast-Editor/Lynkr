const { registerTool } = require(".");
const { listServers, ensureClient } = require("../mcp");
const config = require("../config");
const logger = require("../logger");

const REMOTE_TOOL_PREFIX = "mcp";

function sanitiseName(value) {
  return String(value)
    .replace(/[^A-Za-z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
}

async function registerRemoteTools() {
  // Code Mode: register 4 meta-tools instead of individual remote tools
  if (config.mcp?.codeMode?.enabled) {
    const { registerCodeModeTools } = require("./code-mode");
    registerCodeModeTools();
    return;
  }
  const servers = listServers();
  await Promise.all(
    servers.map(async (server) => {
      try {
        const client = await ensureClient(server.id);
        if (!client) return;

        let result;
        try {
          result = await client.request("tools/list", {});
        } catch (err) {
          logger.warn(
            { err, server: server.id },
            "MCP server did not respond to tools/list",
          );
          return;
        }

        const tools = Array.isArray(result?.tools) ? result.tools : [];
        tools.forEach((tool) => {
          if (!tool || typeof tool !== "object") return;
          const remoteName = tool.name ?? tool.method;
          if (!remoteName) return;
          const localName = `${REMOTE_TOOL_PREFIX}_${sanitiseName(server.id)}_${sanitiseName(remoteName)}`;
          const descriptionParts = [];
          if (server.name) descriptionParts.push(`[${server.name}]`);
          if (tool.description) descriptionParts.push(tool.description);
          const description = descriptionParts.join(" ");
          const method = tool.method ?? tool.name;

          registerTool(
            localName,
            async ({ args = {} }) => {
              const payload =
                typeof args === "object" && args !== null ? args : {};
              const response = await client.request(method, payload);
              return {
                ok: true,
                status: 200,
                content: JSON.stringify(
                  {
                    server: server.id,
                    tool: remoteName,
                    result: response,
                  },
                  null,
                  2,
                ),
                metadata: {
                  server: server.id,
                  tool: remoteName,
                },
              };
            },
            { category: "mcp", description },
          );
        });
      } catch (err) {
        logger.warn({ err, server: server.id }, "Failed to register MCP remote tools");
      }
    }),
  );
}

module.exports = {
  registerRemoteTools,
};
