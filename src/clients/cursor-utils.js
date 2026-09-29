/**
 * Cursor CLI Format Conversion + Invocation Utilities.
 *
 * Mirrors `src/clients/codex-utils.js` / `invokeCodex` in
 * `src/clients/databricks.js`, but for the official `cursor-agent` CLI.
 *
 * Invocation model (reworked 2026-09-26 after the ETIMEDOUT incident):
 *   - async `execFile` — a slow CLI call must never block the proxy's event
 *     loop (the old `execFileSync` froze EVERY session for up to 120s per
 *     call, and a 3-candidate tier fallback froze it for 6 minutes).
 *   - prompt travels over STDIN, not argv — argv has an OS size ceiling and
 *     agentic payloads exceed it; stdin has none.
 *   - session resume: the CLI returns a `session_id`; subsequent turns of
 *     the same Lynkr session send `--resume <chatId>` with ONLY the newest
 *     user turn instead of re-flattening the whole conversation. This is
 *     what makes heavy agentic traffic viable (bounded payload per turn,
 *     CLI-side prompt cache reuse). A failed resume falls back to one
 *     fresh full-prompt attempt and re-seeds the session.
 *   - timeout scales with payload size (base + per-KB), hard-capped.
 *   - at most MAX_CONCURRENT_PROCS CLI processes run at once; extra calls
 *     queue (each spawn is a full Node worker).
 *   - a one-time background warmup absorbs the ~20s worker cold-start so
 *     the first real request doesn't pay it.
 *
 * Auth is inherited from the user's own login (`agent login` session or
 * `CURSOR_API_KEY` env) — Lynkr never reads Cursor's token store, it just
 * spawns the official binary with an inherited environment. Auth failures
 * are detected from CLI stderr and reported as such; a timeout is reported
 * as a timeout (the old code blamed every failure on the subscription).
 *
 * @module clients/cursor-utils
 */

const { execFile, execSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const logger = require("../logger");

const DEFAULT_MODEL = "composer-2.5";
const DEFAULT_BINARY = "cursor-agent";
// Timeout: base covers worker spin-up + small prompts; large payloads earn
// more, capped hard. Constants, not env knobs (house convention).
const BASE_TIMEOUT_MS = 120_000;
const PER_KB_TIMEOUT_MS = 250;
const MAX_TIMEOUT_MS = 600_000;
const DEFAULT_TIMEOUT_MS = BASE_TIMEOUT_MS; // kept for existing callers/tests
const MAX_BUFFER_BYTES = 32 * 1024 * 1024;
const MAX_CONCURRENT_PROCS = 2;
const SESSION_CACHE_MAX = 200;
const WARMUP_TIMEOUT_MS = 45_000;
// Operator decision 2026-09-27 ("No blocking shell"): auto-approve ALL agent
// permission requests — shell execution included — on both the ACP and
// one-shot paths. NOTE: with shell allowed, the sandbox cwd is a default
// directory, not a security boundary. CURSOR_AUTO_APPROVE=false restores the
// deny-mutations policy (MCPs-only approval, no --force).
const CURSOR_AUTO_APPROVE = process.env.CURSOR_AUTO_APPROVE?.trim().toLowerCase() !== "false";

/**
 * Resolve the binary to spawn. Test-overridable via env only —
 * no config import here (keeps this module require-cycle free;
 * databricks.js passes model/timeout in).
 */
function getBinaryPath(configCursor) {
  return configCursor?.binaryPath?.trim() || process.env.CURSOR_BINARY_PATH?.trim() || DEFAULT_BINARY;
}

/**
 * True when the `cursor-agent` binary exists on PATH. On the real path
 * (no injected which), a successful check also kicks the one-time
 * background warmup so the worker cold-start is paid before traffic.
 * @param {Function} [whichFn] - injectable for tests.
 */
function isAvailable(whichFn) {
  const run = whichFn || ((bin, opts) => require("node:child_process").execFileSync("which", [bin], opts));
  try {
    const binary = process.env.CURSOR_BINARY_PATH?.trim() || DEFAULT_BINARY;
    run(binary, { stdio: "ignore" });
    if (!whichFn) setImmediate(() => warmupCursorAgent().catch(() => {}));
    return true;
  } catch {
    return false;
  }
}

function extractText(message) {
  if (!message) return "";
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      if (block.type === "text") return block.text || "";
      if (block.type === "tool_result") {
        const result = typeof block.content === "string" ? block.content : JSON.stringify(block.content);
        return `[Tool Result: ${result}]`;
      }
      if (block.type === "tool_use") {
        return `[Tool Call: ${block.name}(${JSON.stringify(block.input)})]`;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

/**
 * Flatten Anthropic system + history into a single CLI prompt.
 * Same strategy as convertAnthropicToCodexPrompt (last user message is
 * the prompt, prior turns become context). Used for FRESH sessions;
 * resumed sessions send latestUserTurnPrompt instead.
 */
function convertAnthropicToCursorPrompt(body) {
  const systemContext = body.system || null;
  const messages = body.messages || [];
  if (messages.length === 0) return { prompt: "", systemContext };
  if (messages.length === 1 && messages[0].role === "user") {
    return { prompt: extractText(messages[0]), systemContext };
  }
  let lastUserIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "user") {
      lastUserIndex = i;
      break;
    }
  }
  if (lastUserIndex === -1) {
    return { prompt: extractText(messages[messages.length - 1]), systemContext };
  }
  const lastUserMessage = extractText(messages[lastUserIndex]);
  const priorMessages = messages.slice(0, lastUserIndex);
  if (priorMessages.length === 0) return { prompt: lastUserMessage, systemContext };
  const contextParts = priorMessages
    .map((m) => {
      const text = extractText(m);
      if (!text) return null;
      return `${m.role === "user" ? "User" : "Assistant"}: ${text}`;
    })
    .filter(Boolean);
  const conversationContext = contextParts.join("\n\n");
  return {
    prompt: conversationContext ? `Previous conversation:\n${conversationContext}\n\nUser: ${lastUserMessage}` : lastUserMessage,
    systemContext,
  };
}

/**
 * The newest user turn only — what a RESUMED CLI session receives (its own
 * transcript already holds the earlier turns).
 */
function latestUserTurnPrompt(body) {
  const messages = body?.messages || [];
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "user") return extractText(messages[i]);
  }
  return "";
}

