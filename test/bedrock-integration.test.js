const assert = require("assert");
const { describe, it, beforeEach, afterEach } = require("node:test");

describe("AWS Bedrock Integration", () => {
  let originalEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };

    // Clear module cache
    delete require.cache[require.resolve("../src/config")];
    delete require.cache[require.resolve("../src/clients/routing")];
    delete require.cache[require.resolve("../src/clients/bedrock-utils")];

    // Prevent .env TIER_* values from being picked up by dotenv
    process.env.TIER_SIMPLE = "";
    process.env.TIER_MEDIUM = "";
    process.env.TIER_COMPLEX = "";
    process.env.TIER_REASONING = "";
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe("Configuration", () => {
    it("should accept bedrock as a valid MODEL_PROVIDER", () => {
      process.env.MODEL_PROVIDER = "bedrock";
      process.env.AWS_ACCESS_KEY_ID = "AKIATEST123";
      process.env.AWS_SECRET_ACCESS_KEY = "testSecretKey123";

      const config = require("../src/config");
      assert.strictEqual(config.modelProvider.type, "bedrock");
    });

    it("should throw error when AWS credentials are missing", () => {
      process.env.MODEL_PROVIDER = "bedrock";
      // Set to empty string to override .env file values
      process.env.AWS_ACCESS_KEY_ID = "";
      process.env.AWS_SECRET_ACCESS_KEY = "";

      assert.throws(
        () => require("../src/config"),
        /AWS Bedrock requires AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY/
      );
    });

    it("should use default region (us-east-1)", () => {
      process.env.MODEL_PROVIDER = "bedrock";
      process.env.AWS_ACCESS_KEY_ID = "AKIATEST123";
      process.env.AWS_SECRET_ACCESS_KEY = "testSecretKey123";
      process.env.AWS_BEDROCK_REGION = "";  // Override .env value
      process.env.AWS_REGION = "";  // Override .env value

      const config = require("../src/config");
      assert.strictEqual(config.bedrock.region, "us-east-1");
    });

    it("should use custom region when AWS_BEDROCK_REGION is set", () => {
      process.env.MODEL_PROVIDER = "bedrock";
      process.env.AWS_ACCESS_KEY_ID = "AKIATEST123";
      process.env.AWS_SECRET_ACCESS_KEY = "testSecretKey123";
      process.env.AWS_BEDROCK_REGION = "us-west-2";

      const config = require("../src/config");
      assert.strictEqual(config.bedrock.region, "us-west-2");
    });

    it("should use AWS_REGION as fallback for region", () => {
      process.env.MODEL_PROVIDER = "bedrock";
      process.env.AWS_ACCESS_KEY_ID = "AKIATEST123";
      process.env.AWS_SECRET_ACCESS_KEY = "testSecretKey123";
      process.env.AWS_BEDROCK_REGION = "";  // Override .env value
      process.env.AWS_REGION = "ap-southeast-1";

      const config = require("../src/config");
      assert.strictEqual(config.bedrock.region, "ap-southeast-1");
    });

    it("should use default model ID", () => {
      process.env.MODEL_PROVIDER = "bedrock";
      process.env.AWS_ACCESS_KEY_ID = "AKIATEST123";
      process.env.AWS_SECRET_ACCESS_KEY = "testSecretKey123";
      process.env.AWS_BEDROCK_MODEL_ID = "";  // Override .env value

      const config = require("../src/config");
      assert.strictEqual(config.bedrock.modelId, "anthropic.claude-3-5-sonnet-20241022-v2:0");
    });

    it("should use custom model ID when AWS_BEDROCK_MODEL_ID is set", () => {
      process.env.MODEL_PROVIDER = "bedrock";
      process.env.AWS_ACCESS_KEY_ID = "AKIATEST123";
      process.env.AWS_SECRET_ACCESS_KEY = "testSecretKey123";
      process.env.AWS_BEDROCK_MODEL_ID = "anthropic.claude-3-opus-20240229-v1:0";

      const config = require("../src/config");
      assert.strictEqual(config.bedrock.modelId, "anthropic.claude-3-opus-20240229-v1:0");
    });
  });

  describe("Model Family Detection", () => {
    it("should detect claude family", () => {
      process.env.MODEL_PROVIDER = "databricks";
      process.env.DATABRICKS_API_KEY = "test";
      process.env.DATABRICKS_API_BASE = "http://test.com";

      const { detectModelFamily } = require("../src/clients/bedrock-utils");
      assert.strictEqual(
        detectModelFamily("anthropic.claude-3-5-sonnet-20241022-v2:0"),
        "claude"
      );
    });

    it("should detect claude family from global inference profile", () => {
      process.env.MODEL_PROVIDER = "databricks";
      process.env.DATABRICKS_API_KEY = "test";
      process.env.DATABRICKS_API_BASE = "http://test.com";

      const { detectModelFamily } = require("../src/clients/bedrock-utils");
      assert.strictEqual(
        detectModelFamily("global.anthropic.claude-sonnet-4-5-20250929-v1:0"),
        "claude"
      );
    });

    it("should detect claude family from US inference profile", () => {
      process.env.MODEL_PROVIDER = "databricks";
      process.env.DATABRICKS_API_KEY = "test";
      process.env.DATABRICKS_API_BASE = "http://test.com";

      const { detectModelFamily } = require("../src/clients/bedrock-utils");
      assert.strictEqual(
        detectModelFamily("us.anthropic.claude-sonnet-4-5-20250929-v1:0"),
        "claude"
      );
    });

    it("should detect titan family", () => {
      process.env.MODEL_PROVIDER = "databricks";
      process.env.DATABRICKS_API_KEY = "test";
      process.env.DATABRICKS_API_BASE = "http://test.com";

      const { detectModelFamily } = require("../src/clients/bedrock-utils");
      assert.strictEqual(
        detectModelFamily("amazon.titan-text-express-v1"),
        "titan"
      );
    });

    it("should detect llama family", () => {
      process.env.MODEL_PROVIDER = "databricks";
      process.env.DATABRICKS_API_KEY = "test";
      process.env.DATABRICKS_API_BASE = "http://test.com";

      const { detectModelFamily } = require("../src/clients/bedrock-utils");
      assert.strictEqual(
        detectModelFamily("meta.llama3-70b-instruct-v1:0"),
        "llama"
      );
    });

    it("should detect jurassic family", () => {
      process.env.MODEL_PROVIDER = "databricks";
      process.env.DATABRICKS_API_KEY = "test";
      process.env.DATABRICKS_API_BASE = "http://test.com";

      const { detectModelFamily } = require("../src/clients/bedrock-utils");
      assert.strictEqual(
        detectModelFamily("ai21.j2-ultra-v1"),
        "jurassic"
      );
    });

    it("should detect cohere family", () => {
      process.env.MODEL_PROVIDER = "databricks";
      process.env.DATABRICKS_API_KEY = "test";
      process.env.DATABRICKS_API_BASE = "http://test.com";

      const { detectModelFamily } = require("../src/clients/bedrock-utils");
      assert.strictEqual(
        detectModelFamily("cohere.command-text-v14"),
        "cohere"
      );
    });

    it("should detect mistral family", () => {
      process.env.MODEL_PROVIDER = "databricks";
      process.env.DATABRICKS_API_KEY = "test";
      process.env.DATABRICKS_API_BASE = "http://test.com";

      const { detectModelFamily } = require("../src/clients/bedrock-utils");
      assert.strictEqual(
        detectModelFamily("mistral.mistral-7b-instruct-v0:2"),
        "mistral"
      );
    });

    it("should throw error for unsupported model", () => {
      process.env.MODEL_PROVIDER = "databricks";
      process.env.DATABRICKS_API_KEY = "test";
      process.env.DATABRICKS_API_BASE = "http://test.com";

      const { detectModelFamily } = require("../src/clients/bedrock-utils");
      assert.throws(
        () => detectModelFamily("unknown.model-v1"),
        /Unsupported Bedrock model/
      );
    });
  });

  describe("Format Conversion - Request", () => {
    it("should keep Claude requests in Anthropic format", () => {
      process.env.MODEL_PROVIDER = "databricks";
      process.env.DATABRICKS_API_KEY = "test";
      process.env.DATABRICKS_API_BASE = "http://test.com";

      const { convertAnthropicToBedrockFormat } = require("../src/clients/bedrock-utils");

      const anthropicBody = {
        messages: [{ role: "user", content: "Hello" }],
        max_tokens: 1024,
        temperature: 0.7,
      };

      const result = convertAnthropicToBedrockFormat(anthropicBody, "claude");

      assert.strictEqual(result.anthropic_version, "bedrock-2023-05-31");
      assert.strictEqual(result.max_tokens, 1024);
      assert.strictEqual(result.temperature, 0.7);
      assert.deepStrictEqual(result.messages, anthropicBody.messages);
    });

    it("should convert to Titan format", () => {
      process.env.MODEL_PROVIDER = "databricks";
      process.env.DATABRICKS_API_KEY = "test";
      process.env.DATABRICKS_API_BASE = "http://test.com";

      const { convertAnthropicToBedrockFormat } = require("../src/clients/bedrock-utils");

      const anthropicBody = {
        messages: [{ role: "user", content: "Hello" }],
        max_tokens: 1024,
        temperature: 0.8,
      };

      const result = convertAnthropicToBedrockFormat(anthropicBody, "titan");

      assert.strictEqual(result.textGenerationConfig.maxTokenCount, 1024);
      assert.strictEqual(result.textGenerationConfig.temperature, 0.8);
      assert.ok(result.inputText.includes("Human: Hello"));
    });

    it("should convert to Llama format", () => {
      process.env.MODEL_PROVIDER = "databricks";
      process.env.DATABRICKS_API_KEY = "test";
      process.env.DATABRICKS_API_BASE = "http://test.com";

      const { convertAnthropicToBedrockFormat } = require("../src/clients/bedrock-utils");

      const anthropicBody = {
        messages: [{ role: "user", content: "Test" }],
        max_tokens: 512,
        temperature: 0.9,
      };

      const result = convertAnthropicToBedrockFormat(anthropicBody, "llama");

      assert.strictEqual(result.max_gen_len, 512);
      assert.strictEqual(result.temperature, 0.9);
      assert.ok(result.prompt.includes("Human: Test"));
    });

    it("should convert to Jurassic format", () => {
      process.env.MODEL_PROVIDER = "databricks";
      process.env.DATABRICKS_API_KEY = "test";
      process.env.DATABRICKS_API_BASE = "http://test.com";

      const { convertAnthropicToBedrockFormat } = require("../src/clients/bedrock-utils");

      const anthropicBody = {
        messages: [{ role: "user", content: "Test" }],
        max_tokens: 200,
        temperature: 0.7,
      };

      const result = convertAnthropicToBedrockFormat(anthropicBody, "jurassic");

      assert.strictEqual(result.maxTokens, 200);
      assert.strictEqual(result.temperature, 0.7);
      assert.ok(result.prompt.includes("Human: Test"));
    });
  });

  describe("Format Conversion - Response", () => {
    it("should parse Claude responses (native Anthropic)", () => {
      process.env.MODEL_PROVIDER = "databricks";
      process.env.DATABRICKS_API_KEY = "test";
      process.env.DATABRICKS_API_BASE = "http://test.com";

      const { convertBedrockResponseToAnthropic } = require("../src/clients/bedrock-utils");

      const claudeResponse = {
        id: "msg_123",
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "Hello!" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 5 },
      };

      const result = convertBedrockResponseToAnthropic(
        claudeResponse,
        "claude",
        "anthropic.claude-3-5-sonnet-20241022-v2:0"
      );

      assert.deepStrictEqual(result, claudeResponse);
    });

    it("should convert Titan responses to Anthropic format", () => {
      process.env.MODEL_PROVIDER = "databricks";
      process.env.DATABRICKS_API_KEY = "test";
      process.env.DATABRICKS_API_BASE = "http://test.com";

      const { convertBedrockResponseToAnthropic } = require("../src/clients/bedrock-utils");

      const titanResponse = {
        results: [{
          outputText: "Response text",
          tokenCount: 50,
          completionReason: "FINISH",
        }],
        inputTextTokenCount: 20,
      };

      const result = convertBedrockResponseToAnthropic(
        titanResponse,
        "titan",
        "amazon.titan-text-express-v1"
      );

      assert.strictEqual(result.role, "assistant");
      assert.strictEqual(result.content[0].type, "text");
      assert.strictEqual(result.content[0].text, "Response text");
      assert.strictEqual(result.stop_reason, "end_turn");
      assert.strictEqual(result.usage.input_tokens, 20);
      assert.strictEqual(result.usage.output_tokens, 50);
    });

    it("should convert Llama responses to Anthropic format", () => {
      process.env.MODEL_PROVIDER = "databricks";
      process.env.DATABRICKS_API_KEY = "test";
      process.env.DATABRICKS_API_BASE = "http://test.com";

      const { convertBedrockResponseToAnthropic } = require("../src/clients/bedrock-utils");

      const llamaResponse = {
        generation: "Llama response",
        prompt_token_count: 15,
        generation_token_count: 30,
        stop_reason: "stop",
      };

      const result = convertBedrockResponseToAnthropic(
        llamaResponse,
        "llama",
        "meta.llama3-70b-instruct-v1:0"
      );

      assert.strictEqual(result.role, "assistant");
      assert.strictEqual(result.content[0].text, "Llama response");
      assert.strictEqual(result.stop_reason, "end_turn");
      assert.strictEqual(result.usage.input_tokens, 15);
      assert.strictEqual(result.usage.output_tokens, 30);
    });
  });

  describe("Routing", () => {
    it("should route to bedrock when MODEL_PROVIDER is bedrock", () => {
      process.env.MODEL_PROVIDER = "bedrock";
      process.env.AWS_ACCESS_KEY_ID = "AKIATEST123";
      process.env.AWS_SECRET_ACCESS_KEY = "testSecretKey123";

      const config = require("../src/config");
      const routing = require("../src/clients/routing");

      const payload = { messages: [{ role: "user", content: "test" }] };
      const provider = routing.determineProviderSync(payload);

      // determineProviderSync returns static MODEL_PROVIDER
      assert.strictEqual(provider, "bedrock");
    });

    it("should return static routing from determineProviderSmart when tiers disabled", async () => {
      process.env.MODEL_PROVIDER = "bedrock";
      process.env.AWS_ACCESS_KEY_ID = "AKIATEST123";
      process.env.AWS_SECRET_ACCESS_KEY = "testSecretKey123";

      const config = require("../src/config");
      const routing = require("../src/clients/routing");

      // Many tools -- but without TIER_* vars, determineProviderSmart returns static routing
      const payload = {
        messages: [{ role: "user", content: "test" }],
        tools: Array(20).fill({ name: "tool" }),
      };
      const result = await routing.determineProviderSmart(payload);

      assert.strictEqual(result.provider, "bedrock");
      assert.strictEqual(result.method, "static");
      assert.strictEqual(result.reason, "tier_routing_disabled");
    });
  });

  describe("Fallback Provider", () => {
    it("should allow bedrock as fallback provider", () => {
      process.env.MODEL_PROVIDER = "ollama";
      process.env.OLLAMA_MODEL = "llama3.1";
      process.env.OLLAMA_ENDPOINT = "http://localhost:11434";
      process.env.FALLBACK_PROVIDER = "bedrock";
      process.env.AWS_BEDROCK_API_KEY = "test-bedrock-key";
      process.env.FALLBACK_ENABLED = "true";

      // Should not throw
      const config = require("../src/config");
      assert.strictEqual(config.modelProvider.fallbackProvider, "bedrock");
    });

    it("should validate bedrock credentials when used as fallback", () => {
      process.env.MODEL_PROVIDER = "ollama";
      process.env.OLLAMA_MODEL = "llama3.1";
      process.env.OLLAMA_ENDPOINT = "http://localhost:11434";
      process.env.FALLBACK_PROVIDER = "bedrock";
      process.env.FALLBACK_ENABLED = "true";
      // Set to empty string to override .env file values
      process.env.AWS_BEDROCK_API_KEY = "";

      assert.throws(
        () => require("../src/config"),
        /FALLBACK_PROVIDER is set to 'bedrock' but AWS_BEDROCK_API_KEY is not configured/
      );
    });

    it("should not allow local providers as fallback", () => {
      process.env.MODEL_PROVIDER = "ollama";
      process.env.OLLAMA_MODEL = "llama3.1";
      process.env.OLLAMA_ENDPOINT = "http://localhost:11434";
      process.env.FALLBACK_PROVIDER = "llamacpp";
      process.env.FALLBACK_ENABLED = "true";

      assert.throws(
        () => require("../src/config"),
        /FALLBACK_PROVIDER cannot be 'llamacpp'/
      );
    });
  });
});
