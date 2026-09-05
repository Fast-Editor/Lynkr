#!/usr/bin/env node
/**
 * lynkr run <tool> — ensure the tool's Lynkr provider config is current,
 * then launch the tool.
 *
 * Differs from `lynkr wrap` on purpose: wrap intercepts a tool's traffic via
 * environment overrides at launch; `run` writes the tool's own native
 * provider config (so the tool works with Lynkr even when started normally
 * later) and then execs it. Config refresh on every run keeps the per-tier
 * context windows in sync with TIER_* changes.
 *
 * Usage:
 *   lynkr run opencode                    # refresh config, launch opencode
 *   lynkr run opencode --dry-run          # preview config, don't write or launch
 *   lynkr run opencode --path ./opencode.json --base-url http://host:8081
 *   lynkr run opencode -- --help          # everything after -- goes to opencode
 *
 * @module bin/run
 */

const { spawn } = require("child_process");

// Flags consumed by the setup step (with whether they take a value).
const SETUP_FLAGS = new Map([
  ["--dry-run", false],
  ["--path", true],
  ["--base-url", true],
]);

function splitArgs(args) {
  const setupArgs = [];
  const toolArgs = [];
  let passthrough = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (passthrough) {
      toolArgs.push(arg);
      continue;
    }
    if (arg === "--") {
      passthrough = true;
      continue;
    }
    if (SETUP_FLAGS.has(arg)) {
      setupArgs.push(arg);
      if (SETUP_FLAGS.get(arg) && i + 1 < args.length) setupArgs.push(args[++i]);
      continue;
    }
    toolArgs.push(arg);
  }
  return { setupArgs, toolArgs };
}

function runOpencode(args) {
  const { runSetup } = require("./opencode-setup");
  const { setupArgs, toolArgs } = splitArgs(args);
  const { dryRun } = runSetup(setupArgs) || {};
  if (dryRun) return;

  const child = spawn("opencode", toolArgs, { stdio: "inherit" });
  child.on("error", (err) => {
    if (err.code === "ENOENT") {
      console.error("\nConfig written, but the `opencode` binary was not found on PATH.");
      console.error("Install it (https://opencode.ai), then run `opencode` — the Lynkr provider is already configured.");
      process.exit(127);
    }
    console.error(`Failed to launch opencode: ${err.message}`);
    process.exit(1);
  });
  child.on("exit", (code, signal) => {
    process.exit(signal ? 1 : (code ?? 0));
  });
}

const TOOLS = { opencode: runOpencode };

function main() {
  const [tool, ...rest] = process.argv.slice(2);
  if (!tool || !Object.prototype.hasOwnProperty.call(TOOLS, tool)) {
    console.error(`Usage: lynkr run <tool> [options] [-- tool-args]`);
    console.error(`Supported tools: ${Object.keys(TOOLS).join(", ")}`);
    console.error(tool ? `Unknown tool '${tool}'.` : "");
    process.exit(tool ? 1 : 0);
  }
  TOOLS[tool](rest);
}

module.exports = { splitArgs, TOOLS };

if (require.main === module || process.env._LYNKR_SUBCMD === "run") {
  main();
}
