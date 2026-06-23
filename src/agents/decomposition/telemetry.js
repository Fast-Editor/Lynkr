/**
 * Decomposition telemetry + shadow mode (Phase 6).
 *
 * Appends one JSON line per decomposition decision to
 * data/decomposition-decisions.jsonl so the net token effect can be audited.
 * Because the research is clear that decomposition can COST more than it saves,
 * a shadow mode (TASK_DECOMPOSITION_SHADOW=true) runs the gate + records what it
 * WOULD have done without actually decomposing — so savings can be validated on
 * real traffic before enabling for real.
 */

const fs = require("fs");
const path = require("path");
const logger = require("../../logger");

const LOG_PATH = path.join(__dirname, "../../../data/decomposition-decisions.jsonl");

function estimateTokens(text) {
  if (typeof text !== "string") return 0;
  return Math.ceil(text.length / 4);
}

/**
 * Rough net-savings estimate.
 * monolithic ≈ what one big context would have cost (estimated input tokens).
 * decomposed ≈ planning + Σ(subagent in+out) + synthesis.
 * Positive `savedTokens` = decomposition was cheaper.
 */
function estimateSavings({ monolithicTokens, planUsage, dispatchStats, synthUsage }) {
  const decomposed =
    (planUsage?.inputTokens || 0) +
    (planUsage?.outputTokens || 0) +
    (dispatchStats?.inputTokens || 0) +
    (dispatchStats?.outputTokens || 0) +
    (synthUsage?.inputTokens || 0) +
    (synthUsage?.outputTokens || 0);
  return {
    monolithicTokens: monolithicTokens || 0,
    decomposedTokens: decomposed,
    savedTokens: (monolithicTokens || 0) - decomposed,
  };
}

function record(entry) {
  const line = { timestamp: Date.now(), ...entry };
  try {
    fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
    fs.appendFileSync(LOG_PATH, JSON.stringify(line) + "\n");
  } catch (err) {
    logger.debug({ err: err.message }, "[Decomposition] Telemetry append failed");
  }
  return line;
}

module.exports = { record, estimateSavings, estimateTokens, LOG_PATH };
