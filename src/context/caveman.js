/**
 * Caveman Terse-Output Injector
 *
 * Appends a brevity instruction to the system prompt so the model produces
 * terser responses, reducing OUTPUT tokens. Opt-in and off by default — it
 * changes model behavior, so it's only applied when explicitly enabled.
 *
 * Enable with CAVEMAN_ENABLED=true. Level via CAVEMAN_LEVEL=lite|full|ultra
 * (default: lite). Adapted from 9router's caveman injector / the caveman skill
 * (https://github.com/JuliusBrussee/caveman).
 *
 * @module context/caveman
 */

const config = require("../config");
const logger = require("../logger");

const LEVELS = ["lite", "full", "ultra"];

// Shared guardrails so brevity never corrupts the substance that matters.
const BOUNDARIES =
  "Code blocks, file paths, commands, errors, URLs: keep exact. " +
  "Security warnings, irreversible-action confirmations, and multi-step ordered " +
  "sequences: write in full normal prose. Resume terse style afterward.";

const EXAMPLES =
  'Not: "Sure! I\'d be happy to help. The issue is likely caused by..." ' +
  'Yes: "Bug in auth middleware. Token expiry uses `<` not `<=`. Fix:"';

const PERSISTENCE = "Apply this to every response unless a guardrail above applies.";

const PROMPTS = {
  lite: [
    "Respond tersely. Keep grammar and full sentences but drop filler, hedging, and pleasantries (just/really/basically/sure/of course/I'd be happy to).",
    "Pattern: state the thing, the action, the reason. Then the next step.",
    EXAMPLES,
    BOUNDARIES,
    PERSISTENCE,
  ].join(" "),

  full: [
    "Respond like a terse caveman. All technical substance stays exact; only fluff dies.",
    "Drop articles (a/an/the), filler (just/really/basically/actually/simply), pleasantries, and hedging. Fragments OK. Prefer short synonyms (big not extensive, fix not implement a solution for).",
    "Pattern: [thing] [action] [reason]. [next step].",
    EXAMPLES,
    BOUNDARIES,
    PERSISTENCE,
  ].join(" "),

  ultra: [
    "Respond ultra-terse. Maximum compression. Telegraphic.",
    "Abbreviate (DB/auth/config/req/res/fn/impl), strip conjunctions, use arrows for causality (X → Y). One word when one word is enough.",
    "Pattern: [thing] → [result]. [fix].",
    EXAMPLES,
    BOUNDARIES,
    PERSISTENCE,
  ].join(" "),
};

const MARKER = "[brevity]";

/** Resolve the configured level, falling back to "lite". */
function resolveLevel(level) {
  const l = String(level || config.caveman?.level || "lite").toLowerCase();
  return LEVELS.includes(l) ? l : "lite";
}

/**
 * Append the brevity instruction to a system prompt string.
 * Idempotent — won't double-inject if the marker is already present.
 *
 * @param {string} system - Existing system prompt (may be empty).
 * @param {object} [opts]
 * @param {boolean} [opts.enabled] - Override config enablement.
 * @param {string} [opts.level] - Override level.
 * @returns {string} system prompt, possibly with brevity instruction appended.
 */
function injectCaveman(system, opts = {}) {
  const enabled = opts.enabled ?? config.caveman?.enabled === true;
  if (!enabled) return system || "";

  const base = system || "";
  if (base.includes(MARKER)) return base;

  const level = resolveLevel(opts.level);
  const instruction = `\n\n${MARKER} ${PROMPTS[level]}`;
  logger.debug({ level }, "[Caveman] Injected brevity instruction into system prompt");
  return base + instruction;
}

module.exports = {
  injectCaveman,
  LEVELS,
};
