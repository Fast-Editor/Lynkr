const { spawn } = require("child_process");
const path = require("path");
const { workspaceRoot, resolveWorkspacePath } = require("../workspace");
const { isSandboxEnabled, runSandboxProcess } = require("../mcp/sandbox");

const DEFAULT_TIMEOUT_MS = 15000;
const MAX_TIMEOUT_MS = 900000;
const MAX_BUFFER_BYTES = 1024 * 1024; // 1MB

function sanitiseEnv(env = {}) {
  const output = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof key !== "string") continue;
    if (value === undefined || value === null) continue;
    output[key] = typeof value === "string" ? value : String(value);
  }
  return output;
}

function normaliseTimeout(timeoutMs) {
  if (!Number.isFinite(timeoutMs)) return DEFAULT_TIMEOUT_MS;
  if (timeoutMs <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(timeoutMs, MAX_TIMEOUT_MS);
}

function normaliseSandboxPreference(value) {
  switch (value) {
    case "always":
    case "never":
    case "auto":
      return value;
    default:
      return "never";
  }
}

async function runProcess({
  command,
  args = [],
  input,
  cwd,
  env,
  timeoutMs,
  maxBuffer = MAX_BUFFER_BYTES,
  shell = false,
  sandbox = "never",
  sessionId = null,
}) {
  if (!command || typeof command !== "string") {
    throw new Error("Command must be a non-empty string.");
  }
  // cwd can be:
  // 1. An already-resolved absolute path (from normaliseCwd in execution.js)
  // 2. A relative path that needs resolving against workspaceRoot
  // 3. null/undefined (use workspaceRoot)
  let resolvedCwd;
  if (cwd) {
    // If it's already an absolute path, use it directly
    // Otherwise resolve against workspaceRoot
    if (path.isAbsolute(cwd)) {
      resolvedCwd = cwd;
    } else {
      resolvedCwd = resolveWorkspacePath(cwd);
    }
  } else {
    resolvedCwd = workspaceRoot;
  }
  const mergedEnv = { ...process.env, ...sanitiseEnv(env) };
  const timeout = normaliseTimeout(timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const sandboxPreference = normaliseSandboxPreference(sandbox);

  if (sandboxPreference === "always" && !isSandboxEnabled()) {
    throw new Error("Sandbox execution requested but sandbox is not enabled.");
  }

  const shouldUseSandbox =
    sandboxPreference === "always" ||
    (sandboxPreference === "auto" && isSandboxEnabled());

  if (shouldUseSandbox) {
    return runSandboxProcess({
      sessionId,
      command,
      args,
      input,
      cwd: resolvedCwd,
      env: mergedEnv,
      timeoutMs: timeout,
      maxBuffer,
    });
  }

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: resolvedCwd,
      env: mergedEnv,
      shell,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let stdoutOverflow = false;
    let stderrOverflow = false;
    const start = Date.now();
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeout);

    const appendBuffer = (current, chunk) => {
      if (current.length >= maxBuffer) return { value: current, overflow: true };
      const next = current + chunk;
      if (next.length > maxBuffer) {
        return { value: next.slice(0, maxBuffer), overflow: true };
      }
      return { value: next, overflow: false };
    };

    child.stdout.on("data", (chunk) => {
      const { value, overflow } = appendBuffer(stdout, chunk.toString());
      stdout = value;
      if (overflow) stdoutOverflow = true;
    });

    child.stderr.on("data", (chunk) => {
      const { value, overflow } = appendBuffer(stderr, chunk.toString());
      stderr = value;
      if (overflow) stderrOverflow = true;
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });

    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({
        exitCode: code,
        signal,
        stdout,
        stderr,
        stdoutOverflow,
        stderrOverflow,
        timedOut,
        durationMs: Date.now() - start,
      });
    });

    if (typeof input === "string" && child.stdin.writable) {
      child.stdin.write(input);
      child.stdin.end();
    } else if (!input && child.stdin.writable) {
      child.stdin.end();
    }
  });
}

module.exports = {
  runProcess,
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  MAX_BUFFER_BYTES,
};
