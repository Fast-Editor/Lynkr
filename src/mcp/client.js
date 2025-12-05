const { spawn } = require("child_process");
const readline = require("readline");
const EventEmitter = require("events");
const logger = require("../logger");

class McpClient extends EventEmitter {
  constructor(serverConfig) {
    super();
    if (!serverConfig || typeof serverConfig !== "object") {
      throw new Error("McpClient requires a server configuration object.");
    }
    this.server = serverConfig;
    this.process = null;
    this.readInterface = null;
    this.nextId = 1;
    this.pending = new Map();
    this.started = false;
    this.closed = false;
  }

  async start() {
    if (this.started) {
      return;
    }
    const command = this.server.command;
    if (!command) {
      throw new Error(`MCP server "${this.server.id}" is missing a command.`);
    }
    const args = Array.isArray(this.server.args) ? this.server.args : [];
    const env = {
      ...process.env,
      ...(this.server.env ?? {}),
    };

    logger.info(
      { server: this.server.id, command, args },
      "Starting MCP server",
    );

    this.process = spawn(command, args, {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.process.on("error", (err) => {
      logger.error({ err, server: this.server.id }, "Failed to start MCP server");
      this.close(err);
    });

    this.process.on("exit", (code, signal) => {
      logger.info({ server: this.server.id, code, signal }, "MCP server exited");
      this.close(new Error(`MCP server exited with code ${code ?? "null"} (${signal ?? "null"})`));
    });

    this.process.stderr.on("data", (chunk) => {
      const message = chunk.toString().trim();
      if (message) {
        logger.debug({ server: this.server.id, message }, "MCP server stderr");
      }
    });

    this.readInterface = readline.createInterface({
      input: this.process.stdout,
      crlfDelay: Infinity,
    });

    this.readInterface.on("line", (line) => {
      if (!line || !line.trim()) return;
      let message;
      try {
        message = JSON.parse(line);
      } catch (err) {
        logger.warn(
          { server: this.server.id, line: line.slice(0, 200), err },
          "Failed to parse MCP server message",
        );
        return;
      }
      this.handleMessage(message);
    });

    this.started = true;
    await this.initialize();
  }

  handleMessage(message) {
    if (message === null || typeof message !== "object") return;
    if (Object.prototype.hasOwnProperty.call(message, "id")) {
      const pending = this.pending.get(message.id);
      if (!pending) {
        logger.debug(
          { server: this.server.id, id: message.id },
          "Received response for unknown request",
        );
        return;
      }
      this.pending.delete(message.id);
      if (Object.prototype.hasOwnProperty.call(message, "error") && message.error) {
        pending.reject(normaliseError(message.error));
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    this.emit("notification", message);
  }

  async initialize() {
    try {
      await this.request("initialize", {
        capabilities: {},
        clientInfo: {
          name: "claude-code-proxy",
          version: "0.1.0",
        },
      });
    } catch (err) {
      logger.warn({ server: this.server.id, err }, "MCP server initialize failed");
    }
  }

  request(method, params = {}) {
    if (!this.started) {
      throw new Error(`MCP server "${this.server.id}" is not started.`);
    }
    if (this.closed) {
      throw new Error(`MCP server "${this.server.id}" connection is closed.`);
    }
    const id = this.nextId++;
    const payload = {
      jsonrpc: "2.0",
      id,
      method,
      params,
    };
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.process.stdin.write(`${JSON.stringify(payload)}\n`);
      } catch (err) {
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  notify(method, params = {}) {
    if (!this.started || this.closed) return;
    const payload = {
      jsonrpc: "2.0",
      method,
      params,
    };
    try {
      this.process.stdin.write(`${JSON.stringify(payload)}\n`);
    } catch (err) {
      logger.warn({ server: this.server.id, err }, "Failed to send MCP notification");
    }
  }

  async close(err) {
    if (this.closed) return;
    this.closed = true;
    if (this.readInterface) {
      this.readInterface.close();
      this.readInterface = null;
    }
    if (this.process) {
      try {
        this.process.kill("SIGTERM");
      } catch {
        // ignore
      }
      this.process = null;
    }
    this.pending.forEach(({ reject }) => {
      reject(err ?? new Error("MCP connection closed"));
    });
    this.pending.clear();
    this.emit("close", err ? normaliseError(err) : null);
  }
}

module.exports = McpClient;
function normaliseError(error) {
  if (error instanceof Error) return error;
  if (typeof error === "object" && error !== null) {
    const message =
      typeof error.message === "string" && error.message.length > 0
        ? error.message
        : "MCP request failed";
    const err = new Error(message);
    if (typeof error.name === "string" && error.name.length > 0) {
      err.name = error.name;
    }
    if (error.code !== undefined) err.code = error.code;
    if (error.data !== undefined) err.data = error.data;
    if (typeof error.stack === "string" && error.stack.length > 0) {
      err.stack = error.stack;
    }
    err.cause = error;
    return err;
  }
  return new Error(typeof error === "string" ? error : "MCP request failed");
}
