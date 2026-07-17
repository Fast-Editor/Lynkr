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

describe("container_output — structure-anchored detection", () => {
  // Live incident 2026-07-12 (goose session): the old /docker/i containment
  // trigger matched "Dockerfile" inside a plain `ls` listing, truncated it
  // to 10 lines, and the model hallucinated the dropped file names.
  const LS_WITH_DOCKERFILE = [
    "BENCHMARK_REPORT.md", "Dockerfile", "docker-compose.yml", "LICENSE",
    "README.md", "index.js", "package.json", "src", "test", "docs",
    "scripts", "logs", "models", "native", "public", "skills", "bin",
    "config", "data", "examples", "marketing", "documentation",
  ].join("\n");

  it("does NOT fire on an ls listing that contains Dockerfile", () => {
    const { out } = compressOne(LS_WITH_DOCKERFILE);
    const m = getMetrics();
    // Whatever else happens, the container table summarizer must not run.
    assert.ok(!(m.patterns.container_output?.count > 0),
      "container_output fired on a plain file listing");
    // Every original file name must survive in some form or the output must
    // carry an explicit count — never a silent 10-line truncation.
    assert.ok(!/^\.\.\. \+\d+ more/m.test(out) || /total\)/.test(out));
  });

  it("still compresses a real `docker ps` table", () => {
    const header = "CONTAINER ID   IMAGE          COMMAND        CREATED        STATUS         PORTS     NAMES";
    const rows = Array.from({ length: 15 }, (_, i) =>
      `abc${i}def        nginx:latest   "nginx -g"     2 hours ago    Up 2 hours     80/tcp    web-${i}`);
    const { out } = compressOne([header, ...rows].join("\n"));
    assert.ok(out.includes("CONTAINER ID"), "keeps the header");
    assert.ok(out.includes("+5 more (15 total)"), `got: ${out.slice(0, 200)}`);
  });

  it("still compresses a real `kubectl get pods` table", () => {
    const header = "NAME                     READY   STATUS    RESTARTS   AGE";
    const rows = Array.from({ length: 40 }, (_, i) =>
      `api-deployment-${i}       1/1     Running   0          ${i}d`);
    const { out } = compressOne([header, ...rows].join("\n"));
    assert.ok(out.includes("READY"), "keeps the header");
    assert.ok(out.includes("+30 more (40 total)"));
  });
});

describe("git_status — structure-anchored detection", () => {
  it("does NOT fire on source code containing 'modified:'", () => {
    const code = [
      "function render(item) {",
      "  // fields: modified: timestamp, new file: boolean",
      "  return `modified: ${item.modified}`;",
      "}",
    ].join("\n").repeat(30);
    const { out } = compressOne(code);
    assert.ok(!out.startsWith("branch:"), "compressed code into a fake git status");
    assert.ok(!/^staged:/m.test(out.slice(0, 200)));
  });

  it("still compresses a real git status", () => {
    const status = [
      "On branch main",
      "Changes not staged for commit:",
      '  (use "git add <file>..." to update what will be committed)',
      ...Array.from({ length: 20 }, (_, i) => `\tmodified:   src/file${i}.js`),
      "",
      "Untracked files:",
      ...Array.from({ length: 10 }, (_, i) => `\tnew-thing-${i}.md`),
    ].join("\n");
    const { out } = compressOne(status);
    assert.ok(out.includes("branch: main"), `got: ${out.slice(0, 120)}`);
    assert.ok(out.includes("modified:"));
  });
});

describe("test_output — corroboration required", () => {
  it("does NOT eat a long README that quotes a test count once", () => {
    const readme = [
      "# MyLib",
      "A fast library for doing things.",
      "The CI badge shows 1041 passing at time of writing.",
      ...Array.from({ length: 60 }, (_, i) => `Feature ${i}: does something useful with details.`),
    ].join("\n");
    const { out } = compressOne(readme);
    assert.ok(out.includes("Feature 3:"),
      `README content was eaten, got: ${out.slice(0, 150)}`);
  });

  it("still compresses a real test run with failures", () => {
    const run = [
      ...Array.from({ length: 40 }, (_, i) => `✓ test case ${i} passes`),
      "✗ test case 40 fails",
      "  AssertionError: expected 4 to equal 5",
      "Tests: 40 passed, 1 failed",
    ].join("\n");
    const { out } = compressOne(run);
    assert.ok(out.includes("Tests: 40 passed, 1 failed"));
    assert.ok(out.includes("AssertionError"), "keeps failure detail");
    assert.ok(!out.includes("✓ test case 12"), "drops passing noise");
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

describe("trimLoopMessages — the current task survives every trim", () => {
  const { trimLoopMessages } = require("../src/orchestrator");

  const toolFrame = (i) => [
    { role: "assistant", content: [{ type: "tool_use", id: `t${i}`, name: "Read", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: `t${i}`, content: "…" }] },
  ];

  it("keeps the typed ask when the session opened with a greeting (the amnesia bug)", () => {
    const msgs = [
      { role: "user", content: "Hi" },
      { role: "assistant", content: "Hi! What can I help you with?" },
      { role: "user", content: "Do an architecture review of the orchestrator" },
      ...Array.from({ length: 30 }, (_, i) => toolFrame(i)).flat(),
    ];
    const out = trimLoopMessages(msgs, 40);
    assert.ok(out.length <= 41);
    const texts = out.filter(m => typeof m.content === "string").map(m => m.content);
    assert.ok(texts.includes("Do an architecture review of the orchestrator"),
      "the task must survive the trim");
  });

  it("does not duplicate the task when it is already inside the kept tail", () => {
    const msgs = [
      { role: "user", content: "Hi" },
      { role: "assistant", content: "hello" },
      ...Array.from({ length: 25 }, (_, i) => toolFrame(i)).flat(),
      { role: "user", content: "now fix the failing test" },
      ...Array.from({ length: 5 }, (_, i) => toolFrame(100 + i)).flat(),
    ];
    const out = trimLoopMessages(msgs, 40);
    const occurrences = out.filter(m => m.content === "now fix the failing test").length;
    assert.strictEqual(occurrences, 1);
  });

  it("harness-only user messages are not mistaken for the task", () => {
    const msgs = [
      { role: "user", content: "refactor the parser module please" },
      { role: "assistant", content: "on it" },
      ...Array.from({ length: 25 }, (_, i) => toolFrame(i)).flat(),
      { role: "user", content: "[SYSTEM NOTIFICATION - NOT USER INPUT] background task update" },
      ...Array.from({ length: 5 }, (_, i) => toolFrame(200 + i)).flat(),
    ];
    const out = trimLoopMessages(msgs, 40);
    // Head IS the task here (msg 0) — must be kept; the notification must not
    // have been selected as "the task".
    assert.strictEqual(out[0].content, "refactor the parser module please");
  });
});