/**
 * Stable per-conversation key for the resume cache: the caller's session id
 * when present, else a hash of the first message (stable across turns —
 * flattened prompts are NOT, their prefix changes shape after turn one).
 */
function deriveSessionKey(body) {
  if (body?._sessionId && typeof body._sessionId === "string") return `sid:${body._sessionId}`;
  const first = body?.messages?.[0];
  const text = first ? extractText(first) : "";
  if (!text) return null;
  return `msg1:${crypto.createHash("sha1").update(text).digest("hex").slice(0, 32)}`;
}

/**
 * Pull plain text out of `cursor-agent -p --output-format json` stdout.
 * Handles: {text|result|output|content|string}, stream-json event lines,
 * and falls back to the raw trimmed stdout.
 */
function extractCursorText(stdout) {
  const trimmed = String(stdout || "").trim();
  if (!trimmed) return "";
  try {
    const parsed = JSON.parse(trimmed);
    if (typeof parsed === "string") return parsed;
    for (const key of ["text", "result", "output", "content", "response", "message"]) {
      if (typeof parsed?.[key] === "string" && parsed[key].trim()) return parsed[key];
    }
    if (Array.isArray(parsed?.content)) {
      const t = parsed.content
        .map((b) => (typeof b === "string" ? b : b?.text || ""))
        .filter(Boolean)
        .join("\n");
      if (t.trim()) return t;
    }
    return trimmed;
  } catch {
    // Possibly stream-json (one JSON object per line) — collect assistant deltas.
    const lines = trimmed.split("\n");
    if (lines.length > 1) {
      const parts = [];
      for (const line of lines) {
        const l = line.trim();
        if (!l) continue;
        try {
          const ev = JSON.parse(l);
          const t =
            ev?.message?.content?.[0]?.text ||
            ev?.content?.[0]?.text ||
            (typeof ev?.text === "string" ? ev.text : "") ||
            (typeof ev?.delta === "string" ? ev.delta : "");
          if (t) parts.push(t);
        } catch {
          parts.push(l);
        }
      }
      if (parts.length) return parts.join("");
    }
    return trimmed;
  }
}

