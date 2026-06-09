const assert = require("assert");
const { describe, it } = require("node:test");

const { compressToolResults, getMetrics } = require("../src/context/tool-result-compressor");
const { detectBypass, buildBypassResponse } = require("../src/orchestrator/bypass");
const { dedupeTools } = require("../src/context/tool-dedup");
const { injectCaveman } = require("../src/context/caveman");

// Helper: wrap a tool_result string in a message and compress it.
function compressOne(text, tier = "SIMPLE") {
  const messages = [
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: text }] },
  ];
  const res = compressToolResults(messages, { tier });
  return { out: messages[0].content[0].content, res };
}

describe("RTK filters — grep", () => {
  it("groups grep matches by file and caps per-file output", () => {
    const lines = [];
    for (let i = 1; i <= 30; i++) lines.push(`src/app.js:${i}:const x = ${i};`);
    for (let i = 1; i <= 5; i++) lines.push(`src/util.js:${i}:helper(${i});`);
    const { out } = compressOne(lines.join("\n"));
    assert.ok(out.includes("35 matches in 2F"), `got: ${out.slice(0, 80)}`);
    assert.ok(out.includes("[file] src/app.js (30)"));
    assert.ok(out.includes("+20"), "should cap at 10 per file and note the rest");
    // tee recovery pointer is appended
    assert.ok(/\[full: tee_/.test(out));
  });

  it("ignores prose that is not grep output", () => {
    const text = "This is a normal paragraph.\nNo file:line:content here.\n".repeat(40);
    const { out } = compressOne(text);
    // grep should not fire; dedup_log collapses the repeated lines instead — but
    // the point is the result is still valid text, not a grep summary.
    assert.ok(!out.includes("matches in"));
  });
});

describe("RTK filters — dedup log", () => {
  it("collapses consecutive duplicate lines", () => {
    const text = "starting\n" + "retrying connection...\n".repeat(200) + "done\n";
    const { out } = compressOne(text);
    assert.ok(out.includes("duplicate lines"), `got: ${out.slice(0, 120)}`);
    assert.ok(out.length < text.length * 0.7);
  });
});

describe("RTK filters — smart truncate", () => {
  it("keeps head and tail of very long unmatched output", () => {
    const lines = [];
    for (let i = 0; i < 400; i++) lines.push(`unique log line number ${i} ${Math.random()}`);
    const { out } = compressOne(lines.join("\n"));
    assert.ok(out.includes("lines truncated"), `got tail: ${out.slice(-80)}`);
    assert.ok(out.includes("unique log line number 0"));
    assert.ok(out.includes("unique log line number 399"));
  });
});

describe("request bypass", () => {
  const cliHeaders = { "user-agent": "claude-cli/1.0.0" };

  it("bypasses Warmup pings from the Claude CLI", () => {
    const b = detectBypass({
      payload: { messages: [{ role: "user", content: "Warmup" }] },
      headers: cliHeaders,
    });
    assert.ok(b, "expected bypass");
    assert.strictEqual(b.kind, "warmup");
  });

  it("synthesizes a title for topic-extraction requests", () => {
    const b = detectBypass({
      payload: {
        system: "Analyze if this is a new topic. Respond with isNewTopic and title.",
        messages: [{ role: "user", content: "refactor the auth middleware please" }],
      },
      headers: cliHeaders,
    });
    assert.ok(b);
    assert.strictEqual(b.kind, "title_extraction");
    const parsed = JSON.parse(b.text);
    assert.strictEqual(parsed.isNewTopic, true);
    assert.strictEqual(parsed.title, "refactor the auth");
  });

  it("handles the '{' title-prefill pattern", () => {
    const b = detectBypass({
      payload: {
        messages: [
          { role: "user", content: "hi" },
          { role: "assistant", content: [{ type: "text", text: "{" }] },
        ],
      },
      headers: cliHeaders,
    });
    assert.ok(b);
    assert.strictEqual(b.kind, "title_prefill");
  });

  it("does NOT bypass non-CLI clients", () => {
    const b = detectBypass({
      payload: { messages: [{ role: "user", content: "Warmup" }] },
      headers: { "user-agent": "cursor/0.4" },
    });
    assert.strictEqual(b, null);
  });

  it("does NOT bypass a real coding question from the CLI", () => {
    const b = detectBypass({
      payload: { messages: [{ role: "user", content: "write a binary search in python" }] },
      headers: cliHeaders,
    });
    assert.strictEqual(b, null);
  });

  it("builds a valid Anthropic message response", () => {
    const r = buildBypassResponse({ kind: "warmup", text: "OK" }, "claude-x");
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.type, "message");
    assert.strictEqual(r.body.content[0].text, "OK");
    assert.strictEqual(r.body.model, "claude-x");
    assert.strictEqual(r.terminationReason, "bypass_warmup");
  });
});

describe("MCP-aware tool dedup", () => {
  it("strips built-in web tools when Exa MCP is present", () => {
    const tools = [
      { name: "mcp__exa__web_search_exa" },
      { name: "WebSearch" },
      { name: "WebFetch" },
      { name: "Read" },
    ];
    const { tools: out, stripped } = dedupeTools(tools);
    assert.deepStrictEqual(stripped.sort(), ["WebFetch", "WebSearch"]);
    assert.ok(out.some((t) => t.name === "mcp__exa__web_search_exa"));
    assert.ok(out.some((t) => t.name === "Read"));
    assert.ok(!out.some((t) => t.name === "WebSearch"));
  });

  it("is a no-op when no trigger MCP tool is present", () => {
    const tools = [{ name: "WebSearch" }, { name: "Read" }];
    const { tools: out, stripped } = dedupeTools(tools);
    assert.deepStrictEqual(stripped, []);
    assert.strictEqual(out.length, 2);
  });

  it("supports OpenAI-shaped tool definitions", () => {
    const tools = [
      { type: "function", function: { name: "mcp__tavily__tavily_search" } },
      { type: "function", function: { name: "WebFetch" } },
    ];
    const { stripped } = dedupeTools(tools);
    assert.deepStrictEqual(stripped, ["WebFetch"]);
  });
});

describe("caveman injector", () => {
  it("is a no-op when disabled", () => {
    const sys = "You are a helpful assistant.";
    assert.strictEqual(injectCaveman(sys, { enabled: false }), sys);
  });

  it("appends a brevity instruction when enabled", () => {
    const out = injectCaveman("base prompt", { enabled: true, level: "lite" });
    assert.ok(out.startsWith("base prompt"));
    assert.ok(out.includes("[brevity]"));
    assert.ok(out.includes("terse"));
  });

  it("is idempotent (no double injection)", () => {
    const once = injectCaveman("base", { enabled: true });
    const twice = injectCaveman(once, { enabled: true });
    assert.strictEqual(once, twice);
  });

  it("falls back to lite for an unknown level", () => {
    const out = injectCaveman("", { enabled: true, level: "bogus" });
    assert.ok(out.includes("[brevity]"));
  });
});
