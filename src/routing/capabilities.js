/**
 * Capability requirement vector (item 1: HyDRA port, phase 1).
 *
 * Maps the existing 15-dim weighted analysis (complexity-analyzer.js
 * calculateWeightedScore dimensions, each 0-100) onto 4 independent
 * capability heads in [0,1]:
 *
 *   - reasoning : multi-step / planning / tradeoff analysis load
 *   - codegen   : code-writing demand (generation + technical + tool depth)
 *   - debugging : diagnostic load (analysis + technical + domain breadth)
 *   - tool_use  : tool-orchestration load (count, complexity, chaining, history)
 *
 * Deliberately decoupled from the model catalog: this module never names a
 * provider/model/tier. Model capabilities live in
 * config/model-capabilities.json and matching lives in shortfall.js, so a
 * catalog change is a config edit with zero retraining.
 *
 * Deliberately excludes risk/agentic overrides: risk-high forces REASONING
 * and AUTONOMOUS sets a REASONING floor upstream (routing/index.js). Those
 * stay as deterministic post-passes (like HyDRA's health veto), not as
 * learned heads — keeping this predictor language- and catalog-invariant.
 * The agentic flag only floors tool_use (agentic work always needs tools),
 * it never lowers a requirement.
 *
 * Pure function, no I/O. Never throws: bad input yields the neutral prior
 * (all 0.2 ≈ trivial) so callers fail open to cheap routing.
 */

const HEADS = ['reasoning', 'codegen', 'debugging', 'tool_use'];

function _clamp01(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function _dim01(dimensions, name) {
  const v = Number(dimensions?.[name]);
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(1, v / 100));
}

/**
 * @param {object} args
 * @param {object} [args.dimensions] — calculateWeightedScore dimensions (0-100 each)
 * @param {object} [args.agenticResult] — { isAgentic } (floors tool_use only)
 * @returns {{ reasoning:number, codegen:number, debugging:number, tool_use:number }}
 */
function buildRequirementVector({ dimensions = {}, agenticResult = null } = {}) {
  try {
    const d = (name) => _dim01(dimensions, name);

    let reasoning = d('multiStepReasoning') * 0.4
      + d('analysisDepth') * 0.4
      + d('promptComplexity') * 0.2;

    let codegen = d('codeGeneration') * 0.5
      + d('technicalDepth') * 0.3
      + d('toolComplexity') * 0.2;

    let debugging = d('analysisDepth') * 0.3
      + d('technicalDepth') * 0.2
      + d('domainSpecificity') * 0.3
      + d('promptComplexity') * 0.2;

    let toolUse = d('toolCount') * 0.3
      + d('toolComplexity') * 0.3
      + d('toolChainPotential') * 0.2
      + d('priorToolUsage') * 0.2;

    // Agentic work always needs tool orchestration — floor only, never lower.
    if (agenticResult?.isAgentic) {
      toolUse = Math.max(toolUse, 0.6);
    }

    const round3 = (v) => Math.round(_clamp01(v) * 1000) / 1000;
    return {
      reasoning: round3(reasoning),
      codegen: round3(codegen),
      debugging: round3(debugging),
      tool_use: round3(toolUse),
    };
  } catch {
    return { reasoning: 0.2, codegen: 0.2, debugging: 0.2, tool_use: 0.2 };
  }
}

module.exports = { HEADS, buildRequirementVector };
