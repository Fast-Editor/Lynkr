#!/usr/bin/env node
/**
 * Native module ABI guard (postinstall).
 *
 * better-sqlite3 (and the other native optionalDependencies) are compiled
 * against a specific Node ABI. When Node is upgraded, the prebuilt/compiled
 * binary stops loading with:
 *
 *   "was compiled against a different Node.js version using
 *    NODE_MODULE_VERSION 115. This version of Node.js requires
 *    NODE_MODULE_VERSION 141."
 *
 * The failure is silent at runtime — telemetry, request logs, and the memory
 * store all sit behind try/catch and simply go empty. This probe detects the
 * mismatch and rebuilds the native modules so it self-heals on `npm install`.
 *
 * It is intentionally best-effort: it NEVER exits non-zero, so it can't break
 * `npm install` on machines without a build toolchain (the modules are
 * optional and the app degrades gracefully without them).
 */

const { execSync } = require("child_process");

// Native optionalDependencies that are ABI-sensitive. If Node changed, all of
// them are stale, so we rebuild the set in one pass.
const NATIVE_DEPS = [
  "better-sqlite3",
  "hnswlib-node",
  "tree-sitter",
  "tree-sitter-javascript",
  "tree-sitter-python",
  "tree-sitter-typescript",
];

function log(msg) {
  console.log(`[check-native] ${msg}`);
}

/**
 * Probe better-sqlite3 — the canary. `require()` alone is not enough: the
 * native addon only loads when a Database is instantiated.
 * @returns {"ok"|"absent"|"mismatch"}
 */
function probe() {
  let Database;
  try {
    Database = require("better-sqlite3");
  } catch (err) {
    if (err && err.code === "MODULE_NOT_FOUND") return "absent";
    return "mismatch";
  }
  try {
    const db = new Database(":memory:");
    db.close();
    return "ok";
  } catch (err) {
    if (/NODE_MODULE_VERSION|different Node\.js version|invalid ELF|dlopen|\.node/i.test(err.message || "")) {
      return "mismatch";
    }
    // Some other instantiation error — not an ABI issue we can fix by rebuild.
    return "ok";
  }
}

function main() {
  const status = probe();

  if (status === "absent") {
    // Optional dependency not installed (e.g. build skipped). Nothing to do.
    return;
  }
  if (status === "ok") {
    return;
  }

  log("native module ABI mismatch detected (Node was likely upgraded). Rebuilding native modules…");
  try {
    execSync(`npm rebuild ${NATIVE_DEPS.join(" ")}`, { stdio: "inherit" });
  } catch {
    log("rebuild did not complete (a build toolchain may be missing). Continuing — native features will be disabled until you run: npm rebuild better-sqlite3");
    return;
  }

  // Re-probe to report the outcome.
  if (probe() === "ok") {
    log("native modules rebuilt successfully.");
  } else {
    log("native modules still not loadable after rebuild. Run `npm rebuild better-sqlite3` manually.");
  }
}

try {
  main();
} catch (err) {
  // Never fail the install.
  log(`skipped (${err.message})`);
}
