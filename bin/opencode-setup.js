#!/usr/bin/env node
/**
 * lynkr opencode — write the Lynkr provider into opencode's config with
 * HONEST per-tier context windows.
 *
 * The problem this solves: opencode's compaction triggers off ONE static
 * `limit.context` per model entry, but Lynkr's tier routing serves models
 * with different real windows (e.g. 128k / 200k / 1M). One blended number is
 * wrong for most requests: too big and opencode never compacts in time (the
 * conversation outgrows the served model and Lynkr's server-side compressor
 * has to amputate it mechanically); too small and big-window models are
 * wasted.
 *
 * The fix: one opencode model entry per tier, each carrying its tier's REAL
 * configured-model window (read live from this Lynkr install's TIER_* config
 * and model registry), plus a "lynkr-auto" entry floored at the MINIMUM
 * across tiers (safe for whatever routing picks). The per-tier ids
 * (lynkr-simple/medium/complex/reasoning) pin their tier server-side — see
 * src/routing/model-slots.js VIRTUAL_TIER_IDS — so the window each entry
 * advertises is the window that actually serves it. Picking a tier in
 * opencode's model picker doubles as tier pinning (documentation/
 * tier-pinning.md), and compaction budgets stay correct per model.
 *
 * Usage:
 *   lynkr opencode                       # merge into ~/.config/opencode/opencode.json
 *   lynkr opencode --path ./opencode.json  # project-scoped config instead
 *   lynkr opencode --base-url http://host:8081
 *   lynkr opencode --dry-run             # print the block, write nothing
 *
 * Merging is non-destructive: only the `provider.lynkr` block is replaced;
 * every other key in an existing opencode.json is preserved verbatim.
 *
 * @module bin/opencode-setup
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

const TIERS = ["SIMPLE", "MEDIUM", "COMPLEX", "REASONING"];

/**
 * Read each configured tier's model and its real context window.
 * @returns {{ tiers: Object<string, {provider: string, model: string, contextWindow: number|null}>, minWindow: number|null }}
 */
function readTierWindows() {
  const config = require("../src/config");
  const { contextWindowFor } = require("../src/routing/model-registry");
  const tiers = {};
  let minWindow = null;
  for (const tier of TIERS) {
    const raw = config.modelTiers?.[tier];
    if (!raw) continue;
    const [provider, ...rest] = raw.split(":");
    const model = rest.join(":") || null;
    const contextWindow = model ? contextWindowFor(model) : null;
    tiers[tier] = { provider, model, contextWindow };
    if (contextWindow && (!minWindow || contextWindow < minWindow)) {
      minWindow = contextWindow;
    }
  }
  return { tiers, minWindow };
}

// Conservative floor when no tier window is resolvable (fresh install,
// unpriced local models): matches the orchestrator's TOKEN_BUDGET_FALLBACK
// rationale — never advertise bigger than what's known safe.
const FALLBACK_WINDOW = 128000;

/**
 * Build the `provider.lynkr` block for opencode.json. Pure — exported for
 * tests.
 *
 * @param {{ tiers: Object, minWindow: number|null }} tierWindows
 * @param {{ baseURL: string, apiKey: string }} options
 * @returns {object} provider block
 */
function buildLynkrProvider(tierWindows, { baseURL, apiKey }) {
  const models = {
    "lynkr-auto": {
      name: "Lynkr Auto (tier routing)",
      limit: { context: tierWindows.minWindow || FALLBACK_WINDOW },
    },
  };
  for (const tier of TIERS) {
    const entry = tierWindows.tiers[tier];
    if (!entry?.model) continue;
    models[`lynkr-${tier.toLowerCase()}`] = {
      name: `Lynkr ${tier} (${entry.model})`,
      limit: { context: entry.contextWindow || tierWindows.minWindow || FALLBACK_WINDOW },
    };
  }
  return {
    npm: "@ai-sdk/anthropic",
    name: "Lynkr",
    options: {
      baseURL: `${baseURL.replace(/\/+$/, "")}/v1`,
      apiKey,
    },
    models,
  };
}

/**
 * Merge the Lynkr provider into an existing opencode config object without
 * touching anything else. Pure — exported for tests.
 */
function mergeOpencodeConfig(existing, lynkrProvider) {
  const merged = { ...(existing || {}) };
  merged.provider = { ...(merged.provider || {}), lynkr: lynkrProvider };
  return merged;
}

function defaultConfigPath() {
  return path.join(os.homedir(), ".config", "opencode", "opencode.json");
}

/**
 * Perform the setup. Exported so `lynkr run opencode` (bin/run.js) can
 * configure-then-launch. Returns { dryRun } so the caller knows whether to
 * proceed to launching.
 * @param {string[]} args - CLI-style flag list
 */
function runSetup(args) {
  const argValue = (flag) => {
    const i = args.indexOf(flag);
    return i !== -1 && i + 1 < args.length ? args[i + 1] : null;
  };
  const configPath = argValue("--path") || defaultConfigPath();
  const baseURL = argValue("--base-url")
    || `http://localhost:${process.env.PORT || 8081}`;
  const apiKey = process.env.LYNKR_API_KEY || "lynkr-local";
  const dryRun = args.includes("--dry-run");

  const tierWindows = readTierWindows();
  const provider = buildLynkrProvider(tierWindows, { baseURL, apiKey });

  console.log("Lynkr → opencode provider block (per-tier context windows):\n");
  for (const [id, m] of Object.entries(provider.models)) {
    console.log(`  ${id.padEnd(16)} limit.context=${String(m.limit.context).padStart(8)}  ${m.name}`);
  }
  const unresolved = TIERS.filter(
    (t) => tierWindows.tiers[t]?.model && !tierWindows.tiers[t]?.contextWindow
  );
  if (unresolved.length > 0) {
    console.warn(`\n⚠ No registry context window for tier model(s): ${unresolved
      .map((t) => `${t}=${tierWindows.tiers[t].model}`)
      .join(", ")} — floored conservatively. Add MODEL_PRICE_OVERRIDES entries (with a context field) to fix.`);
  }

  if (dryRun) {
    console.log(`\n--dry-run: would merge into ${configPath}`);
    console.log(JSON.stringify({ provider: { lynkr: provider } }, null, 2));
    return { dryRun: true };
  }

  let existing = {};
  if (fs.existsSync(configPath)) {
    try {
      existing = JSON.parse(fs.readFileSync(configPath, "utf8"));
    } catch (err) {
      console.error(`\nRefusing to overwrite ${configPath}: it exists but isn't valid JSON (${err.message}).`);
      console.error("Fix or move it, then re-run.");
      process.exit(1);
    }
  }

  const merged = mergeOpencodeConfig(existing, provider);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(merged, null, 2) + "\n");
  console.log(`\n✓ Merged provider.lynkr into ${configPath} (other keys preserved).`);
  return { dryRun: false };
}

module.exports = { buildLynkrProvider, mergeOpencodeConfig, readTierWindows, runSetup, FALLBACK_WINDOW };
