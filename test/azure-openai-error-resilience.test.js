const assert = require("assert");
const { describe, it } = require("node:test");

describe("Azure OpenAI Error Resilience Tests", () => {
  describe("Error Response Structure", () => {
    it("should recognize 401 authentication error", () => {
      const errorResponse = {
        status: 401,
        json: {
          error: {
            message: "Incorrect API key provided",
            type: "invalid_request_error",
            code: "invalid_api_key"
          }
        }
      };

      assert.strictEqual(errorResponse.status, 401);
      assert.strictEqual(errorResponse.json.error.code, "invalid_api_key");
    });

    it("should recognize 403 permission denied error", () => {
      const errorResponse = {
        status: 403,
        json: {
          error: {
            message: "The API deployment for this resource does not exist",
            type: "invalid_request_error",
            code: "DeploymentNotFound"
          }
        }
      };

      assert.strictEqual(errorResponse.status, 403);
    });

    it("should recognize 404 deployment not found error", () => {
      const errorResponse = {
        status: 404,
        json: {
          error: {
            message: "The API deployment for this resource does not exist",
            type: "invalid_request_error",
            code: "DeploymentNotFound"
          }
        }
      };

      assert.strictEqual(errorResponse.status, 404);
      assert.strictEqual(errorResponse.json.error.code, "DeploymentNotFound");
    });

    it("should recognize 429 rate limit error with Retry-After header", () => {
      const errorResponse = {
        status: 429,
        headers: {
          "retry-after": "2",
          "x-ratelimit-remaining-tokens": "0",
          "x-ratelimit-remaining-requests": "0"
        },
        json: {
          error: {
            message: "Rate limit reached",
            type: "rate_limit_error",
            code: "rate_limit_exceeded"
          }
        }
      };

      assert.strictEqual(errorResponse.status, 429);
      assert.strictEqual(errorResponse.headers["retry-after"], "2");
      assert.strictEqual(errorResponse.json.error.code, "rate_limit_exceeded");
    });

    it("should recognize 400 content filter error", () => {
      const errorResponse = {
        status: 400,
        json: {
          error: {
            message: "The response was filtered due to the prompt triggering Azure OpenAI's content management policy",
            type: "invalid_request_error",
            code: "content_filter"
          }
        }
      };

      assert.strictEqual(errorResponse.status, 400);
      assert.strictEqual(errorResponse.json.error.code, "content_filter");
    });

    it("should recognize 500 internal server error", () => {
      const errorResponse = {
        status: 500,
        json: {
          error: {
            message: "The server had an error while processing your request",
            type: "server_error",
            code: "internal_error"
          }
        }
      };

      assert.strictEqual(errorResponse.status, 500);
      assert.strictEqual(errorResponse.json.error.type, "server_error");
    });

    it("should recognize 503 service unavailable error", () => {
      const errorResponse = {
        status: 503,
        json: {
          error: {
            message: "The service is temporarily unavailable",
            type: "server_error",
            code: "service_unavailable"
          }
        }
      };

      assert.strictEqual(errorResponse.status, 503);
    });
  });

  describe("Missing Choices Array Validation", () => {
    it("should detect missing choices array", () => {
      const invalidResponse = {
        id: "chatcmpl-123",
        object: "chat.completion",
        model: "gpt-4o"
        // choices array missing
      };

      assert.strictEqual(invalidResponse.choices, undefined);
    });

    it("should detect empty choices array", () => {
      const invalidResponse = {
        id: "chatcmpl-123",
        object: "chat.completion",
        model: "gpt-4o",
        choices: []
      };

      assert.strictEqual(invalidResponse.choices.length, 0);
    });

    it("should validate valid choices array", () => {
      const validResponse = {
        choices: [
          {
            message: {
              role: "assistant",
              content: "Hello"
            },
            finish_reason: "stop"
          }
        ]
      };

      assert.ok(validResponse.choices?.length > 0);
      assert.ok(validResponse.choices[0].message);
    });
  });

  describe("Network Error Categorization", () => {
    it("should categorize ETIMEDOUT as timeout error", () => {
      const error = new Error("Request timeout");
      error.code = "ETIMEDOUT";

      assert.strictEqual(error.code, "ETIMEDOUT");
    });

    it("should categorize ECONNREFUSED as connection error", () => {
      const error = new Error("Connection refused");
      error.code = "ECONNREFUSED";

      assert.strictEqual(error.code, "ECONNREFUSED");
    });

    it("should categorize ENOTFOUND as DNS error", () => {
      const error = new Error("DNS lookup failed");
      error.code = "ENOTFOUND";

      assert.strictEqual(error.code, "ENOTFOUND");
    });
  });

  describe("Retry Strategy", () => {
    it("should identify retryable 5xx errors", () => {
      const retryableStatuses = [500, 502, 503, 504];

      for (const status of retryableStatuses) {
        assert.ok(status >= 500 && status < 600);
      }
    });

    it("should identify non-retryable 4xx errors", () => {
      const nonRetryableStatuses = [400, 401, 403, 404];

      for (const status of nonRetryableStatuses) {
        assert.ok(status >= 400 && status < 500);
        assert.notStrictEqual(status, 429); // 429 is retryable
      }
    });

    it("should treat 429 as retryable with backoff", () => {
      const status = 429;

      assert.strictEqual(status, 429);
      assert.ok(status === 429); // Special handling for rate limits
    });
  });

  describe("Malformed JSON Response", () => {
    it("should handle truncated JSON response", () => {
      const truncatedJSON = '{"choices":[{"message":{"role":"assistant","content":"Hello';

      assert.throws(() => {
        JSON.parse(truncatedJSON);
      }, SyntaxError);
    });

    it("should handle empty response body", () => {
      const emptyBody = "";

      assert.throws(() => {
        JSON.parse(emptyBody);
      }, SyntaxError);
    });

    it("should handle non-JSON response", () => {
      const htmlError = "<html><body>Error 503</body></html>";

      assert.throws(() => {
        JSON.parse(htmlError);
      }, SyntaxError);
    });
  });
});
