/**
 * Thin model-call helper for the decomposition planner/synthesizer.
 *
 * Mirrors the provider-forcing logic in agents/executor.js so planning and
 * synthesis use the configured MODEL_PROVIDER rather than hard-falling back to
 * Azure. The actual invoker is injectable (`opts.invoke`) so the planner and
 * synthesizer can be unit-tested without a live provider.
 */

const logger = require("../../logger");

function resolveForceProvider(model) {
  const modelLower = String(model || "").toLowerCase();
  const isClaudeFamily =
    modelLower.includes("claude") ||
    modelLower.includes("sonnet") ||
    modelLower.includes("haiku") ||
    modelLower.includes("opus");
  const isGptFamily = modelLower.includes("gpt");

  if (isClaudeFamily || isGptFamily) {
    const config = require("../../config");
    return config.modelProvider?.type || config.modelProvider?.provider || null;
  }
  return null;
}

/**
 * Call the model and return the Anthropic-format response JSON.
 * @param {Object} params
 * @param {Array} params.messages
 * @param {string} params.model
 * @param {number} [params.maxTokens=2048]
 * @param {number} [params.temperature=0.2]
 * @param {Function} [params.invoke] - injectable invoker (default: clients/databricks.invokeModel)
 * @returns {Promise<Object>} Anthropic-format response JSON
 */
async function callModel({ messages, model, maxTokens = 2048, temperature = 0.2, invoke } = {}) {
  const invoker = invoke || require("../../clients/databricks").invokeModel;
  const payload = {
    model,
    messages,
    max_tokens: maxTokens,
    temperature,
  };
  const forceProvider = resolveForceProvider(model);

  const response = await invoker(payload, { forceProvider });
  if (!response || !response.json) {
    throw new Error("Invalid model response in decomposition model-call");
  }
  return response.json;
}

/**
 * Extract concatenated text from an Anthropic-format response.
 */
function extractText(responseJson) {
  const content = responseJson?.content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b) => b?.type === "text")
    .map((b) => b.text || "")
    .join("\n")
    .trim();
}

function sumUsage(responseJson) {
  return {
    inputTokens: responseJson?.usage?.input_tokens || 0,
    outputTokens: responseJson?.usage?.output_tokens || 0,
  };
}

module.exports = { callModel, extractText, sumUsage, resolveForceProvider, logger };
