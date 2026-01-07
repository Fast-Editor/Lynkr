/**
 * AWS Bedrock Model Format Utilities
 *
 * Handles format conversion between Anthropic format and various Bedrock model families.
 * Supports: Claude, Titan, Llama, Jurassic, Cohere, Mistral
 *
 * @module clients/bedrock-utils
 */

const logger = require("../logger");

/**
 * Convert Anthropic messages array to a simple text prompt
 * @param {Array} messages - Anthropic messages array
 * @returns {string} Combined prompt text
 */
function messagesToPrompt(messages) {
  return messages
    .map((msg) => {
      const role = msg.role === "user" ? "Human" : "Assistant";
      let content = "";

      if (typeof msg.content === "string") {
        content = msg.content;
      } else if (Array.isArray(msg.content)) {
        content = msg.content
          .filter((block) => block.type === "text")
          .map((block) => block.text)
          .join("\n");
      }

      return `${role}: ${content}`;
    })
    .join("\n\n");
}

/**
 * Detect which model family a Bedrock model ID belongs to
 * @param {string} modelId - AWS Bedrock model ID or inference profile ID
 *   Examples: "anthropic.claude-3-5-sonnet-20241022-v2:0", "us.deepseek.r1-v1:0", "qwen.qwen3-235b-v1:0"
 * @returns {string} Model family identifier
 */
function detectModelFamily(modelId) {
  // Handle inference profiles (e.g., "global.anthropic.claude-..." or "us.deepseek.r1-...")
  if (modelId.includes(".anthropic.claude")) return "claude";
  if (modelId.includes(".amazon.titan")) return "titan";
  if (modelId.includes(".amazon.nova")) return "nova";
  if (modelId.includes(".meta.llama")) return "llama";
  if (modelId.includes(".ai21.jamba")) return "jamba";
  if (modelId.includes(".cohere.command")) return "cohere";
  if (modelId.includes(".mistral")) return "mistral";
  if (modelId.includes(".deepseek")) return "deepseek";
  if (modelId.includes(".qwen")) return "qwen";
  if (modelId.includes(".openai")) return "openai";
  if (modelId.includes(".google.gemma")) return "gemma";
  if (modelId.includes(".minimax")) return "minimax";
  if (modelId.includes(".writer")) return "writer";
  if (modelId.includes(".kimi")) return "kimi";
  if (modelId.includes(".luma")) return "luma";
  if (modelId.includes(".twelvelabs")) return "twelvelabs";

  // Handle direct model IDs (standard format)
  if (modelId.startsWith("anthropic.claude")) return "claude";
  if (modelId.startsWith("amazon.titan")) return "titan";
  if (modelId.startsWith("amazon.nova")) return "nova";
  if (modelId.startsWith("meta.llama")) return "llama";
  if (modelId.startsWith("ai21.j2")) return "jurassic";
  if (modelId.startsWith("ai21.jamba")) return "jamba";
  if (modelId.startsWith("cohere.command")) return "cohere";
  if (modelId.startsWith("mistral.")) return "mistral";
  if (modelId.startsWith("deepseek.")) return "deepseek";
  if (modelId.startsWith("qwen.")) return "qwen";
  if (modelId.startsWith("openai.")) return "openai";
  if (modelId.startsWith("google.gemma")) return "gemma";
  if (modelId.startsWith("minimax.")) return "minimax";
  if (modelId.startsWith("writer.")) return "writer";
  if (modelId.startsWith("kimi.")) return "kimi";
  if (modelId.startsWith("luma.")) return "luma";
  if (modelId.startsWith("twelvelabs.")) return "twelvelabs";

  // If we can't detect, assume it works with Converse API (Bedrock's unified API)
  logger.info({ modelId }, "Unknown Bedrock model family - assuming Converse API compatibility");
  return "converse";
}

/**
 * Convert Anthropic format request to Bedrock-specific format
 * @param {Object} body - Request body in Anthropic format
 * @param {string} modelFamily - Model family from detectModelFamily()
 * @returns {Object} Request body in Bedrock model-specific format
 */
