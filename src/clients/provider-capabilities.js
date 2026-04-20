const config = require("../config");

const NATIVE_THINKING_PROVIDERS = new Set(["azure-anthropic", "databricks"]);

const NATIVE_THINKING_BEDROCK_MODELS = [
  "anthropic.claude",
  "claude-3",
  "claude-4",
  "claude-sonnet",
  "claude-opus",
  "claude-haiku",
];

const REASONING_CONTENT_PROVIDERS = new Set(["moonshot", "openrouter", "openai", "azure-openai"]);

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

module.exports = {
  supportsNativeThinking,
  supportsReasoningContent,
  getThinkingBehavior,
};
