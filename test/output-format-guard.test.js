/**
 * Tests for the output formatting guard (src/context/output-format-guard.js).
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  injectFormatGuard,
  producesCleanMarkdown,
  appendToSystem,
  MARKER,
} = require("../src/context/output-format-guard");

describe("output format guard", () => {
  describe("producesCleanMarkdown", () => {
    it("treats Claude-family models as clean", () => {
      assert.equal(producesCleanMarkdown("openrouter", "anthropic/claude-3.5-sonnet"), true);
      assert.equal(producesCleanMarkdown("bedrock", "claude-opus-4"), true);
      assert.equal(producesCleanMarkdown("databricks", "databricks-claude-sonnet-4-5"), true);
    });

    it("treats azure-anthropic provider as clean regardless of model", () => {
      assert.equal(producesCleanMarkdown("azure-anthropic", null), true);
    });

    it("treats non-Claude backends as needing the guard", () => {
      assert.equal(producesCleanMarkdown("moonshot", "kimi-k2-turbo-preview"), false);
      assert.equal(producesCleanMarkdown("ollama", "qwen2.5-coder:7b"), false);
      assert.equal(producesCleanMarkdown("azure-openai", "gpt-4o"), false);
    });

    it("biases toward injecting when the model is unknown", () => {
      // Unknown model on a provider that could serve either → inject (not clean).
      assert.equal(producesCleanMarkdown("openrouter", null), false);
    });
  });

  describe("appendToSystem", () => {
    it("appends to a string system prompt", () => {
      const out = appendToSystem("You are helpful.", "GUARD");
      assert.match(out, /You are helpful\./);
      assert.match(out, /GUARD/);
    });

    it("becomes the system prompt when empty", () => {
      assert.equal(appendToSystem("", "GUARD"), "GUARD");
      assert.equal(appendToSystem(null, "GUARD"), "GUARD");
    });

    it("appends a block to an array system prompt", () => {
      const arr = [{ type: "text", text: "base" }];
      const out = appendToSystem(arr, "GUARD");
      assert.equal(out.length, 2);
      assert.equal(out[1].text, "GUARD");
    });
  });

  describe("injectFormatGuard", () => {
    it("injects for a non-Claude backend (string system)", () => {
      const body = { system: "base prompt", model: "claude-opus-4-5" };
      injectFormatGuard(body, { provider: "moonshot", model: "kimi-k2-turbo-preview" });
      assert.match(body.system, new RegExp(MARKER.replace(/[[\]]/g, "\\$&")));
      assert.match(body.system, /box-drawing|line-drawing/);
    });

    it("does NOT inject for a Claude backend even if client asked via label", () => {
      const body = { system: "base prompt", model: "claude-opus-4-5" };
      injectFormatGuard(body, { provider: "azure-anthropic", model: null });
      assert.equal(body.system, "base prompt");
    });

    it("keys off resolved model, not the client's requested body.model", () => {
      // Client requested claude (label) but Lynkr resolved to kimi → must inject.
      const body = { system: "base", model: "claude-opus-4-5" };
      injectFormatGuard(body, { provider: "moonshot", model: "kimi-k2-turbo-preview" });
      assert.match(body.system, new RegExp(MARKER.replace(/[[\]]/g, "\\$&")));
    });

    it("is idempotent (no double injection)", () => {
      const body = { system: "base", model: "kimi" };
      injectFormatGuard(body, { provider: "moonshot", model: "kimi" });
      const once = body.system;
      injectFormatGuard(body, { provider: "moonshot", model: "kimi" });
      assert.equal(body.system, once);
    });

    it("handles array-format system prompts", () => {
      const body = { system: [{ type: "text", text: "base" }] };
      injectFormatGuard(body, { provider: "ollama", model: "qwen2.5-coder" });
      assert.equal(body.system.length, 2);
      assert.match(body.system[1].text, new RegExp(MARKER.replace(/[[\]]/g, "\\$&")));
    });
  });
});
