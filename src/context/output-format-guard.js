/**
 * Output Format Guard
 *
 * Appends a short formatting instruction to the system prompt so weaker
 * backends (Moonshot/Kimi, Ollama, etc.) stop emitting mangled ASCII/Unicode
 * box-drawing "diagrams" that render as garbage in clients. The actual backend
 * is decided by tier routing — so even when the client asks for "claude-opus",
 * the request may be served by a model that formats poorly. This normalizes the
 * presentation without changing which model serves the request.
 *
 * Always-on (no env flag). It is skipped only for Claude-family backends, which
 * already produce clean GitHub-flavored markdown — injecting there would just
 * waste tokens. The skip biases toward injecting: if we can't tell, we inject
 * (a false-inject is harmless ~50 tokens; a false-skip leaves the garble).
 *
 * Keyed off the ROUTING-RESOLVED provider/model, never the client's requested
 * body.model (which is just a label once tier routing is on).
 *
 * @module context/output-format-guard
 */

const logger = require("../logger");

const MARKER = "[fmt-guard]";

// Model names that already produce clean markdown.
const CLEAN_FORMATTER_RE = /\b(claude|sonnet|opus|haiku)\b/i;
// Providers that are always Claude-backed.
const CLEAN_PROVIDERS = new Set(["azure-anthropic"]);

const GUARD_TEXT =
  `${MARKER} Formatting rules for your response: use plain GitHub-flavored markdown only. ` +
  "Do NOT draw diagrams or boxes with ASCII or Unicode line-drawing characters " +
  "(such as ┌ ─ │ └ ├ ┤ ┬ ┴ ╔ ═ ║), and do NOT wrap headings or code in decorative borders. " +
  "Represent structure and relationships with normal markdown headings, nested bullet lists, " +
  "numbered lists, or tables. Use standard triple-backtick fenced code blocks for code. " +
  "Keep code, file paths, commands, and URLs exact.";

/**
 * Whether the resolved backend already formats cleanly (→ skip injection).
 * @param {string} provider - routing-resolved provider
 * @param {string} model - routing-resolved model (NOT the client's requested model)
 * @returns {boolean}
 */
function producesCleanMarkdown(provider, model) {
  if (CLEAN_PROVIDERS.has(String(provider || "").toLowerCase())) return true;
  if (model && CLEAN_FORMATTER_RE.test(String(model))) return true;
  return false;
}

/**
 * Append the guard text to a system prompt that may be a string or an array of
 * Anthropic content blocks. Idempotent via MARKER. Pure — returns the new value.
 */
function appendToSystem(system, text) {
  // String (or empty) system prompt.
  if (system == null || typeof system === "string") {
    const base = system || "";
    if (base.includes(MARKER)) return base;
    return base ? `${base}\n\n${text}` : text;
  }
  // Anthropic array-of-blocks system prompt.
  if (Array.isArray(system)) {
    const already = system.some(
      (b) => typeof b?.text === "string" && b.text.includes(MARKER)
    );
    if (already) return system;
    return [...system, { type: "text", text }];
  }
  return system;
}

/**
 * Inject the formatting guard into body.system in place, unless the resolved
 * backend already formats cleanly. Always-on; idempotent.
 *
 * @param {object} body - request body (mutated in place)
 * @param {object} [opts]
 * @param {string} [opts.provider] - routing-resolved provider
 * @param {string} [opts.model] - routing-resolved model
 * @returns {object} body
 */
function injectFormatGuard(body, opts = {}) {
  if (!body) return body;
  const { provider, model } = opts;
  if (producesCleanMarkdown(provider, model)) return body;

  body.system = appendToSystem(body.system, GUARD_TEXT);
  logger.debug({ provider, model }, "[FormatGuard] Injected markdown formatting guard");
  return body;
}

module.exports = {
  injectFormatGuard,
  producesCleanMarkdown,
  appendToSystem,
  MARKER,
  GUARD_TEXT,
};
