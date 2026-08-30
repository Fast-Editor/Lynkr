#!/usr/bin/env node
/**
 * Install or remove the Lynkr profile for Claude Desktop's native
 * third-party inference mode (macOS only).
 *
 * Claude Desktop supports a "3p" deployment mode in which it sends its
 * Anthropic Messages API traffic to a local gateway instead of
 * api.anthropic.com. The mechanism (reverse-engineered from Ollama's
 * cmd/launch/claude_desktop.go, which uses the same route) is three JSON
 * files:
 *
 *   ~/Library/Application Support/Claude/claude_desktop_config.json
 *       deploymentMode: "1p" | "3p"
 *   ~/Library/Application Support/Claude-3p/claude_desktop_config.json
 *       deploymentMode again, for the third-party profile root
 *   ~/Library/Application Support/Claude-3p/configLibrary/_meta.json
 *       profile registry: { appliedId, entries: [{id, name}] }
 *   ~/Library/Application Support/Claude-3p/configLibrary/<uuid>.json
 *       the gateway profile itself (base URL, bearer key, display name)
 *
 * Usage:
 *   node scripts/claude-desktop.js --install [--url http://127.0.0.1:8081] [--key lynkr]
 *   node scripts/claude-desktop.js --restore
 *   node scripts/claude-desktop.js --status
 *
 * WARNING: this is undocumented Claude Desktop surface observed via
 * Ollama's public integration; a Desktop update may change the key names.
 * --restore (or `ollama launch claude-desktop --restore`) always brings
 * back the stock Anthropic profile by flipping deploymentMode to "1p".
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const PROFILE_ID = "00000000-0000-4000-8000-000000008081";
const PROFILE_NAME = "Lynkr";
const DEFAULT_URL = "http://127.0.0.1:8081";
const DEFAULT_KEY = "lynkr";

const appSupport = path.join(os.homedir(), "Library", "Application Support");
const PATHS = {
  normalConfig: path.join(appSupport, "Claude", "claude_desktop_config.json"),
  tpConfig: path.join(appSupport, "Claude-3p", "claude_desktop_config.json"),
  meta: path.join(appSupport, "Claude-3p", "configLibrary", "_meta.json"),
  profile: path.join(appSupport, "Claude-3p", "configLibrary", `${PROFILE_ID}.json`),
  backup: path.join(appSupport, "Claude-3p", "configLibrary", ".lynkr-backup.json"),
};

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return {};
    throw new Error(`Cannot parse ${file}: ${err.message}`);
  }
}

function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + "\n");
}

function setDeploymentMode(file, mode) {
  const cfg = readJson(file);
  cfg.deploymentMode = mode;
  writeJson(file, cfg);
}

function claudeDesktopRunning() {
  try {
    execFileSync("pgrep", ["-x", "Claude"], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

function install(opts) {
  if (!fs.existsSync(path.join(appSupport, "Claude"))) {
    fail("Claude Desktop does not appear to be installed (no ~/Library/Application Support/Claude).");
  }

  // First install: remember what we're replacing so --restore is faithful.
  if (!fs.existsSync(PATHS.backup)) {
    const meta = readJson(PATHS.meta);
    const normal = readJson(PATHS.normalConfig);
    writeJson(PATHS.backup, {
      previousAppliedId: meta.appliedId ?? null,
      previousDeploymentMode: normal.deploymentMode ?? "1p",
    });
  }

  // Profile: same keys Ollama's launcher writes, pointed at Lynkr.
  const profile = readJson(PATHS.profile);
  Object.assign(profile, {
    inferenceProvider: "gateway",
    inferenceGatewayBaseUrl: opts.url,
    inferenceGatewayApiKey: opts.key,
    inferenceGatewayAuthScheme: "bearer",
    deploymentDisplayName: PROFILE_NAME,
    chatTabEnabled: true,
    disableDeploymentModeChooser: true,
    coworkEgressAllowedHosts: ["*"],
    disableEssentialTelemetry: true,
    disableNonessentialTelemetry: true,
    autoModeEnabled: true,
  });
  delete profile.inferenceModels;
  writeJson(PATHS.profile, profile);

  // Registry: apply our profile, dedupe any stale entry for our id.
  const meta = readJson(PATHS.meta);
  meta.appliedId = PROFILE_ID;
  meta.entries = (Array.isArray(meta.entries) ? meta.entries : [])
    .filter((e) => !(e && e.id === PROFILE_ID))
    .concat([{ id: PROFILE_ID, name: PROFILE_NAME }]);
  writeJson(PATHS.meta, meta);

  setDeploymentMode(PATHS.normalConfig, "3p");
  setDeploymentMode(PATHS.tpConfig, "3p");

  console.log(`Claude Desktop profile changed to ${PROFILE_NAME}.`);
  console.log(`Gateway: ${opts.url} (bearer key: ${opts.key})`);
  console.log("To restore the usual Claude profile: node scripts/claude-desktop.js --restore");
  if (claudeDesktopRunning()) {
    console.log("\nClaude Desktop is running — quit and reopen it for the change to take effect.");
  }
  console.log("\nReminder: Lynkr must be running and restarted with the claude-desktop-gateway");
  console.log("models endpoint (src/api/claude-desktop-gateway.js) for model discovery to work.");
}

function restore() {
  const backup = readJson(PATHS.backup);

  setDeploymentMode(PATHS.normalConfig, backup.previousDeploymentMode || "1p");
  setDeploymentMode(PATHS.tpConfig, backup.previousDeploymentMode || "1p");

  const meta = readJson(PATHS.meta);
  meta.entries = (Array.isArray(meta.entries) ? meta.entries : []).filter(
    (e) => !(e && e.id === PROFILE_ID)
  );
  if (meta.appliedId === PROFILE_ID) {
    if (backup.previousAppliedId) meta.appliedId = backup.previousAppliedId;
    else delete meta.appliedId;
  }
  writeJson(PATHS.meta, meta);

  for (const file of [PATHS.profile, PATHS.backup]) {
    try {
      fs.unlinkSync(file);
    } catch (err) {
      if (err.code !== "ENOENT") {
        console.warn(`Couldn't remove ${file}: ${err.message}`);
      }
    }
  }

  console.log("Claude Desktop restored to the usual Claude profile.");
  if (claudeDesktopRunning()) {
    console.log("Claude Desktop is running — quit and reopen it for the change to take effect.");
  }
}

function status() {
  const normal = readJson(PATHS.normalConfig);
  const meta = readJson(PATHS.meta);
  const profile = readJson(PATHS.profile);
  const mode = normal.deploymentMode || "1p";
  const applied = meta.appliedId === PROFILE_ID;
  console.log(`deploymentMode: ${mode}`);
  console.log(`Lynkr profile installed: ${fs.existsSync(PATHS.profile)}`);
  console.log(`Lynkr profile applied: ${applied}`);
  if (profile.inferenceGatewayBaseUrl) {
    console.log(`gateway URL: ${profile.inferenceGatewayBaseUrl}`);
  }
  console.log(
    mode === "3p" && applied
      ? "\nClaude Desktop is routed through Lynkr."
      : "\nClaude Desktop is on the stock Anthropic profile."
  );
}

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

function main() {
  if (process.platform !== "darwin") {
    fail("Claude Desktop profile management is only supported on macOS (matching the upstream integration).");
  }
  const args = process.argv.slice(2);
  const getFlag = (name, fallback) => {
    const i = args.indexOf(name);
    return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
  };

  if (args.includes("--install")) {
    install({ url: getFlag("--url", DEFAULT_URL), key: getFlag("--key", DEFAULT_KEY) });
  } else if (args.includes("--restore")) {
    restore();
  } else if (args.includes("--status")) {
    status();
  } else {
    console.log("Usage: node scripts/claude-desktop.js --install [--url URL] [--key KEY] | --restore | --status");
    process.exit(args.length === 0 ? 0 : 1);
  }
}

main();