/**
 * Structured view of one CLI run: text, the session id (resume handle),
 * and token usage when the CLI reports it.
 */
function parseCursorResult(stdout) {
  const text = extractCursorText(stdout);
  let obj = null;
  const trimmed = String(stdout || "").trim();
  try {
    obj = JSON.parse(trimmed);
  } catch {
    const lines = trimmed.split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const candidate = JSON.parse(lines[i].trim());
        if (candidate && typeof candidate === "object") {
          obj = candidate;
          break;
        }
      } catch { /* keep walking back */ }
    }
  }
  const usage = obj?.usage && typeof obj.usage === "object"
    ? {
        inputTokens: Number(obj.usage.inputTokens) || 0,
        outputTokens: Number(obj.usage.outputTokens) || 0,
        cacheReadTokens: Number(obj.usage.cacheReadTokens) || 0,
        cacheWriteTokens: Number(obj.usage.cacheWriteTokens) || 0,
      }
    : null;
  return { text, sessionId: typeof obj?.session_id === "string" ? obj.session_id : null, usage };
}

function convertCursorResponseToAnthropic(text, model, usage = null, thinking = "") {
  const estimatedOutputTokens = Math.ceil(String(text || "").length / 4);
  const content = [];
  if (thinking) content.push({ type: "thinking", thinking });
  content.push({ type: "text", text: text || "" });
  return {
    id: `msg_cursor_${Date.now()}`,
    type: "message",
    role: "assistant",
    model: model || "cursor",
    content,
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: usage?.inputTokens || 0,
      output_tokens: usage?.outputTokens ?? estimatedOutputTokens,
      cache_creation_input_tokens: usage?.cacheWriteTokens || 0,
      cache_read_input_tokens: usage?.cacheReadTokens || 0,
    },
  };
}

/** Payload-scaled timeout: base + per-KB allowance, hard-capped. */
function scaleTimeoutMs(payloadBytes, baseMs) {
  const base = Number(baseMs) > 0 ? Number(baseMs) : BASE_TIMEOUT_MS;
  const scaled = base + Math.ceil((Number(payloadBytes) || 0) / 1024) * PER_KB_TIMEOUT_MS;
  return Math.min(MAX_TIMEOUT_MS, Math.max(base, scaled));
}

// --- concurrency gate (each spawn is a full Node worker) ---------------------
let _inFlight = 0;
const _waiters = [];
async function _acquire() {
  if (_inFlight < MAX_CONCURRENT_PROCS) {
    _inFlight++;
    return;
  }
  await new Promise((resolve) => _waiters.push(resolve));
  _inFlight++;
}
function _release() {
  _inFlight--;
  const next = _waiters.shift();
  if (next) next();
}

// --- resume cache: Lynkr session key → CLI session_id ------------------------
const _sessionCache = new Map();
function _sessionCacheSet(key, chatId) {
  if (!key || !chatId) return;
  if (_sessionCache.has(key)) _sessionCache.delete(key);
  _sessionCache.set(key, chatId);
  while (_sessionCache.size > SESSION_CACHE_MAX) {
    _sessionCache.delete(_sessionCache.keys().next().value);
  }
}

/**
 * Honest error classification: timeouts are timeouts, auth is auth, missing
 * binary is missing binary. The old code stamped every failure with the
 * subscription hint, which misdiagnosed a plain timeout in production.
 */
function classifyCursorError(err, { payloadBytes = 0, timeoutMs = 0 } = {}) {
  const raw = String(err?.message || err || "");
  const stderr = String(err?.stderr || "");
  let hint;
  if (/ENOENT|not found|no such file/i.test(raw)) {
    hint = "is `cursor-agent` installed? run `cursor-agent --version`; set CURSOR_BINARY_PATH if needed";
  } else if (/not (currently )?logged in|sign ?in|unauthoriz|401|no active subscription|login required/i.test(`${raw}\n${stderr}`)) {
    hint = "cursor-agent is not authenticated — run `cursor-agent login` and verify with `cursor-agent status`";
  } else if (err?.killed || err?.signal === "SIGKILL" || /ETIMEDOUT|timed? ?out/i.test(raw)) {
    hint = `timed out after ${Math.round(timeoutMs / 1000)}s with a ${Math.ceil(payloadBytes / 1024)}KB payload (worker cold-start or oversized turn)`;
  }
  const e = new Error(hint ? `${raw} (${hint})` : raw);
  e.cursorHint = hint || null;
  e.stderr = stderr;
  return e;
}

