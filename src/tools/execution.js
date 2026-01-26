const path = require("path");
const { runProcess, MAX_TIMEOUT_MS, DEFAULT_TIMEOUT_MS } = require("./process");
const { registerTool } = require(".");
const { workspaceRoot, resolveWorkspacePath } = require("../workspace");

function parseTimeout(value) {
  if (value === undefined || value === null) return DEFAULT_TIMEOUT_MS;
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(parsed, MAX_TIMEOUT_MS);
}

function normaliseCwd(cwd, contextCwd) {
  // Priority: explicit cwd arg > context.cwd > workspaceRoot
  if (cwd) return resolveWorkspacePath(cwd);
  if (contextCwd) return contextCwd; // Already validated absolute path
  return workspaceRoot;
}

function parseSandboxMode(value) {
  if (typeof value !== "string") return "auto";
  const mode = value.trim().toLowerCase();
  if (mode === "always" || mode === "never" || mode === "auto") {
    return mode;
  }
  return "auto";
}

function formatProcessResult(result) {
  return JSON.stringify(
    {
      stdout: result.stdout,
      stderr: result.stderr,
      exit_code: result.exitCode,
      signal: result.signal,
      timed_out: result.timedOut,
      duration_ms: result.durationMs,
      stdout_overflow: result.stdoutOverflow,
      stderr_overflow: result.stderrOverflow,
    },
    null,
    2,
  );
}

function registerShellTool() {
  registerTool(
    "shell",
    async ({ args = {} }, context = {}) => {
      const command = args.command ?? args.cmd ?? args.run ?? args.input;
      const commandArgs = Array.isArray(args.args) ? args.args.map(String) : [];
      const cwd = normaliseCwd(args.cwd, context.cwd);
      const timeoutMs = parseTimeout(args.timeout_ms ?? args.timeout);

      let spawnCommand;
      let spawnArgs;
      let useShell = false;

      if (typeof command === "string" && command.trim().length > 0) {
        spawnCommand = "bash";
        spawnArgs = ["-lc", command];
        useShell = false;
      } else if (Array.isArray(command) && command.length > 0) {
        spawnCommand = String(command[0]);
        spawnArgs = command.slice(1).map(String).concat(commandArgs);
      } else if (
        typeof args.args === "string" &&
        args.args.trim().length > 0 &&
        !command
      ) {
        spawnCommand = "bash";
        spawnArgs = ["-lc", args.args];
      } else {
        throw new Error("shell tool requires a command string or array.");
      }

      const sandbox = parseSandboxMode(args.sandbox ?? args.isolation);

      const result = await runProcess({
        command: spawnCommand,
        args: spawnArgs,
        cwd,
        env: args.env,
        timeoutMs,
        shell: useShell,
        sandbox,
        sessionId: args.session_id ?? args.sessionId ?? null,
      });

      const ok = result.exitCode === 0 && !result.timedOut;
      const status = result.timedOut ? 408 : ok ? 200 : 500;

      return {
        ok,
        status,
        content: formatProcessResult(result),
        metadata: {
          command: spawnCommand,
          args: spawnArgs,
          cwd,
        },
      };
    },
    { category: "execution" },
  );
}

function registerPythonTool() {
  registerTool(
    "python_exec",
    async ({ args = {} }, context = {}) => {
      const code =
        typeof args.code === "string"
          ? args.code
          : typeof args.script === "string"
          ? args.script
          : typeof args.input === "string"
          ? args.input
          : null;

      if (!code) {
        throw new Error("python_exec requires a code string.");
      }

      const executable = args.executable ?? args.python ?? "python3";
      const cwd = normaliseCwd(args.cwd, context.cwd);
      const timeoutMs = parseTimeout(args.timeout_ms ?? args.timeout);
      const requirements = Array.isArray(args.requirements) ? args.requirements : [];

      // Basic support: write code to stdin; requirements handling is TODO.
      const sandbox = parseSandboxMode(args.sandbox ?? args.isolation);

      const result = await runProcess({
        command: executable,
        args: ["-"],
        cwd,
        env: args.env,
        timeoutMs,
        input: code,
        sandbox,
        sessionId: args.session_id ?? args.sessionId ?? null,
      });

      const ok = result.exitCode === 0 && !result.timedOut;
      const status = result.timedOut ? 408 : ok ? 200 : 500;

      return {
        ok,
        status,
        content: formatProcessResult(result),
        metadata: {
          executable: path.basename(executable),
          cwd,
          requirements,
        },
      };
    },
    { category: "execution" },
  );
}

function registerExecutionTools() {
  registerShellTool();
  registerPythonTool();
}

module.exports = {
  registerExecutionTools,
  registerShellTool,
  registerPythonTool,
};
