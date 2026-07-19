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

describe("command-aware dispatch", () => {
  // The tool_use block preceding a tool_result carries the literal shell
  // command — when it matches the dispatch table, the mapped compressor
  // runs directly (pattern name `cmd:*`) and shape detection is skipped.
  let idCounter = 0;
  function compressWithCommand(command, text, { tool = "Bash", tier = "SIMPLE" } = {}) {
    const id = `cmdtest_${idCounter++}`;
    const messages = [
      { role: "assistant", content: [{ type: "tool_use", id, name: tool, input: { command } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: text }] },
    ];
    const res = compressToolResults(messages, { tier });
    return { out: messages[1].content[0].content, res };
  }
  const patternCount = (name) => getMetrics().patterns[name]?.count || 0;

  // A table whose header is ambiguous to shape detection: only two known
  // column tokens ("CONTAINER ID", "IMAGE"), so the structure-anchored
  // detector rejects it — only knowing the command can classify it.
  const AMBIGUOUS_HEADER = "CONTAINER ID   IMAGE            STATE      UPTIME";
  const AMBIGUOUS_TABLE = [
    AMBIGUOUS_HEADER,
    ...Array.from({ length: 40 }, (_, i) =>
      `abc${i}def        nginx:latest     running    2 hours`),
  ].join("\n");

  it("compresses an ambiguous table when the command says `docker ps`", () => {
    const before = patternCount("cmd:container_output");
    const { out } = compressWithCommand("docker ps --format 'table {{.ID}}'", AMBIGUOUS_TABLE);
    assert.ok(out.includes("CONTAINER ID"), "keeps the header");
    assert.ok(out.includes("+30 more (40 total)"), `got: ${out.slice(0, 200)}`);
    assert.strictEqual(patternCount("cmd:container_output"), before + 1);
  });

  it("does NOT container-compress the same output when the command was `ls`", () => {
    const before = patternCount("cmd:container_output");
    const { out } = compressWithCommand("ls -la", AMBIGUOUS_TABLE);
    assert.strictEqual(patternCount("cmd:container_output"), before,
      "container_output fired despite the command being ls");
    // Under an ls dispatch the lines are treated as a listing: they must
    // survive verbatim or carry an exact count — never a silent truncation.
    assert.ok(out.includes("abc39def") || /\(41 total\)/.test(out),
      `listing must survive verbatim or with exact counts, got: ${out.slice(0, 200)}`);
  });

  it("works for goose's `shell` tool name", () => {
    const before = patternCount("cmd:container_output");
    compressWithCommand("docker ps", AMBIGUOUS_TABLE, { tool: "shell" });
    assert.strictEqual(patternCount("cmd:container_output"), before + 1);
  });

  // Same shape as the git_status suite above — known to clear the 0.7
  // compression-ratio gate.
  const GIT_STATUS = [
    "On branch main",
    "Changes not staged for commit:",
    '  (use "git add <file>..." to update what will be committed)',
    ...Array.from({ length: 20 }, (_, i) => `\tmodified:   src/file${i}.js`),
    "",
    "Untracked files:",
    ...Array.from({ length: 10 }, (_, i) => `\tnew-thing-${i}.md`),
  ].join("\n");

  it("strips `cd x &&` chains and env assignments before matching", () => {
    const before = patternCount("cmd:git_status");
    const { out } = compressWithCommand("cd /repo && GIT_PAGER=cat git status", GIT_STATUS);
    assert.strictEqual(patternCount("cmd:git_status"), before + 1);
    assert.ok(out.includes("branch: main"));
  });

  it("does NOT dispatch on chained commands with mixed output", () => {
    const beforeCmd = patternCount("cmd:git_status");
    const beforeShape = patternCount("git_status");
    compressWithCommand("git status && npm test", GIT_STATUS);
    // Falls through to shape detection, which still recognizes the status.
    assert.strictEqual(patternCount("cmd:git_status"), beforeCmd);
    assert.strictEqual(patternCount("git_status"), beforeShape + 1);
  });

  it("unknown commands fall through to the shape-anchored pipeline", () => {
    const header = "CONTAINER ID   IMAGE          COMMAND        CREATED        STATUS         PORTS     NAMES";
    const rows = Array.from({ length: 15 }, (_, i) =>
      `abc${i}def        nginx:latest   "nginx -g"     2 hours ago    Up 2 hours     80/tcp    web-${i}`);
    const before = patternCount("container_output");
    compressWithCommand("./scripts/show-containers.sh", [header, ...rows].join("\n"));
    assert.strictEqual(patternCount("container_output"), before + 1);
  });

  it("trusted `ls` compresses listings the shape regex would reject", () => {
    const files = Array.from({ length: 20 }, (_, i) => `My Cool File ${i}.txt`);
    const before = patternCount("cmd:directory_listing");
    const { out } = compressWithCommand("ls", files.join("\n"));
    assert.strictEqual(patternCount("cmd:directory_listing"), before + 1);
    assert.ok(out.includes("(20 total)"), `exact count required, got: ${out.slice(0, 120)}`);
  });

  it("skips package-runner prefixes (`npx tsc`)", () => {
    const errors = Array.from({ length: 15 }, (_, i) =>
      `src/app.ts(${i + 1},5): error TS2322: Type 'string' is not assignable to type 'number'.`);
    const before = patternCount("cmd:lint_output");
    const { out } = compressWithCommand("npx tsc --noEmit", errors.join("\n"));
    assert.strictEqual(patternCount("cmd:lint_output"), before + 1);
    assert.ok(out.includes("TS2322: 15x"), `got: ${out.slice(0, 120)}`);
  });

  it("parses jest --json / vitest --reporter=json into per-suite summaries", () => {
    const json = JSON.stringify({
      numTotalTests: 42, numPassedTests: 40, numFailedTests: 2, numPendingTests: 0,
      testResults: [
        { name: "src/a.test.js", assertionResults: Array.from({ length: 20 }, (_, i) => ({ fullName: `a case ${i}`, status: "passed", failureMessages: [] })) },
        { name: "src/b.test.js", assertionResults: [
          ...Array.from({ length: 20 }, (_, i) => ({ fullName: `b case ${i}`, status: "passed", failureMessages: [] })),
          { fullName: "b > rejects bad input", status: "failed", failureMessages: ["Error: expected 4 to be 5\n    at Object.<anonymous> (src/b.test.js:88:5)"] },
          { fullName: "b > times out", status: "failed", failureMessages: ["Timeout of 5000ms exceeded"] },
        ] },
      ],
    });
    const before = patternCount("cmd:js_test_output");
    // pnpm-style prefix noise before the JSON — RTK's extract_json_object case
    const { out } = compressWithCommand("npx jest --json", "WARN deprecated something\n" + json);
    assert.strictEqual(patternCount("cmd:js_test_output"), before + 1);
    assert.ok(out.includes("Tests: 40 passed, 2 failed (42 total)"), `got: ${out.slice(0, 120)}`);
    assert.ok(out.includes("PASS src/a.test.js (20/20)"), "per-suite summary");
    assert.ok(out.includes("FAIL src/b.test.js (20/22)"));
    assert.ok(out.includes("expected 4 to be 5"), "keeps failure message");
  });

  it("parses vitest default text reporter (per-suite + failures)", () => {
    const run = [
      " ✓ src/routing.test.ts (18 tests) 34ms",
      " ✓ src/cache.test.ts (9 tests) 12ms",
      " ❯ src/parser.test.ts (12 tests | 1 failed) 51ms",
      ...Array.from({ length: 38 }, (_, i) => ` ✓ src/parser.test.ts > case ${i} passes fine`),
      "   × src/parser.test.ts > rejects malformed header",
      "     AssertionError: expected null to be 'X-Header'",
      "     at src/parser.test.ts:41:22",
      "",
      " Test Files  1 failed | 2 passed (3)",
      "      Tests  1 failed | 38 passed (39)",
      "   Duration  450ms",
    ].join("\n");
    const before = patternCount("cmd:js_test_output");
    const { out } = compressWithCommand("vitest run", run);
    assert.strictEqual(patternCount("cmd:js_test_output"), before + 1);
    assert.ok(out.includes("Tests  1 failed | 38 passed (39)"), `got: ${out.slice(0, 200)}`);
    assert.ok(out.includes("❯ src/parser.test.ts (12 tests | 1 failed)"), "keeps suite lines");
    assert.ok(out.includes("AssertionError"), "keeps failure detail");
    assert.ok(!out.includes("case 12 passes fine"), "drops passing noise");
  });

  it("dispatches bare package-manager bins (`yarn jest`) but not `pnpm ls`", () => {
    const json = JSON.stringify({
      numTotalTests: 5, numPassedTests: 5, numFailedTests: 0, numPendingTests: 0,
      testResults: [{ name: "src/c.test.js", assertionResults: Array.from({ length: 5 }, (_, i) => ({ fullName: `c ${i}`, status: "passed", failureMessages: [] })) }],
    }) + "\n" + "// padding so the payload clears the tier threshold\n".repeat(10);
    const before = patternCount("cmd:js_test_output");
    compressWithCommand("yarn jest", json);
    assert.strictEqual(patternCount("cmd:js_test_output"), before + 1);

    // `pnpm ls` output is a dependency tree — must NOT dispatch as `ls`.
    const beforeLs = patternCount("cmd:directory_listing");
    const depTree = Array.from({ length: 30 }, (_, i) => `├── package-${i}@1.0.${i}`).join("\n");
    compressWithCommand("pnpm ls", depTree);
    assert.strictEqual(patternCount("cmd:directory_listing"), beforeLs,
      "pnpm ls was mis-dispatched as a directory listing");
  });

  it("summarizes eslint -f json by rule and by file", () => {
    const mkMsg = (rule) => ({ ruleId: rule, severity: 2, message: "msg", line: 1, column: 1 });
    const results = [
      { filePath: "/repo/src/api/router.js", errorCount: 12, warningCount: 0, messages: Array.from({ length: 12 }, () => mkMsg("no-unused-vars")) },
      { filePath: "/repo/src/util.js", errorCount: 3, warningCount: 2, messages: [...Array.from({ length: 3 }, () => mkMsg("eqeqeq")), mkMsg("prefer-const"), mkMsg("prefer-const")] },
      { filePath: "/repo/src/clean.js", errorCount: 0, warningCount: 0, messages: [] },
    ];
    const before = patternCount("cmd:lint_output");
    const { out } = compressWithCommand("npx eslint -f json src/", JSON.stringify(results));
    assert.strictEqual(patternCount("cmd:lint_output"), before + 1);
    assert.ok(out.includes("ESLint: 15 errors, 2 warnings in 2 files"), `got: ${out.slice(0, 120)}`);
    assert.ok(out.includes("no-unused-vars (12x)"), "top rules");
    assert.ok(out.includes("src/api/router.js (12 issues)"), "top files with compact path");
  });

  it("groups eslint stylish text output per file", () => {
    const run = [
      "/repo/src/api/router.js",
      ...Array.from({ length: 12 }, (_, i) => `  ${i + 1}:5  error  'x' is assigned but never used  no-unused-vars`),
      "",
      "/repo/src/util.js",
      ...Array.from({ length: 4 }, (_, i) => `  ${i + 1}:1  warning  Expected === and instead saw ==  eqeqeq`),
      "",
      "✖ 16 problems (12 errors, 4 warnings)",
    ].join("\n");
    const { out } = compressOne(run);
    assert.ok(out.includes("12 errors, 4 warnings"), `got: ${out.slice(0, 120)}`);
    assert.ok(out.includes("Top files:"), "per-file grouping present");
    assert.ok(out.includes("src/api/router.js (12 issues)"));
  });

  it("parses biome text output (lint/group/rule ids)", () => {
    const run = Array.from({ length: 15 }, (_, i) =>
      [`src/handlers/h${i % 3}.ts:${i + 1}:7 lint/suspicious/noDoubleEquals  FIXABLE  ━━━━━━━━━━━`,
       "",
       "  × Use === instead of ==",
       ""].join("\n")).join("\n");
    const before = patternCount("cmd:lint_output");
    const { out } = compressWithCommand("biome lint src/", run);
    assert.strictEqual(patternCount("cmd:lint_output"), before + 1);
    assert.ok(out.includes("lint/suspicious/noDoubleEquals: 15x"), `got: ${out.slice(0, 160)}`);
    assert.ok(out.includes("Top files:"));
  });

  it("parses pytest output (summary counts + failure details)", () => {
    const run = [
      "============================= test session starts ==============================",
      "platform darwin -- Python 3.11.0, pytest-8.0.0",
      "collected 43 items",
      "",
      "tests/test_auth.py ........................                                [ 55%]",
      "tests/test_api.py ............F......                                      [100%]",
      ...Array.from({ length: 25 }, (_, i) => `tests/test_extra.py::test_case_${i} PASSED  [ ${i} %]`),
      "",
      "=================================== FAILURES ===================================",
      "______________________________ test_rate_limit ________________________________",
      "    def test_rate_limit():",
      ">       assert resp.status == 429",
      "E       AssertionError: assert 200 == 429",
      "tests/test_api.py:41: AssertionError",
      "=========================== short test summary info ============================",
      "FAILED tests/test_api.py::test_rate_limit - AssertionError: assert 200 == 429",
      "========================= 1 failed, 42 passed in 4.32s =========================",
    ].join("\n");
    const before = patternCount("cmd:pytest_output");
    const { out } = compressWithCommand("python -m pytest tests/", run);
    assert.strictEqual(patternCount("cmd:pytest_output"), before + 1);
    assert.ok(out.includes("Pytest: 42 passed, 1 failed"), `got: ${out.slice(0, 120)}`);
    assert.ok(out.includes("[FAIL] test_rate_limit"));
    assert.ok(out.includes("AssertionError: assert 200 == 429"), "keeps assertion detail");
    assert.ok(!out.includes("[ 55%]"), "drops progress lines");
  });

  it("aggregates all-pass cargo test suites into one line", () => {
    const run = [
      "   Compiling lynkr v0.1.0",
      "    Finished test profile [unoptimized + debuginfo]",
      "     Running unittests src/lib.rs",
      "",
      "running 15 tests",
      ...Array.from({ length: 15 }, (_, i) => `test routing::tests::case_${i} ... ok`),
      "test result: ok. 15 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.01s",
      "",
      "     Running tests/integration.rs",
      "running 7 tests",
      ...Array.from({ length: 7 }, (_, i) => `test integration::case_${i} ... ok`),
      "test result: ok. 7 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.42s",
    ].join("\n");
    const before = patternCount("cmd:cargo_test_output");
    const { out } = compressWithCommand("cargo test --workspace", run);
    assert.strictEqual(patternCount("cmd:cargo_test_output"), before + 1);
    assert.ok(out.includes("cargo test: 22 passed (2 suites, 0.43s)"), `got: ${out.slice(0, 120)}`);
  });

  it("keeps cargo test failure blocks and per-suite summaries", () => {
    const run = [
      "running 30 tests",
      ...Array.from({ length: 29 }, (_, i) => `test mod_a::case_${i} ... ok`),
      "test mod_a::boundary ... FAILED",
      "",
      "failures:",
      "",
      "---- mod_a::boundary stdout ----",
      "thread 'mod_a::boundary' panicked at src/lib.rs:42:9:",
      "assertion `left == right` failed",
      "  left: 4",
      "  right: 5",
      "",
      "test result: FAILED. 29 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.11s",
    ].join("\n");
    const before = patternCount("cmd:cargo_test_output");
    const { out } = compressWithCommand("cargo test", run);
    assert.strictEqual(patternCount("cmd:cargo_test_output"), before + 1);
    assert.ok(out.includes("FAILURES ("), `got: ${out.slice(0, 120)}`);
    assert.ok(out.includes("panicked at src/lib.rs:42:9"));
    assert.ok(out.includes("test result: FAILED. 29 passed; 1 failed"));
    assert.ok(!out.includes("case_12 ... ok"), "drops passing noise");
  });

  it("parses go test text mode (per-package lines + FAIL blocks)", () => {
    const run = [
      ...Array.from({ length: 20 }, (_, i) => `=== RUN   TestCase${i}\n--- PASS: TestCase${i} (0.01s)`),
      "=== RUN   TestRateLimit",
      "--- FAIL: TestRateLimit (0.03s)",
      "    api_test.go:41: expected 429, got 200",
      "PASS",
      "ok      pkg/auth    0.012s",
      "FAIL",
      "FAIL    pkg/api     0.031s",
      "?       pkg/util    [no test files]",
    ].join("\n");
    const before = patternCount("cmd:go_test_output");
    const { out } = compressWithCommand("go test ./...", run);
    assert.strictEqual(patternCount("cmd:go_test_output"), before + 1);
    assert.ok(out.includes("Go test: 2 packages ok, 1 failed"), `got: ${out.slice(0, 120)}`);
    assert.ok(out.includes("--- FAIL: TestRateLimit"));
    assert.ok(out.includes("api_test.go:41: expected 429, got 200"));
    assert.ok(out.includes("FAIL    pkg/api"));
    assert.ok(!out.includes("--- PASS: TestCase12"), "drops passing noise");
  });

  it("parses go test -json event streams", () => {
    const events = [
      { Action: "run", Package: "pkg/api", Test: "TestRateLimit" },
      { Action: "output", Package: "pkg/api", Test: "TestRateLimit", Output: "=== RUN   TestRateLimit\n" },
      { Action: "output", Package: "pkg/api", Test: "TestRateLimit", Output: "    api_test.go:41: expected 429, got 200\n" },
      { Action: "fail", Package: "pkg/api", Test: "TestRateLimit", Elapsed: 0.03 },
      ...Array.from({ length: 20 }, (_, i) => ({ Action: "pass", Package: "pkg/api", Test: `TestOther${i}`, Elapsed: 0.01 })),
      { Action: "fail", Package: "pkg/api", Elapsed: 0.05 },
    ];
    const before = patternCount("cmd:go_test_output");
    const { out } = compressWithCommand("go test -json ./...", events.map(e => JSON.stringify(e)).join("\n"));
    assert.strictEqual(patternCount("cmd:go_test_output"), before + 1);
    assert.ok(out.includes("Go test: 20 passed, 1 failed"), `got: ${out.slice(0, 120)}`);
    assert.ok(out.includes("FAIL pkg/api > TestRateLimit"));
    assert.ok(out.includes("api_test.go:41"), "keeps t.Errorf output");
  });

  it("compresses gh pr list tables with exact counts", () => {
    const rows = Array.from({ length: 40 }, (_, i) =>
      `${100 - i}\tA pull request title that describes change number ${i}\tfeat/branch-${i}\tOPEN\t2026-07-0${(i % 9) + 1}T10:00:00Z`);
    const before = patternCount("cmd:gh_list_output");
    const { out } = compressWithCommand("gh pr list --limit 100", rows.join("\n"));
    assert.strictEqual(patternCount("cmd:gh_list_output"), before + 1);
    assert.ok(out.startsWith("40 items:"), `got: ${out.slice(0, 80)}`);
    assert.ok(out.includes("[open] #100"), "state + number preserved");
    assert.ok(out.includes("(feat/branch-0)"), "branch preserved");
    assert.ok(!out.includes("2026-07-01T"), "timestamps dropped");
    assert.ok(out.includes("+10 more (40 total)"), "exact count marker");
  });

  it("does NOT reformat gh output when the command asked for --json", () => {
    const json = JSON.stringify(Array.from({ length: 30 }, (_, i) =>
      ({ number: i + 1, title: `PR number ${i + 1} with a reasonably long title`, state: "OPEN" })));
    const before = patternCount("cmd:gh_list_output");
    compressWithCommand("gh pr list --json number,title,state", json);
    assert.strictEqual(patternCount("cmd:gh_list_output"), before,
      "explicit --json output must not be reformatted by the gh compressor");
  });

  it("allows display-only pipes but not transforming ones", () => {
    const before = patternCount("cmd:container_output");
    compressWithCommand("docker ps | head -20", AMBIGUOUS_TABLE);
    assert.strictEqual(patternCount("cmd:container_output"), before + 1);
    // `| sort` transforms output — no dispatch, and shape detection rejects
    // the ambiguous header, so the text must survive.
    const { out } = compressWithCommand("docker ps | sort", AMBIGUOUS_TABLE);
    assert.strictEqual(patternCount("cmd:container_output"), before + 1);
    assert.ok(out.includes("abc39def"));
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