function convertAnthropicToBedrockFormat(body, modelFamily) {
  switch (modelFamily) {
    case "claude":
      // Claude models use native Anthropic Messages API format
      // Only need to add anthropic_version field for Bedrock
      return {
        anthropic_version: "bedrock-2023-05-31",
        max_tokens: body.max_tokens || 4096,
        messages: body.messages,
        system: body.system,
        temperature: body.temperature,
        top_p: body.top_p,
        tools: body.tools,
      };

    case "titan":
      // Amazon Titan format
      return {
        inputText: messagesToPrompt(body.messages),
        textGenerationConfig: {
          maxTokenCount: body.max_tokens || 4096,
          temperature: body.temperature || 0.7,
          topP: body.top_p || 1.0,
          stopSequences: [],
        },
      };

    case "llama":
      // Meta Llama format
      const llamaPrompt = messagesToPrompt(body.messages);
      return {
        prompt: llamaPrompt,
        max_gen_len: body.max_tokens || 2048,
        temperature: body.temperature || 0.7,
        top_p: body.top_p || 0.9,
      };

    case "jurassic":
      // AI21 Jurassic format
      return {
        prompt: messagesToPrompt(body.messages),
        maxTokens: body.max_tokens || 200,
        temperature: body.temperature || 0.7,
        topP: body.top_p || 1,
        stopSequences: [],
        countPenalty: {
          scale: 0,
        },
        presencePenalty: {
          scale: 0,
        },
        frequencyPenalty: {
          scale: 0,
        },
      };

    case "cohere":
      // Cohere Command format
      return {
        prompt: messagesToPrompt(body.messages),
        max_tokens: body.max_tokens || 400,
        temperature: body.temperature || 0.75,
        p: body.top_p || 1.0,
        k: 0,
        stop_sequences: [],
        return_likelihoods: "NONE",
      };

    case "mistral":
      // Mistral format (similar to OpenAI)
      return {
        prompt: messagesToPrompt(body.messages),
        max_tokens: body.max_tokens || 2048,
        temperature: body.temperature || 0.7,
        top_p: body.top_p || 1.0,
        stop: [],
      };

    default:
      throw new Error(`Unsupported model family: ${modelFamily}`);
  }
}

/**
 * Convert Bedrock response to Anthropic format
 * @param {Object} response - Raw response from Bedrock model
 * @param {string} modelFamily - Model family from detectModelFamily()
 * @param {string} modelId - Full Bedrock model ID
 * @returns {Object} Response in Anthropic format
 */
function convertBedrockResponseToAnthropic(response, modelFamily, modelId) {
  switch (modelFamily) {
    case "claude":
      // Claude models return native Anthropic format
      // No conversion needed - pass through directly
      return response;

    case "titan":
      // Convert Titan response to Anthropic format
      return {
        id: `bedrock-titan-${Date.now()}`,
        type: "message",
        role: "assistant",
        model: modelId,
        content: [
          {
            type: "text",
            text: response.results?.[0]?.outputText || "",
          },
        ],
        stop_reason: response.results?.[0]?.completionReason === "FINISH" ? "end_turn" : "max_tokens",
        usage: {
          input_tokens: response.inputTextTokenCount || 0,
          output_tokens: response.results?.[0]?.tokenCount || 0,
        },
      };

    case "llama":
      // Convert Llama response to Anthropic format
      return {
        id: `bedrock-llama-${Date.now()}`,
        type: "message",
        role: "assistant",
        model: modelId,
        content: [
          {
            type: "text",
            text: response.generation || "",
          },
        ],
        stop_reason: response.stop_reason === "stop" ? "end_turn" : "max_tokens",
        usage: {
          input_tokens: response.prompt_token_count || 0,
          output_tokens: response.generation_token_count || 0,
        },
      };

    case "jurassic":
      // Convert Jurassic response to Anthropic format
      return {
        id: `bedrock-jurassic-${Date.now()}`,
        type: "message",
        role: "assistant",
        model: modelId,
        content: [
          {
            type: "text",
            text: response.completions?.[0]?.data?.text || "",
          },
        ],
        stop_reason: response.completions?.[0]?.finishReason?.reason === "endoftext" ? "end_turn" : "max_tokens",
        usage: {
          input_tokens: 0, // Jurassic doesn't provide input token count
          output_tokens: response.completions?.[0]?.data?.tokens?.length || 0,
        },
      };

    case "cohere":
      // Convert Cohere response to Anthropic format
      return {
        id: `bedrock-cohere-${Date.now()}`,
        type: "message",
        role: "assistant",
        model: modelId,
        content: [
          {
            type: "text",
            text: response.generations?.[0]?.text || "",
          },
        ],
        stop_reason: response.generations?.[0]?.finish_reason === "COMPLETE" ? "end_turn" : "max_tokens",
        usage: {
          input_tokens: 0, // Cohere doesn't provide token counts in basic response
          output_tokens: 0,
        },
      };

    case "mistral":
      // Convert Mistral response to Anthropic format
      return {
        id: `bedrock-mistral-${Date.now()}`,
        type: "message",
        role: "assistant",
        model: modelId,
        content: [
          {
            type: "text",
            text: response.outputs?.[0]?.text || "",
          },
        ],
        stop_reason: response.outputs?.[0]?.stop_reason === "stop" ? "end_turn" : "max_tokens",
        usage: {
          input_tokens: 0, // Mistral doesn't provide token counts
          output_tokens: 0,
        },
      };

    default:
      throw new Error(`Unsupported model family: ${modelFamily}`);
  }
}

module.exports = {
  detectModelFamily,
  convertAnthropicToBedrockFormat,
  convertBedrockResponseToAnthropic,
};
