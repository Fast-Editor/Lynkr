const { describe, it } = require("node:test");
const assert = require("node:assert");

// Set up test environment
process.env.NODE_ENV = "test";

const {
  extractToolCallsFromText,
} = require("../src/clients/ollama-utils");

const { getParserForModel, PARSER_REGISTRY } = require("../src/parsers");

describe("Qwen3 Markdown Tool Extraction", () => {
  it("should have qwen3 registered in the parser registry", () => {
    const hasQwen3 = PARSER_REGISTRY.some(entry => entry.prefix === "qwen3");
    assert.ok(hasQwen3, "qwen3 should be in parser registry");
  });

  it("should return a parser for qwen3-coder-next", () => {
    const parser = getParserForModel("qwen3-coder-next");
    assert.ok(parser, "Should return a parser instance");
    assert.notStrictEqual(parser.constructor.name, "GenericToolParser",
      "qwen3 should not fall back to GenericToolParser");
  });

  it("should extract bash command from markdown code block for qwen3-coder-next", () => {
    const content = `Let me check the log files to understand what's happening:

\`\`\`bash
ls -la ./logs 2>/dev/null || echo "logs directory not found"
\`\`\``;

    const extracted = extractToolCallsFromText(content, "qwen3-coder-next");

    assert.ok(extracted, "Should extract tool calls");
    assert.strictEqual(extracted.length, 1, "Should extract 1 tool call");
    assert.strictEqual(extracted[0].function.name, "Bash", "Should be Bash tool");
    assert.ok(
      extracted[0].function.arguments.command.includes("ls -la ./logs"),
      "Should extract the ls command"
    );
  });

  it("should extract multiple commands from multiple code blocks", () => {
    const content = `First check the directory:

\`\`\`bash
pwd
\`\`\`

Then list the files:

\`\`\`bash
ls -la
\`\`\``;

    const extracted = extractToolCallsFromText(content, "qwen3-coder-next");

    assert.ok(extracted, "Should extract tool calls");
    assert.strictEqual(extracted.length, 2, "Should extract 2 tool calls");
    assert.strictEqual(extracted[0].function.arguments.command, "pwd");
    assert.strictEqual(extracted[1].function.arguments.command, "ls -la");
  });

  it("should work with sh, shell, and console code blocks", () => {
    const testCases = [
      { fence: "sh", command: "echo test" },
      { fence: "shell", command: "cat file.txt" },
      { fence: "console", command: "npm install" },
    ];

    for (const { fence, command } of testCases) {
      const content = `\`\`\`${fence}\n${command}\n\`\`\``;
      const extracted = extractToolCallsFromText(content, "qwen3-coder-next");

      assert.ok(extracted, `Should extract from ${fence} block`);
      assert.strictEqual(extracted.length, 1);
      assert.strictEqual(extracted[0].function.arguments.command, command);
    }
  });

  it("should strip prompt characters ($, #)", () => {
    const content = `\`\`\`bash
$ ls -la
# cat file.txt
\`\`\``;

    const extracted = extractToolCallsFromText(content, "qwen3-coder-next");

    assert.ok(extracted, "Should extract tool calls");
    assert.strictEqual(extracted.length, 2, "Should extract 2 commands");
    assert.strictEqual(extracted[0].function.arguments.command, "ls -la");
    assert.strictEqual(extracted[1].function.arguments.command, "cat file.txt");
  });

  it("should not extract from non-registered models without AGGRESSIVE_TOOL_PATCHING", () => {
    const content = `\`\`\`bash
ls -la
\`\`\``;

    // Random model that's not in registry — falls to GenericToolParser (JSON only)
    const extracted = extractToolCallsFromText(content, "some-other-model");

    // Should be null because GenericToolParser only extracts JSON tool calls
    assert.strictEqual(extracted, null, "Should not extract for unlisted models");
  });

  it("should only extract valid shell commands", () => {
    const content = `\`\`\`bash
This is just text
not a command
\`\`\``;

    const extracted = extractToolCallsFromText(content, "qwen3-coder-next");

    // Should be null because no valid shell commands match the regex
    assert.strictEqual(extracted, null, "Should not extract non-commands");
  });
});