/**
 * The CLI is an AGENT with file tools, and a spawned child inherits the
 * server's cwd — which is the Lynkr repo itself. Without an explicit
 * workspace, every "review this project" routed here would read (and could
 * write, on approval) the server's own checkout, .env included (live
 * incident 2026-09-26). No workspace ⇒ empty sandbox dir, always.
 */
let _sandboxDir = null;
function getSandboxDir() {
  if (_sandboxDir) return _sandboxDir;
  const dir = path.join(os.tmpdir(), "lynkr-cursor-sandbox");
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* tmpdir exists */ }
  _sandboxDir = dir;
  return dir;
}

/** Default async exec: stdin transport, hard timeout, stderr captured. */
function _defaultExec({ binaryPath, args, stdin, timeoutMs, maxBuffer, cwd }) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      binaryPath,
      args,
      { timeout: timeoutMs, maxBuffer, encoding: "utf8", env: { ...process.env }, cwd: cwd || getSandboxDir(), killSignal: "SIGKILL" },
      (err, stdout, stderr) => {
        if (err) {
          err.stderr = String(stderr || "");
          reject(err);
          return;
        }
        resolve(String(stdout || ""));
      }
    );
    if (child.stdin) {
      child.stdin.on("error", () => {});
      child.stdin.end(stdin ?? "");
    }
  });
}

// --- ACP persistent channel (spawn-tax elimination, 2026-09-27) --------------
// `cursor-agent acp` is an official JSON-RPC-over-stdio server mode
// (cursor.com/docs/cli/acp): one long-lived process, one ndjson line per
// request, streaming updates, session load/resume, per-session set_model.
// Spike-measured: warm turns ~1.6s vs 6-9s per one-shot spawn. The one-shot
// `-p` path below is retained verbatim as the automatic fallback (and is
// still what injected execFn tests exercise).
const ACP_ENABLED = true; // kill switch: flip + redeploy (no env knobs)
const ACP_INIT_TIMEOUT_MS = 30_000;
const ACP_REQUEST_ID_BASE = 1;

class AcpClient {
  constructor({ binaryPath, cwd }) {
    this.binaryPath = binaryPath;
    this.cwd = cwd;
    this.child = null;
    this.buf = "";
    this.nextId = ACP_REQUEST_ID_BASE;
    this.pending = new Map();
    this.collectors = new Map(); // sessionId → {chunks:[]}
    this.knownSessions = new Set();
    this.toolCalls = new Map(); // toolCallId → {kind,title,command,path,start,announced,done}
    this.models = [];
    this.currentModel = new Map(); // sessionId → acpModelId
    this.dead = false;
    this.initPromise = null;
    this.promptQueue = Promise.resolve(); // serialize prompts per process
  }

  _spawn() {
    const { spawn } = require("node:child_process");
    this.child = spawn(this.binaryPath, ["acp"], { cwd: this.cwd, env: { ...process.env } });
    this.child.on("exit", (code) => {
      this.dead = true;
      for (const [, p] of this.pending) p.rej(new Error(`ACP process exited (${code})`));
      this.pending.clear();
      logger.warn({ code, cwd: this.cwd }, "[Cursor/ACP] server process exited");
    });
    this.child.stdin.on("error", () => {});
    this.child.stderr.on("data", () => {});
    this.child.stdout.on("data", (d) => this._onData(String(d)));
  }

