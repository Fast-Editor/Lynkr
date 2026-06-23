/**
 * Result synthesizer (Phase 4).
 *
 * Combines the (compressed) results of all subtasks into one coherent final
 * answer to the original task. Single model call. If synthesis fails, the
 * caller falls back to concatenating the subtask results.
 */

const { callModel, extractText } = require("./model-call");
const logger = require("../../logger");

const MAX_RESULT_CHARS = 4000;

function buildSynthesisPrompt(task, subtaskResults) {
  const blocks = subtaskResults
    .map((r) => {
      const status = r.success ? "OK" : `FAILED (${r.error})`;
      const body = r.success
        ? truncate(r.result, MAX_RESULT_CHARS)
        : "(no result)";
      return `### Subtask ${r.id} [${r.agentType}] — ${status}\n${body}`;
    })
    .join("\n\n");

  return `You are synthesizing the results of several subtasks into one final answer for the original request. Integrate the findings into a single coherent response. Resolve overlaps, note any subtask that failed, and do not invent results that no subtask produced.

ORIGINAL TASK:
${task}

SUBTASK RESULTS:
${blocks}

Write the final answer now.`;
}

function truncate(text, max) {
  if (typeof text !== "string") return String(text ?? "");
  return text.length <= max ? text : text.slice(0, max) + "\n…[truncated]";
}

/**
 * Concatenation fallback used when the synthesis model call fails.
 */
function concatFallback(subtaskResults) {
  return subtaskResults
    .filter((r) => r.success && r.result)
    .map((r) => `## ${r.id} (${r.agentType})\n${r.result}`)
    .join("\n\n");
}

/**
 * @param {Object} params
 * @param {string} params.task
 * @param {Array} params.subtaskResults - from dispatcher
 * @param {string} [params.model="sonnet"]
 * @param {Function} [params.invoke]
 * @returns {Promise<{text:string, fallback:boolean, usage:Object}>}
 */
async function synthesize({ task, subtaskResults, model = "sonnet", invoke } = {}) {
  const anySuccess = subtaskResults.some((r) => r.success);
  if (!anySuccess) {
    return { text: "All subtasks failed; no result could be produced.", fallback: true, usage: {} };
  }

  try {
    const responseJson = await callModel({
      messages: [{ role: "user", content: buildSynthesisPrompt(task, subtaskResults) }],
      model,
      maxTokens: 4096,
      temperature: 0.3,
      invoke,
    });
    const text = extractText(responseJson);
    if (!text) throw new Error("Empty synthesis");
    return {
      text,
      fallback: false,
      usage: {
        inputTokens: responseJson?.usage?.input_tokens || 0,
        outputTokens: responseJson?.usage?.output_tokens || 0,
      },
    };
  } catch (err) {
    logger.warn({ err: err.message }, "[Decomposition] Synthesis failed — concatenating results");
    return { text: concatFallback(subtaskResults), fallback: true, usage: {} };
  }
}

module.exports = { synthesize, buildSynthesisPrompt, concatFallback };
