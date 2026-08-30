#!/usr/bin/env node
/**
 * `lynkr restart`
 *
 * Stop whatever's listening on Lynkr's configured port and start a fresh
 * `npm start`, detached so it survives this command exiting. Use this after
 * changing Lynkr's own code (routing, config, etc.) — it has nothing to do
 * with Claude Desktop's token or profile, which Desktop reads from disk at
 * its own launch time, independent of whether Lynkr's process restarts.
 * See `lynkr desktop-token` for that.
 *
 * Usage:
 *   lynkr restart
 */

const fs = require("fs");
const path = require("path");
const http = require("http");
const { execFileSync, spawn } = require("child_process");

const ROOT = path.join(__dirname, "..");
const ENV_PATH = path.join(ROOT, ".env");
const LOG_PATH = path.join(ROOT, "data", "logs", "lynkr-desktop.log");

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

function findListeningPid(port) {
  try {
    const out = execFileSync("lsof", ["-iTCP:" + port, "-sTCP:LISTEN", "-t"], {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    return out ? out.split("\n").map((s) => s.trim()).filter(Boolean) : [];
  } catch {
    return []; // lsof exits non-zero when nothing matches
  }
}

function healthCheck(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port, path: "/health", timeout: 1500 }, (res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => {
        try {
          resolve(res.statusCode === 200 && JSON.parse(body).status === "ok");
        } catch {
          resolve(false);
        }
      });
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function waitForHealth(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await healthCheck(port)) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

async function main() {
  if (process.argv[2] === "-h" || process.argv[2] === "--help") {
    console.log("Usage: lynkr restart");
    process.exit(0);
  }

  const port = readPort();
  const pids = findListeningPid(port);
  if (pids.length) {
    console.log(`Stopping existing Lynkr process (pid ${pids.join(", ")}) on port ${port}...`);
    for (const pid of pids) {
      try {
        process.kill(Number(pid), "SIGTERM");
      } catch (err) {
        console.warn(`  couldn't signal pid ${pid}: ${err.message}`);
      }
    }
    const freedByDeadline = Date.now() + 5000;
    while (Date.now() < freedByDeadline && findListeningPid(port).length) {
      await new Promise((r) => setTimeout(r, 250));
    }
  } else {
    console.log(`Nothing currently listening on port ${port}.`);
  }

  fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
  const logFd = fs.openSync(LOG_PATH, "a");
  console.log(`Starting Lynkr (npm start), logging to ${LOG_PATH}...`);
  const child = spawn("npm", ["start"], {
    cwd: ROOT,
    stdio: ["ignore", logFd, logFd],
    detached: true,
  });
  child.unref();

  const up = await waitForHealth(port, 15000);
  if (!up) {
    fail(`Lynkr didn't answer /health on port ${port} within 15s.\nCheck ${LOG_PATH} for errors.`);
  }
  console.log(`Lynkr is up on http://127.0.0.1:${port}.`);
}

main().catch((err) => fail(err.stack || String(err)));
