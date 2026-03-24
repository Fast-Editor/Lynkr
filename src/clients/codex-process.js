/**
 * Codex App-Server Process Manager
 *
 * Manages a persistent `codex app-server` child process that communicates
 * via JSON-RPC over stdio. Inherits the user's local ChatGPT subscription
 * auth, so no API key is needed.
 *
 * @module clients/codex-process
 */

const { spawn, execSync } = require("node:child_process");
const readline = require("node:readline");
const logger = require("../logger");
const config = require("../config");

const DEFAULT_TIMEOUT_MS = 120_000;

class CodexProcess {
  constructor() {
    this.child = null;
    this.pendingRequests = new Map(); // id -> { resolve, reject, timeout }
    this.nextId = 1;
    this.initialized = false;
    this.accountInfo = null;
    this.buffer = "";
    this.restartCount = 0;
    this._turnCollector = null; // active turn content collector
  }

  /**
   * Check if the codex binary is available on PATH
   */
  static isAvailable() {
    try {
      const binaryPath = config.codex?.binaryPath || "codex";
      execSync(`which ${binaryPath}`, { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Ensure the codex app-server process is running and initialized
   */
  async ensureRunning() {
    if (this.child && this.initialized) return;

    if (this.child) {
      // Process exists but not initialized — wait or restart
      this._killProcess();
    }

    const binaryPath = config.codex?.binaryPath || "codex";

    logger.info({ binaryPath, restart: this.restartCount }, "Spawning codex app-server");

    this.child = spawn(binaryPath, ["app-server"], {
      cwd: process.cwd(),
      env: { ...process.env },
      stdio: ["pipe", "pipe", "pipe"],
      shell: process.platform === "win32",
    });

    const rl = readline.createInterface({ input: this.child.stdout });
    rl.on("line", (line) => this._onLine(line));

    this.child.stderr.on("data", (data) => {
      const msg = data.toString().trim();
      if (msg) {
        logger.debug({ stderr: msg }, "[Codex] stderr");
      }
    });

    this.child.on("exit", (code, signal) => {
      logger.warn({ code, signal, restartCount: this.restartCount }, "[Codex] Process exited");
      this._rejectAllPending(new Error(`Codex process exited with code ${code}`));
      this.child = null;
      this.initialized = false;
      this.restartCount++;
    });

    this.child.on("error", (err) => {
      logger.error({ err: err.message }, "[Codex] Process error");
      this._rejectAllPending(err);
      this.child = null;
      this.initialized = false;
    });

    // Handshake
    await this.sendRequest("initialize", {
      protocolVersion: "2025-01-01",
      capabilities: {},
      clientInfo: { name: "lynkr", version: "1.0.0" },
    });

    this._sendNotification("initialized", {});

    // Read account info
    try {
      const accountResp = await this.sendRequest("account/read", {});
      this.accountInfo = this._parseAccount(accountResp);
      logger.info({
        type: this.accountInfo.type,
        planType: this.accountInfo.planType,
      }, "[Codex] Account info");
    } catch (err) {
      logger.warn({ err: err.message }, "[Codex] account/read failed");
      this.accountInfo = { type: "unknown", planType: null };
    }

    this.initialized = true;
    logger.info("[Codex] App-server initialized");
  }

  /**
   * Send a JSON-RPC request and wait for response
   */
  sendRequest(method, params, timeoutMs) {
    const timeout = timeoutMs || config.codex?.timeout || DEFAULT_TIMEOUT_MS;

    return new Promise((resolve, reject) => {
      if (!this.child) {
        reject(new Error("Codex process not running"));
        return;
      }

      const id = this.nextId++;
      const msg = JSON.stringify({ jsonrpc: "2.0", id, method, params });

      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Codex request "${method}" timed out after ${timeout}ms`));
      }, timeout);

      this.pendingRequests.set(id, { resolve, reject, timeout: timer, method });

      this.child.stdin.write(msg + "\n");
      logger.debug({ id, method }, "[Codex] Sent request");
    });
  }

  /**
   * Send a turn and collect all streaming content events
   * Returns the accumulated response text
   */
  async sendTurn(threadId, content, model) {
    return new Promise((resolve, reject) => {
      const collectedContent = [];
      let turnId = null;

      // Set up collector for streaming notifications
      this._turnCollector = {
        threadId,
        content: collectedContent,
        onComplete: (result) => {
          this._turnCollector = null;
          resolve({
            text: collectedContent.join(""),
            turnId,
            raw: result,
          });
        },
        onError: (err) => {
          this._turnCollector = null;
          reject(err);
        },
      };

      // Send the turn/start request
      const id = this.nextId++;
      const params = { threadId, content };
      if (model) params.model = model;

      const msg = JSON.stringify({ jsonrpc: "2.0", id, method: "turn/start", params });

      const timeout = config.codex?.timeout || DEFAULT_TIMEOUT_MS;
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        this._turnCollector = null;
        reject(new Error(`Codex turn timed out after ${timeout}ms`));
      }, timeout);

      this.pendingRequests.set(id, {
        resolve: (result) => {
          turnId = result?.turnId || null;
          // The collector's onComplete will be called by turn/completed notification
          // If no streaming, resolve immediately
          if (!this._turnCollector) {
            resolve({ text: collectedContent.join(""), turnId, raw: result });
          }
        },
        reject: (err) => {
          this._turnCollector = null;
          reject(err);
        },
        timeout: timer,
        method: "turn/start",
      });

      this.child.stdin.write(msg + "\n");
      logger.debug({ id, threadId }, "[Codex] Sent turn/start");
    });
  }

  /**
   * Handle a line from codex stdout
   */
  _onLine(line) {
    if (!line.trim()) return;

    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      logger.debug({ line: line.substring(0, 200) }, "[Codex] Non-JSON stdout");
      return;
    }

    // JSON-RPC response (has id)
    if (parsed.id !== undefined) {
      const pending = this.pendingRequests.get(parsed.id);
      if (pending) {
        clearTimeout(pending.timeout);
        this.pendingRequests.delete(parsed.id);

        if (parsed.error) {
          pending.reject(new Error(parsed.error.message || JSON.stringify(parsed.error)));
        } else {
          pending.resolve(parsed.result);
        }
      }
      return;
    }

    // JSON-RPC notification (no id) — streaming events
    const method = parsed.method;
    const params = parsed.params || {};

    if (method === "item/message/outputText/delta" && this._turnCollector) {
      const delta = params.delta || params.text || "";
      if (delta) {
        this._turnCollector.content.push(delta);
      }
    } else if (method === "item/message/outputText/done" && this._turnCollector) {
      const text = params.text || "";
      if (text && this._turnCollector.content.length === 0) {
        this._turnCollector.content.push(text);
      }
    } else if (method === "turn/completed" && this._turnCollector) {
      this._turnCollector.onComplete(params);
    } else if (method === "turn/error" && this._turnCollector) {
      this._turnCollector.onError(new Error(params.message || "Codex turn error"));
    } else {
      logger.debug({ method, params: JSON.stringify(params).substring(0, 200) }, "[Codex] Notification");
    }
  }

  /**
   * Send a JSON-RPC notification (no response expected)
   */
  _sendNotification(method, params) {
    if (!this.child) return;
    const msg = JSON.stringify({ jsonrpc: "2.0", method, params });
    this.child.stdin.write(msg + "\n");
  }

  /**
   * Parse account/read response
   */
  _parseAccount(response) {
    const account = response?.account || response || {};
    const type = account.type || "unknown";
    const planType = account.planType || null;
    return { type, planType };
  }

  /**
   * Reject all pending requests
   */
  _rejectAllPending(error) {
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pendingRequests.clear();

    if (this._turnCollector) {
      this._turnCollector.onError(error);
      this._turnCollector = null;
    }
  }

  /**
   * Kill the child process
   */
  _killProcess() {
    if (!this.child) return;
    try {
      if (process.platform === "win32") {
        execSync(`taskkill /pid ${this.child.pid} /T /F`, { stdio: "ignore" });
      } else {
        this.child.kill("SIGTERM");
      }
    } catch {
      try { this.child.kill("SIGKILL"); } catch { /* ignore */ }
    }
    this.child = null;
    this.initialized = false;
  }

  /**
   * Graceful shutdown
   */
  async shutdown() {
    logger.info("[Codex] Shutting down app-server");
    this._rejectAllPending(new Error("Codex shutting down"));
    this._killProcess();
  }

  /**
   * Get cached account info
   */
  getAccountInfo() {
    return this.accountInfo;
  }
}

// Singleton instance
let instance = null;

function getCodexProcess() {
  if (!instance) {
    instance = new CodexProcess();
  }
  return instance;
}

module.exports = {
  CodexProcess,
  getCodexProcess,
};
