#!/usr/bin/env node
/**
 * `lynkr desktop-token <token>` / `lynkr desktop-token --restore`
 *
 * Apply a freshly-minted Claude Pro/Max OAuth token to Claude Desktop's
 * Lynkr gateway profile — or restore Desktop back to talking to Anthropic
 * directly.
 *
 * This does NOT mint or refresh the token — that stays a manual, one-time
 * `claude setup-token` (interactive browser approval) every time it expires.
 * It does NOT restart Lynkr, either: the token lives entirely in Desktop's
 * own config file (read at Desktop's launch, not Lynkr's), and Lynkr just
 * forwards whatever bearer shows up on each request — it has no token state
 * of its own to refresh. Restarting only matters when Lynkr's own code
 * changed; use `lynkr restart` for that, separately.
 *
 * `lynkr desktop-token <token>`:
 *   1. Installs the token into the Desktop "3p" gateway profile
 *      (delegates to scripts/claude-desktop.js --install)
 *   2. Prints --status so you can see the profile actually took
 *
 * `lynkr desktop-token --restore`:
 *   Delegates to scripts/claude-desktop.js --restore — puts Desktop's
 *   deployment mode and applied-profile bookkeeping back to what they were
 *   before Lynkr's gateway profile was installed, and removes the profile
 *   + backup files. Safe to run even if nothing was ever installed (a
 *   no-op restore, not an error).
 *
 * Neither variant touches .env TIER_* values, and neither quits or
 * relaunches Claude Desktop itself (that would close your open chat
 * windows) — both just print the command to do so when you're ready.
 *
 * Usage:
 *   lynkr desktop-token sk-ant-oat01-...
 *   lynkr desktop-token --restore
 */

const path = require("path");
const fs = require("fs");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const ENV_PATH = path.join(ROOT, ".env");
const CLAUDE_DESKTOP_JS = path.join(ROOT, "scripts", "claude-desktop.js");

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

function readPort() {
  try {
    const env = fs.readFileSync(ENV_PATH, "utf8");
    const m = env.match(/^PORT=(\d+)/m);
    if (m) return Number(m[1]);
  } catch (err) {
    console.error(`Couldn't read PORT from ${ENV_PATH} (${err.message}) — defaulting to 8081.`);
  }
  return 8081;
}

function main() {
  const token = process.argv[2];
  if (!token || token === "-h" || token === "--help") {
    fail("Usage: lynkr desktop-token <sk-ant-oat-token> | --restore");
  }
  if (token === "--restore") {
    if (process.platform !== "darwin") {
      fail("Claude Desktop profile management is only supported on macOS.");
    }
    console.log("Restoring Claude Desktop to the usual Claude profile...");
    execFileSync("node", [CLAUDE_DESKTOP_JS, "--restore"], { stdio: "inherit" });
    console.log(
      "\nWhen you're ready (this would close your open chats if done automatically):" +
        "\n  killall Claude && open -a Claude"
    );
    return;
  }
  if (!token.startsWith("sk-ant-oat")) {
    fail(
      `That doesn't look like a Claude Code OAuth access token (expected it to start ` +
        `with "sk-ant-oat"). Got: ${token.slice(0, 12)}...\n` +
        `Mint one with: claude setup-token`
    );
  }
  if (process.platform !== "darwin") {
    fail("Claude Desktop profile management is only supported on macOS.");
  }

  const url = `http://127.0.0.1:${readPort()}`;

  console.log("Step 1/2 — installing token into Claude Desktop's Lynkr gateway profile...");
  execFileSync("node", [CLAUDE_DESKTOP_JS, "--install", "--url", url, "--key", token], {
    stdio: "inherit",
  });

  console.log("\nStep 2/2 — status:");
  execFileSync("node", [CLAUDE_DESKTOP_JS, "--status"], { stdio: "inherit" });

  console.log(
    "\nNext (manual, on purpose — this would close your open chats if done for you):" +
      "\n  killall Claude && open -a Claude" +
      "\n\nWhen Anthropic calls start 401ing: claude setup-token, then: lynkr desktop-token <token>" +
      "\nIf you've also changed Lynkr's own code, that's a separate step: lynkr restart"
  );
}

main();