  _onData(s) {
    this.buf += s;
    let nl;
    while ((nl = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, nl); this.buf = this.buf.slice(nl + 1);
      if (!line.trim()) continue;
      let msg; try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id); this.pending.delete(msg.id);
        if (msg.error) p.rej(new Error(`${p.method}: ${JSON.stringify(msg.error).slice(0, 200)}`));
        else p.res(msg.result);
      } else if (msg.method === "session/update") {
        const sid = msg.params?.sessionId;
        const u = msg.params?.update || {};
        const c = this.collectors.get(sid);
        if (!c) continue;
        try {
          if (u.sessionUpdate === "agent_message_chunk" && u.content?.text) {
            c.chunks.push(u.content.text);
            c.onChunk?.(u.content.text, "text");
          } else if (u.sessionUpdate === "agent_thought_chunk" && u.content?.text) {
            c.thoughts.push(u.content.text);
            c.onChunk?.(u.content.text, "thought");
          } else if (u.sessionUpdate === "tool_call" || u.sessionUpdate === "tool_call_update") {
            // Correlated narration (2026-09-27): the initial tool_call often
            // carries only a generic title; the real target (locations/
            // rawInput) arrives in enrichment updates, and status updates are
            // title-less. Merge everything per toolCallId and emit exactly
            // two meaningful lines per tool — "▶ verb: target" once running,
            // "✓/✗ verb: target (Ns)" on terminal. All else is swallowed.
            const id = u.toolCallId || "?";
            let entry = this.toolCalls.get(id);
            if (!entry) {
              entry = { kind: null, title: null, command: null, path: null, start: Date.now(), announced: false, done: false };
              this.toolCalls.set(id, entry);
              while (this.toolCalls.size > 200) this.toolCalls.delete(this.toolCalls.keys().next().value);
            }
            if (u.kind) entry.kind = u.kind;
            if (u.title) entry.title = u.title;
            if (u.rawInput?.command) entry.command = u.rawInput.command;
            const loc = u.locations?.[0]?.path || u.rawInput?.path;
            if (loc) entry.path = loc;

            const emit = (line) => {
              c.thoughts.push(`\n[${line}]`);
              c.onChunk?.(line, "tool");
            };
            const label = () => {
              const verb = { execute: "run", read: "read", edit: "edit", delete: "delete", move: "move", search: "search", fetch: "fetch", think: "think" }[entry.kind] || "tool";
              let target = entry.command || entry.path || String(entry.title || "").replace(/`/g, "").trim();
              if (target.startsWith(this.cwd)) target = target.slice(this.cwd.length + 1) || target;
              else if (target.startsWith("/") && target.split("/").length > 3) target = "…/" + target.split("/").slice(-2).join("/");
              const capped = target.slice(0, 80);
              return `${verb}: ${capped}` + (target.length > 80 ? "…" : "");
            };

            if (u.status === "in_progress" && !entry.announced && !entry.done) {
              entry.announced = true;
              emit(`▶ ${label()}`);
            } else if ((u.status === "completed" || u.status === "failed" || u.status === "cancelled") && !entry.done) {
              entry.done = true;
              const dur = ((Date.now() - entry.start) / 1000).toFixed(1);
              if (u.status === "completed") {
                emit(`✓ ${label()} (${dur}s)`);
              } else {
                const err = String(u.rawOutput?.stderr || "").trim().split("\n")[0].slice(0, 80);
                const code = u.rawOutput?.exitCode != null ? ` exit ${u.rawOutput.exitCode}` : "";
                emit(`✗ ${label()} (${dur}s)${code}${err ? " — " + err : ""}`);
              }
              this.toolCalls.delete(id);
            }
          }
        } catch { /* consumer errors must not kill the reader */ }
      } else if (msg.id !== undefined && msg.method === "session/request_permission") {
        const kind = msg.params?.toolCall?.kind || "";
        const options = msg.params?.options || [];
        let pick;
        if (CURSOR_AUTO_APPROVE) {
          // Allow everything (operator-approved yolo): prefer allow_always to
          // cut repeat prompts, fall back to any allow option.
          pick = options.find((o) => /allow_always/i.test(o.kind || o.optionId || ""))
            || options.find((o) => /allow/i.test(o.kind || o.optionId || ""));
        } else {
          const mutating = /edit|execute|delete|move|write/i.test(kind);
          pick = mutating
            ? options.find((o) => /reject/i.test(o.kind || o.optionId || ""))
            : options.find((o) => /allow/i.test(o.kind || o.optionId || ""));
        }
        const chosen = pick || options[0];
        this._write({ jsonrpc: "2.0", id: msg.id, result: { outcome: { outcome: "selected", optionId: chosen?.optionId } } });
      } else if (msg.id !== undefined && msg.method) {
        // Unsupported agent→client request (fs/* etc — we advertise no fs).
        this._write({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "unsupported by lynkr acp client" } });
      }
    }
  }

  _write(obj) {
    try { this.child.stdin.write(JSON.stringify(obj) + "\n"); } catch { /* exit handler rejects pendings */ }
  }

  _request(method, params, timeoutMs) {
    if (this.dead) return Promise.reject(new Error("ACP process dead"));
    return new Promise((res, rej) => {
      const id = this.nextId++;
      this.pending.set(id, { res, rej, method });
      this._write({ jsonrpc: "2.0", id, method, params });
      const cap = timeoutMs || ACP_INIT_TIMEOUT_MS;
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); rej(new Error(`${method} timed out after ${cap}ms`)); }
      }, cap).unref?.();
    });
  }

  async init() {
    if (this.initPromise) return this.initPromise;
    this.initPromise = (async () => {
      this._spawn();
      await this._request("initialize", {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
      });
    })();
    return this.initPromise;
  }

  /** Map a Lynkr/CLI-style id (composer-2.5-fast, grok-4.7-medium-fast) to
   *  the ACP catalog's bracketed id via longest base-name prefix match. */
  resolveModelId(tierModel) {
    if (!tierModel || tierModel === "auto") return null;
    let best = null;
    for (const m of this.models) {
      const base = String(m.modelId).split("[")[0];
      if (tierModel === base || tierModel.startsWith(base)) {
        if (!best || base.length > best.base.length) best = { base, id: m.modelId };
      }
    }
    return best ? best.id : null;
  }

  async newSession() {
    const r = await this._request("session/new", { cwd: this.cwd, mcpServers: [] });
    if (Array.isArray(r?.models?.availableModels)) this.models = r.models.availableModels;
    this.knownSessions.add(r.sessionId);
    return r.sessionId;
  }

  async ensureSession(sessionId) {
    if (this.knownSessions.has(sessionId)) return true;
    await this._request("session/load", { sessionId, cwd: this.cwd, mcpServers: [] }, ACP_INIT_TIMEOUT_MS);
    this.knownSessions.add(sessionId);
    return true;
  }

  async setModel(sessionId, tierModel) {
    const acpId = this.resolveModelId(tierModel);
    if (!acpId || this.currentModel.get(sessionId) === acpId) return;
    try {
      await this._request("session/set_model", { sessionId, modelId: acpId });
      this.currentModel.set(sessionId, acpId);
    } catch (err) {
      logger.debug({ tierModel, acpId, err: err.message }, "[Cursor/ACP] set_model failed — session default serves");
    }
  }

  prompt(sessionId, text, timeoutMs, onChunk) {
    // One prompt at a time per process — concurrency across sessions in a
    // single ACP server is unverified; the queue keeps ordering sane and
    // warm turns are ~1.6s so the wait is small.
    const run = this.promptQueue.then(async () => {
      const collector = { chunks: [], thoughts: [], onChunk };
      this.collectors.set(sessionId, collector);
      try {
        const r = await this._request("session/prompt", {
          sessionId,
          prompt: [{ type: "text", text }],
        }, timeoutMs);
        return { text: collector.chunks.join(""), thinking: collector.thoughts.join(""), stopReason: r?.stopReason || "end_turn" };
      } finally {
        this.collectors.delete(sessionId);
      }
    });
    this.promptQueue = run.catch(() => {});
    return run;
  }
}

// One warm server per cwd (model is per-session, so one process serves every
// tier). Sandbox cwd is the default — same invariant as the one-shot path.
const _acpClients = new Map();
async function _getAcpClient(binaryPath, cwd) {
  const key = `${binaryPath}\u0000${cwd}`;
  let client = _acpClients.get(key);
  if (client && !client.dead) return client;
  client = new AcpClient({ binaryPath, cwd });
  _acpClients.set(key, client);
  await client.init();
  return client;
}

/**
 * ACP-path serve. Same return contract as the one-shot path; throws on any
 * ACP-layer failure so runCursorAgent can fall back to the spawn path.
 */
async function _runViaAcp({ prompt, resumePrompt, sessionKey, model, baseTimeoutMs, binaryPath, workspace, onDelta }) {
  const cwd = workspace || getSandboxDir();
  const client = await _getAcpClient(binaryPath || DEFAULT_BINARY, cwd);
  const cached = sessionKey ? _sessionCache.get(sessionKey) : null;
  const cachedAcp = cached && typeof cached === "object" && cached.acp ? cached.acp : null;

  let sessionId = null;
  let resumed = false;
  let stdinText = prompt || "";
  if (cachedAcp && resumePrompt) {
    try {
      await client.ensureSession(cachedAcp);
      sessionId = cachedAcp;
      stdinText = resumePrompt;
      resumed = true;
    } catch { /* stale/unloadable — fall through to a fresh session */ }
  }
  if (!sessionId) {
    if (sessionKey) _sessionCache.delete(sessionKey);
    sessionId = await client.newSession();
  }
  await client.setModel(sessionId, model);
  const timeoutMs = scaleTimeoutMs(Buffer.byteLength(stdinText, "utf8"), baseTimeoutMs || BASE_TIMEOUT_MS);
  const t0 = Date.now();
  const { text, thinking, stopReason } = await client.prompt(sessionId, stdinText, timeoutMs, onDelta);
  if (sessionKey) _sessionCacheSet(sessionKey, { acp: sessionId });
  logger.debug({ resumed, model, ms: Date.now() - t0, stopReason }, "[Cursor/ACP] prompt served");
  return {
    stdout: JSON.stringify({ type: "result", subtype: "acp", result: text, session_id: sessionId }),
    text,
    thinking: thinking || "",
    sessionId,
    usage: null, // ACP updates carry no token usage — converter estimates
    resumed,
  };
}

let _warmupDone = false;
/**
 * One-time background warmup: absorbs the CLI worker's ~20s cold start so
 * the first real request doesn't spend its timeout budget on it.
 */
async function warmupCursorAgent(binaryPath) {
  if (_warmupDone) return;
  _warmupDone = true;
  const bin = binaryPath || getBinaryPath(null);
  try {
    if (ACP_ENABLED) {
      // Boot the persistent ACP server (pays the worker cold-start once).
      await _getAcpClient(bin, getSandboxDir());
      logger.debug("[Cursor] ACP server warm");
      return;
    }
    await _defaultExec({
      binaryPath: bin,
      args: ["-p", "--output-format", "json", "--model", DEFAULT_MODEL, "--trust", "--approve-mcps"],
      stdin: "Reply with OK.",
      timeoutMs: WARMUP_TIMEOUT_MS,
      cwd: getSandboxDir(),
      maxBuffer: MAX_BUFFER_BYTES,
    });
    logger.debug("[Cursor] warmup complete — worker hot");
  } catch (err) {
    logger.warn({ err: err.message }, "[Cursor] warmup failed (non-fatal) — first request will pay the cold start");
  }
}

/**
 * Spawn `cursor-agent -p` (async) and return the parsed run.
 *
 * @param {Object} args
 * @param {string} args.prompt - full flattened prompt (fresh sessions)
 * @param {string} [args.resumePrompt] - newest user turn (resumed sessions)
 * @param {string|null} [args.sessionKey] - stable conversation key (deriveSessionKey)
 * @param {string} args.model - Cursor model id
 * @param {number} [args.baseTimeoutMs] - base before payload scaling (legacy alias: timeoutMs)
 * @param {string} args.binaryPath
 * @param {string|null} args.workspace - passed as --workspace when set
 * @param {Function} [args.execFn] - injectable for tests: async ({binaryPath,args,stdin,timeoutMs,maxBuffer}) => stdout
 * @returns {Promise<{stdout:string, text:string, sessionId:string|null, usage:Object|null, resumed:boolean}>}
 */
async function runCursorAgent({ prompt, resumePrompt, sessionKey, model, baseTimeoutMs, timeoutMs, binaryPath, workspace, execFn, onDelta }) {
  const exec = execFn || _defaultExec;
  const base = baseTimeoutMs || timeoutMs || BASE_TIMEOUT_MS;
  // Persistent ACP channel first (real path only — injected execFn keeps the
  // one-shot contract for tests). Any ACP failure falls through to the
  // one-shot spawn below.
  if (ACP_ENABLED && !execFn) {
    try {
      return await _runViaAcp({ prompt, resumePrompt, sessionKey, model, baseTimeoutMs: base, binaryPath, workspace, onDelta });
    } catch (err) {
      logger.warn({ err: err.message }, "[Cursor/ACP] persistent channel failed — falling back to one-shot spawn");
    }
  }
  const cachedRaw = sessionKey ? _sessionCache.get(sessionKey) || null : null;
  // Legacy --resume takes a chat id STRING; ACP-era cache entries are
  // objects and must not leak into the spawn path.
  const cachedChat = typeof cachedRaw === "string" ? cachedRaw : null;
  const useResume = Boolean(cachedChat && resumePrompt);

  const buildArgs = (resumeChatId) => {
    const a = ["-p", "--output-format", "json"];
    if (model) a.push("--model", model);
    a.push("--trust");
    // Required for headless operation (no one can click approve): MCP servers
    // must be pre-approved via --approve-mcps or the run stalls on an
    // approval prompt until timeout. Shell/write approvals follow
    // CURSOR_AUTO_APPROVE — the operator made that call explicitly
    // (2026-09-27); it is not a silent default.
    a.push("--approve-mcps");
    if (CURSOR_AUTO_APPROVE) a.push("--force");
    if (workspace) a.push("--workspace", workspace);
    if (resumeChatId) a.push("--resume", resumeChatId);
    return a;
  };

  await _acquire();
  try {
    let stdout;
    let resumed = useResume;
    const firstStdin = useResume ? resumePrompt : prompt || "";
    const firstTimeout = scaleTimeoutMs(Buffer.byteLength(firstStdin, "utf8"), base);
    logger.debug(
      { binary: binaryPath, model, payloadBytes: Buffer.byteLength(firstStdin, "utf8"), resumed: useResume, timeoutMs: firstTimeout },
      "[Cursor] Spawning cursor-agent"
    );
    try {
      stdout = await exec({ binaryPath, args: buildArgs(useResume ? cachedChat : null), stdin: firstStdin, timeoutMs: firstTimeout, maxBuffer: MAX_BUFFER_BYTES, cwd: workspace || getSandboxDir() });
    } catch (err) {
      if (!useResume) throw classifyCursorError(err, { payloadBytes: Buffer.byteLength(firstStdin, "utf8"), timeoutMs: firstTimeout });
      // Stale/failed resume → drop the handle, retry once fresh with the
      // full flattened prompt so the conversation re-seeds.
      logger.warn({ sessionKey, err: err.message }, "[Cursor] resume failed — retrying fresh");
      _sessionCache.delete(sessionKey);
      resumed = false;
      const freshTimeout = scaleTimeoutMs(Buffer.byteLength(prompt || "", "utf8"), base);
      try {
        stdout = await exec({ binaryPath, args: buildArgs(null), stdin: prompt || "", timeoutMs: freshTimeout, maxBuffer: MAX_BUFFER_BYTES, cwd: workspace || getSandboxDir() });
      } catch (err2) {
        throw classifyCursorError(err2, { payloadBytes: Buffer.byteLength(prompt || "", "utf8"), timeoutMs: freshTimeout });
      }
    }
    const parsed = parseCursorResult(stdout);
    if (sessionKey && parsed.sessionId) _sessionCacheSet(sessionKey, parsed.sessionId);
    return { stdout, text: parsed.text, sessionId: parsed.sessionId, usage: parsed.usage, resumed };
  } finally {
    _release();
  }
}

module.exports = {
  DEFAULT_MODEL,
  DEFAULT_TIMEOUT_MS,
  BASE_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  MAX_CONCURRENT_PROCS,
  DEFAULT_BINARY,
  getBinaryPath,
  isAvailable,
  extractText,
  convertAnthropicToCursorPrompt,
  latestUserTurnPrompt,
  deriveSessionKey,
  extractCursorText,
  parseCursorResult,
  convertCursorResponseToAnthropic,
  scaleTimeoutMs,
  classifyCursorError,
  getSandboxDir,
  CURSOR_AUTO_APPROVE,
  warmupCursorAgent,
  runCursorAgent,
};
