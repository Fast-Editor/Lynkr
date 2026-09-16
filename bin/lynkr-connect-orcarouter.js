#!/usr/bin/env node
/**
 * `lynkr connect orcarouter` — OAuth 2.0 + PKCE (Flow B, out-of-band) login.
 *
 * Lynkr is self-hosted software whose install address differs on every
 * deployment (LAN box, NAS, moved port), so there is no predictable loopback
 * port to register — Flow B (out-of-band code) exists precisely for that
 * case. The command:
 *
 *   1. Generates a fresh PKCE verifier + CSRF state (crypto RNG, per attempt).
 *   2. Prints an authorize URL (callback_url=oob, S256 challenge) and opens
 *      it in the default browser when possible.
 *   3. Asks for the one-time code shown on the consent screen.
 *   4. Exchanges it at www.orcarouter.ai/api/v1/auth/keys for a durable
 *      OrcaRouter API key that belongs to the user.
 *   5. Persists the key to the project's .env (same secret location as every
 *      other Lynkr provider key) and prints the masked status.
 *
 * The verifier never leaves the process until the exchange; it never appears
 * in a URL, a log, or an error. Auth requests hit the auth origin
 * (www.orcarouter.ai) only; inference stays on api.orcarouter.ai/v1.
 *
 * Usage:
 *   lynkr connect orcarouter                  # interactive OOB code login
 *   lynkr connect orcarouter --code <code>   # non-interactive (CI / GUI)
 *   lynkr connect orcarouter --status        # masked status of stored key
 *   lynkr connect orcarouter --clear         # remove the stored key
 *
 * @module bin/lynkr-connect-orcarouter
 */

const path = require("path");
const fs = require("fs");
const readline = require("readline");
const { exec } = require("child_process");

const ROOT = path.join(__dirname, "..");
const ENV_PATH = path.join(ROOT, ".env");
const {
  connectWithPkce,
  getCredentialStore,
  createApiKeyAdapter,
  maskKey,
  resolveAuthBase,
  resolveApiBase,
} = require("../src/clients/orcarouter-credentials");

// ---------------------------------------------------------------------------
// .env persistence — the project's existing secret location. No new secret
// store is introduced. Keys are written as `ORCAROUTER_API_KEY=...` alongside
// the other provider keys; existing keys are updated in place.
// ---------------------------------------------------------------------------

function readEnvLines() {
  try {
    return fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, "utf8").split(/\r?\n/) : [];
  } catch {
    return [];
  }
}

function writeEnvLines(lines) {
  fs.writeFileSync(ENV_PATH, lines.join("\n") + "\n", { mode: 0o600 });
  // mode only applies on creation — tighten existing files explicitly so a
  // previously 0644 .env doesn't leave the new OAuth key world-readable.
  try {
    fs.chmodSync(ENV_PATH, 0o600);
  } catch {
    /* best-effort: e.g. read-only FS in CI */
  }
}

function readEnvKey(key) {
  try {
    const lines = readEnvLines();
    for (const line of lines) {
      const m = line.match(/^([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && m[1] === key) {
        const v = (m[2] || "").trim();
        return v || null;
      }
    }
  } catch {
    /* missing/unreadable .env → no file-backed value */
  }
  return null;
}

// File-backed env for status: process.env wins, .env file is the fallback so
// a key saved by a previous `connect` process is visible without re-export.
function statusEnv() {
  const env = { ...process.env };
  for (const k of ["ORCAROUTER_API_KEY", "ORCA_API_BASE_URL", "ORCA_AUTH_BASE_URL", "ORCA_BASE_URL"]) {
    if (!env[k]) {
      const v = readEnvKey(k);
      if (v) env[k] = v;
    }
  }
  return env;
}

function upsertEnvKey(key, value) {
  const lines = readEnvLines();
  let replaced = false;
  const out = lines.map((line) => {
    const m = line.match(/^([A-Z0-9_]+)\s*=/);
    if (m && m[1] === key) {
      replaced = true;
      return `${key}=${value}`;
    }
    return line;
  });
  if (!replaced) out.push(`${key}=${value}`);
  writeEnvLines(out);
}

function clearEnvKey(_key) {
  const lines = readEnvLines().filter((line) => !line.match(/^ORCAROUTER_API_KEY\s*=/));
  writeEnvLines(lines);
}

// (readEnvKey is intentionally not exported — the store's read() covers status.)

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function openBrowser(url) {
  const platform = process.platform;
  const cmd = platform === "darwin" ? "open" : platform === "win32" ? "start" : "xdg-open";
  exec(`"${cmd}" "${url}"`, () => {});
}

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) =>
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    })
  );
}

