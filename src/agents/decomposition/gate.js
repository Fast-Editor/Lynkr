/**
 * Decomposition gate (Phase 1).
 *
 * Decides whether breaking a task into isolated-context subtasks is actually
 * worth it. This is the make-or-break of the feature: naive "decompose
 * everything" loses money, because every subagent carries fixed overhead
 * (planning + per-agent handoff/summarisation). Decomposition only pays off
 * when the task is (a) genuinely complex, (b) large enough to amortise that
 * overhead, and (c) divisible into reasonably independent units.
 *
 * Pure and synchronous so it can be unit-tested without a model. The caller
 * supplies a pre-computed complexity `analysis` (from routing/complexity-analyzer)
 * and the raw payload.
 */

const DEFAULTS = {
  minComplexity: 60, // 0-100; only decompose genuinely complex work
  minTokens: 3000, // estimated monolithic tokens; below this the overhead wins
  minIndependentUnits: 2, // need at least 2 separable pieces to bother
  maxSubtasks: 6,
};

const ENUMERATION_RE = /^\s*(?:[-*+]|\d+[.)]|step\s+\d+\b)/gim;
const CONJUNCTION_RE = /\b(?:and then|then|also|additionally|as well as|after that|finally|next,)\b/gi;
const IMPERATIVE_RE = /\b(?:add|create|build|implement|write|refactor|update|fix|remove|delete|migrate|test|document|configure|set up|wire|integrate|generate)\b/gi;
const FILE_PATH_RE = /\b[\w./-]+\.(?:js|ts|tsx|jsx|py|go|rs|java|rb|c|cpp|h|json|yaml|yml|md|sql|sh|css|html)\b/gi;

function _uniqueMatches(text, re) {
  const set = new Set();
  const matches = text.match(re) || [];
  for (const m of matches) set.add(m.toLowerCase().trim());
  return set;
}

/**
 * Heuristically estimate how many independent units a task contains.
 * Conservative: takes the strongest of several weak signals rather than summing
 * them, so a single rambling sentence doesn't look like five subtasks.
 * @param {string} text
 * @returns {number}
 */
function estimateIndependentUnits(text) {
  if (!text || typeof text !== "string") return 1;

  const enumerated = (text.match(ENUMERATION_RE) || []).length;
  const conjunctions = (text.match(CONJUNCTION_RE) || []).length;
  const imperatives = _uniqueMatches(text, IMPERATIVE_RE).size;
  const files = _uniqueMatches(text, FILE_PATH_RE).size;

  // Each signal is an independent lower-bound estimate of separable units.
  const signals = [
    enumerated, // explicit list items
    conjunctions + 1, // "do A and then B" → 2 units
    imperatives, // distinct action verbs
    files, // distinct files usually map to distinct work
  ];

  const estimate = Math.max(...signals, 1);
  return estimate;
}

/**
 * Decide whether to decompose.
 * @param {Object} analysis - result of analyzeComplexity(payload)
 * @param {Object} payload - the request payload
 * @param {Object} [options]
 * @param {Object} [options.config] - threshold overrides (see DEFAULTS)
 * @param {string} [options.riskLevel] - 'low'|'medium'|'high'; 'high' disables decomposition
 * @param {string} [options.taskText] - explicit task text (else derived from analysis/payload)
 * @returns {{ decompose: boolean, reason: string, signals: Object }}
 */
function shouldDecompose(analysis, payload = {}, options = {}) {
  const cfg = { ...DEFAULTS, ...(options.config || {}) };

  const score = Number(analysis?.score ?? 0);
  const estimatedTokens = Number(
    analysis?.breakdown?.tokens?.estimated ?? options.estimatedTokens ?? 0
  );

  const taskText =
    options.taskText ||
    analysis?.content ||
    _firstUserText(payload) ||
    "";

  const independentUnits = estimateIndependentUnits(taskText);

  const signals = {
    score,
    estimatedTokens,
    independentUnits,
    riskLevel: options.riskLevel || "low",
    thresholds: cfg,
  };

  // Never decompose high-risk work — keep it in one capable context where the
  // exempt-from-laziness concerns (validation/security) stay coherent.
  if (options.riskLevel === "high") {
    return { decompose: false, reason: "high_risk_skip", signals };
  }

  if (score < cfg.minComplexity) {
    return { decompose: false, reason: "below_complexity_threshold", signals };
  }

  if (estimatedTokens < cfg.minTokens) {
    return { decompose: false, reason: "too_small_to_amortise_overhead", signals };
  }

  if (independentUnits < cfg.minIndependentUnits) {
    return { decompose: false, reason: "not_divisible", signals };
  }

  return { decompose: true, reason: "decompose_worthwhile", signals };
}

function _firstUserText(payload) {
  const messages = payload?.messages;
  if (!Array.isArray(messages)) return "";
  const user = [...messages].reverse().find((m) => m.role === "user");
  if (!user) return "";
  if (typeof user.content === "string") return user.content;
  if (Array.isArray(user.content)) {
    return user.content
      .filter((b) => b?.type === "text" || typeof b?.text === "string")
      .map((b) => b.text || "")
      .join("\n");
  }
  return "";
}

module.exports = {
  shouldDecompose,
  estimateIndependentUnits,
  DEFAULTS,
};
