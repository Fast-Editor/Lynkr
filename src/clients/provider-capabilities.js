const NATIVE_THINKING_PROVIDERS = new Set(["azure-anthropic", "databricks"]);

const NATIVE_THINKING_BEDROCK_MODELS = [
  "anthropic.claude",
  "claude-3",
  "claude-4",
  "claude-sonnet",
  "claude-opus",
  "claude-haiku",
];

const REASONING_CONTENT_PROVIDERS = new Set(["moonshot", "openrouter", "edenai", "openai", "azure-openai", "atlas"]);

function supportsNativeThinking(providerType, model) {
  if (NATIVE_THINKING_PROVIDERS.has(providerType)) return true;
  if (providerType === "bedrock" && model) {
    return NATIVE_THINKING_BEDROCK_MODELS.some((prefix) => model.toLowerCase().includes(prefix));
  }
  if (providerType === "vertex" && model) {
    return model.toLowerCase().includes("claude");
  }
  return false;
}

function supportsReasoningContent(providerType) {
  return REASONING_CONTENT_PROVIDERS.has(providerType);
}

function getThinkingBehavior(providerType, model) {
  if (supportsNativeThinking(providerType, model)) return "native";
  if (supportsReasoningContent(providerType)) return "reasoning_content";
  return "none";
}

/**
 * Anthropic-shaped `thinking` request param to send upstream, honoring an
 * explicit client request and otherwise defaulting to disabled.
 *
 * Confirmed live (2026-08-27) against both endpoints directly: Baidu
 * Qianfan's `glm-5.2` and Moonshot's Kimi (`kimi-k3`) both emit verbose
 * `reasoning_content` on EVERY call by default, sharing the same token
 * budget as the visible answer — with no instruction at all, a baseline
 * call to either returned ~500-600 chars of reasoning_content, an EMPTY
 * `content`, and `finish_reason:"length"` (the whole max_tokens budget
 * spent on reasoning, none left for the actual answer). The GLM/Qwen
 * convention `enable_thinking:false` does NOT suppress this on either
 * endpoint — only this Anthropic-shaped `{type:"disabled"}` param does
 * (also confirmed live, on both). Not a caveman-specific issue — the same
 * budget waste happens on every request to these two providers; caveman's
 * elaborate constraint set just makes it worse, since the model has more to
 * visibly deliberate against.
 *
 * @param {Object} body - incoming Anthropic-format request body
 * @returns {Object} the `thinking` param to send upstream
 */
function resolveThinkingParam(body) {
  if (body?.thinking && typeof body.thinking === "object") return body.thinking;
  return { type: "disabled" };
}

module.exports = {
  supportsNativeThinking,
  supportsReasoningContent,
  getThinkingBehavior,
  resolveThinkingParam,
};