function fail(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

function status() {
  // Read through a file-backed store: a key saved to .env by either
  // connection path must show up in a later process without requiring export.
  const { OrcaCredentialStore } = require("../src/clients/orcarouter-credentials");
  const env = statusEnv();
  const store = new OrcaCredentialStore({
    env,
    loadSecret: () => env.ORCAROUTER_API_KEY || null,
  });
  const st = store.read();
  console.log(st.present
    ? `OrcaRouter credential: ${st.masked} (generation ${st.generation})${st.needsReauth ? " — needs reauthentication" : ""}`
    : "No OrcaRouter credential configured.");
  console.log(`  API base:  ${resolveApiBase(env)}`);
  console.log(`  Auth base: ${resolveAuthBase(env)}`);
}

async function runConnect(opts) {
  const store = getCredentialStore();

  // Adapter A: update/clear an API key directly through the seam too.
  if (opts.apiKey) {
    const adapter = createApiKeyAdapter(store, { env: process.env });
    const cred = adapter.set(opts.apiKey);
    upsertEnvKey("ORCAROUTER_API_KEY", cred.key);
    console.log(`✓ OrcaRouter API key saved (${maskKey(cred.key)}).`);
    return;
  }
  if (opts.clear) {
    store.clear();
    clearEnvKey("ORCAROUTER_API_KEY");
    console.log("✓ OrcaRouter credential cleared.");
    return;
  }
  if (opts.status) {
    status();
    return;
  }

  // PKCE connect. Generate verifier+state fresh; hand back the authorize URL.
  const started = await connectWithPkce({ appName: "Lynkr" });
  if (!started.ok) fail(started.error?.message || "Could not start OrcaRouter login");

  console.log("\n1. Open this URL in your browser (opening automatically…):");
  console.log(`   ${started.authorizeUrl}\n`);
  openBrowser(started.authorizeUrl);

  const code = opts.code || (await ask("2. Paste the one-time code from the consent screen: ")).trim();
  if (!code) fail("No code provided.");

  // Exchange the code for the durable key using the SAME verifier that
  // produced the challenge (PKCE binding — a fresh verifier would mismatch).
  const result = await connectWithPkce({ appName: "Lynkr", code, verifier: started.verifier, state: started.state });
  if (!result.ok) {
    fail(result.error?.message || `OrcaRouter exchange failed (HTTP ${result.error?.status || "?"})`);
  }
  upsertEnvKey("ORCAROUTER_API_KEY", result.credential.key);
  const scopeNote = result.credential.scope && result.credential.scope !== "api"
    ? ` (granted scope: ${result.credential.scope})`
    : "";
  console.log(`\n✓ Connected to OrcaRouter. Key saved to .env${scopeNote}.`);
  console.log(`  Masked: ${maskKey(result.credential.key)}`);
  console.log("  Revoke anytime at https://www.orcarouter.ai/console/authorized-apps");
}

function parseArgs(argv) {
  const opts = { apiKey: null, code: null, status: false, clear: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--status") opts.status = true;
    else if (a === "--clear") opts.clear = true;
    else if (a === "--api-key") opts.apiKey = argv[++i];
    else if (a === "--code") opts.code = argv[++i];
  }
  return opts;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log(`lynkr connect orcarouter — OAuth 2.0 + PKCE login for the OrcaRouter provider

Usage:
  lynkr connect orcarouter                  Interactive out-of-band code login
  lynkr connect orcarouter --code <code>    Non-interactive (paste the consent code)
  lynkr connect orcarouter --api-key <key>  Save an existing sk-orca-… API key
  lynkr connect orcarouter --status         Show masked credential status
  lynkr connect orcarouter --clear          Remove the stored credential`);
    return;
  }
  return runConnect(parseArgs(args));
}

if (require.main === module || process.env._LYNKR_SUBCMD === "connect") {
  main().catch((err) => fail(err.message));
}

module.exports = { runConnect, parseArgs, upsertEnvKey, clearEnvKey, readEnvKey, statusEnv, status };
