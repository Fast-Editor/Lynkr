/**
 * Tool Result Compressor
 *
 * RTK-inspired compression for tool_result blocks in client mode.
 * Detects known output patterns (test runners, git, lint, builds, file reads)
 * and compresses them before they reach the model.
 *
 * @module context/tool-result-compressor
 */

const logger = require("../logger");

// ── Tee Recovery Cache ───────────────────────────────────────────────

const teeCache = new Map();
const TEE_MAX_SIZE = 200;
const TEE_TTL_MS = 5 * 60 * 1000; // 5 minutes
let teeCounter = 0;

function teeStore(original) {
  if (teeCache.size >= TEE_MAX_SIZE) {
    const oldest = teeCache.keys().next().value;
    teeCache.delete(oldest);
  }
  const id = `tee_${Date.now()}_${teeCounter++}`;
  teeCache.set(id, { content: original, createdAt: Date.now() });
  return id;
}

function teeGet(id) {
  const entry = teeCache.get(id);
  if (!entry) return null;
  if (Date.now() - entry.createdAt > TEE_TTL_MS) {
    teeCache.delete(id);
    return null;
  }
  return entry.content;
}

// ── Metrics ──────────────────────────────────────────────────────────

const metrics = {
  totalToolResults: 0,
  compressed: 0,
  tokensOriginal: 0,
  tokensAfter: 0,
  patterns: {},
};

function recordMetric(pattern, originalLen, compressedLen) {
  metrics.totalToolResults++;
  metrics.compressed++;
  metrics.tokensOriginal += Math.ceil(originalLen / 4);
  metrics.tokensAfter += Math.ceil(compressedLen / 4);
  if (!metrics.patterns[pattern]) {
    metrics.patterns[pattern] = { count: 0, tokensSaved: 0 };
  }
  metrics.patterns[pattern].count++;
  const saved = Math.ceil((originalLen - compressedLen) / 4);
  metrics.patterns[pattern].tokensSaved += saved;
  try {
    require('../routing/telemetry').recordSavings('compression', saved);
  } catch { /* telemetry is best-effort */ }
}

function getMetrics() {
  return {
    ...metrics,
    savingsPercent: metrics.tokensOriginal > 0
      ? Math.round((1 - metrics.tokensAfter / metrics.tokensOriginal) * 100)
      : 0,
    topSavings: Object.entries(metrics.patterns)
      .map(([pattern, data]) => ({ pattern, ...data }))
      .sort((a, b) => b.tokensSaved - a.tokensSaved),
  };
}

// ── Pattern Detectors & Compressors ──────────────────────────────────
//
// Compressors take (text, opts). opts.trusted means the dispatcher KNOWS
// which command produced this output (see command-aware dispatch below),
// so a compressor may relax its shape-detection guards — those guards
// exist only to avoid misfiring on unknown text.

function stripAnsi(text) {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

// 1. Test output (jest, vitest, pytest, cargo test, go test, rspec)
function compressTestOutput(text, opts = {}) {
  const isTest = /(?:Tests?:?\s+\d+\s+(?:passed|failed)|PASSED|FAILED|test result:|✓|✗|✘|PASS |FAIL |\d+ passing|\d+ failing|test session starts|=+ short test summary|tests? (?:passed|failed)|ok \d+|not ok \d+)/i.test(text);
  if (!isTest) return null;

  const lines = text.split("\n");
  const failures = [];
  const summary = [];
  let inFailure = false;
  let failureBuffer = [];

  for (const line of lines) {
    const trimmed = line.trim();

    // Capture summary lines
    if (/(?:Tests?:?\s+\d|test result:|tests? passed|tests? failed|\d+ passing|\d+ failing|Test Suites?:|Ran \d+ test)/i.test(trimmed)) {
      summary.push(trimmed);
      continue;
    }

    // Detect failure start
    if (/(?:FAIL|FAILED|✗|✘|not ok|ERRORS?|AssertionError|assert|panicked|Error:|×)/i.test(trimmed) && !inFailure) {
      inFailure = true;
      failureBuffer = [line];
      continue;
    }

    // Accumulate failure details (indented or stack trace)
    if (inFailure) {
      if (trimmed === "" || (/^(?:✓|✗|PASS|FAIL|ok \d|not ok|test |Tests:)/i.test(trimmed) && !trimmed.startsWith(" "))) {
        failures.push(failureBuffer.join("\n"));
        failureBuffer = [];
        inFailure = false;
        // Check if this line starts a new failure
        if (/(?:FAIL|FAILED|✗|✘|not ok)/i.test(trimmed)) {
          inFailure = true;
          failureBuffer = [line];
        }
      } else {
        failureBuffer.push(line);
      }
    }
  }
  if (failureBuffer.length > 0) failures.push(failureBuffer.join("\n"));

  if (summary.length === 0 && failures.length === 0) return null;

  // Corroboration: one summary-looking line alone is not a test run — a
  // README quoting "1041 passing" would otherwise compress the whole doc
  // down to that quote. Require failures, a second summary line, or at
  // least three per-test result markers before treating it as a test run.
  // Skipped when the dispatcher knows the command was a test runner.
  if (!opts.trusted && failures.length === 0 && summary.length < 2) {
    const perTestMarkers = lines.filter(l =>
      /^\s*(?:✓|✔|✗|✘|ok \d+|not ok \d+|PASS\b|FAIL\b)/.test(l.trim())
    ).length;
    if (perTestMarkers < 3) return null;
  }

  const parts = [];
  if (summary.length > 0) parts.push(summary.join("\n"));
  if (failures.length > 0) {
    parts.push("Failures:\n" + failures.join("\n---\n"));
  }
  return parts.join("\n\n") || null;
}

// 1b. Jest/Vitest structured output. Command-dispatch only (never runs on
// shape detection). Ported from 9router RTK's vitest parser
// (rtk/src/cmds/js/vitest_cmd.rs): Tier 1 parses the shared jest
// --json / vitest --reporter=json schema (with RTK's extract_json_object
// fallback for pnpm/dotenv-prefixed output), Tier 2 regex-extracts the
// default text reporters, Tier 3 falls back to the generic test
// compressor. RTK forces --json when it runs the command; Lynkr only
// sees the output, so Tier 2 is our common case.

const JS_TEST_MAX_FAILURES = 20;
const JS_TEST_MAX_SUITES = 40;
const JS_TEST_FAILURE_LINES = 8;

function extractJsonObject(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

function compressJsTestOutput(text, opts = {}) {
  const clean = stripAnsi(text);

  // Tier 1: jest --json / vitest --reporter=json (shared schema)
  let json = null;
  try { json = JSON.parse(clean.trim()); } catch { json = extractJsonObject(clean); }
  if (json && typeof json.numTotalTests === "number" && Array.isArray(json.testResults)) {
    const parts = [];
    let summary = `Tests: ${json.numPassedTests} passed, ${json.numFailedTests} failed`;
    if (json.numPendingTests) summary += `, ${json.numPendingTests} skipped`;
    summary += ` (${json.numTotalTests} total)`;
    parts.push(summary);

    const suites = [];
    const failures = [];
    for (const file of json.testResults) {
      const asserts = Array.isArray(file.assertionResults) ? file.assertionResults : [];
      const failed = asserts.filter(t => t && t.status === "failed");
      suites.push(`  ${failed.length ? "FAIL" : "PASS"} ${file.name} (${asserts.length - failed.length}/${asserts.length})`);
      for (const t of failed) {
        const msg = (t.failureMessages || []).join("\n")
          .split("\n").slice(0, JS_TEST_FAILURE_LINES).join("\n");
        failures.push(`✗ ${t.fullName}\n${msg}`);
      }
    }
    if (suites.length > 0) {
      const shown = suites.slice(0, JS_TEST_MAX_SUITES);
      if (suites.length > shown.length) shown.push(`  ... +${suites.length - shown.length} more suites`);
      parts.push("Suites:\n" + shown.join("\n"));
    }
    if (failures.length > 0) {
      const shown = failures.slice(0, JS_TEST_MAX_FAILURES);
      let block = "Failures:\n" + shown.join("\n---\n");
      if (failures.length > shown.length) block += `\n... +${failures.length - shown.length} more failures`;
      parts.push(block);
    }
    return parts.join("\n\n");
  }

  // Tier 2: default text reporters. Anchors: vitest's `Tests  N passed`
  // block or jest's `Tests: N passed, N total` line.
  const vitestSummary = /Tests\s+(?:\d+\s+failed\s+\|\s+)?\d+\s+passed/.test(clean);
  const jestSummary = /Tests:\s+(?:\d+\s+failed,\s+)?\d+\s+passed,\s+\d+\s+total/.test(clean);
  if (vitestSummary || jestSummary) {
    const lines = clean.split("\n");
    const summary = [];
    const suites = [];
    const failures = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      const trimmed = line.trim();
      // Summary block lines (both reporters)
      if (/^(?:Test Files|Tests:?|Test Suites:|Snapshots:|Duration|Time:|Start at)\s/.test(trimmed)) {
        summary.push(trimmed);
        i++;
        continue;
      }
      // Per-suite lines: jest `PASS/FAIL path`, vitest `✓/❯/✗ path (N tests...)`
      if (/^(?:PASS|FAIL)\s+\S/.test(trimmed) || /^[✓✗×❯]\s+\S+\s+\(\d+\s+tests?/.test(trimmed)) {
        suites.push(trimmed);
        i++;
        continue;
      }
      // Failure blocks: marker line + indented continuation (RTK's
      // extract_failures_regex)
      if (/(?:\[x\]|✗|×|●|FAIL)/.test(line)) {
        const block = [trimmed];
        i++;
        while (i < lines.length && /^\s{2,}/.test(lines[i]) && lines[i].trim()) {
          block.push(lines[i].trim());
          i++;
        }
        failures.push(block.slice(0, JS_TEST_FAILURE_LINES).join("\n  "));
        continue;
      }
      i++;
    }
    if (summary.length === 0) return compressTestOutput(text, opts);
    const parts = [summary.join("\n")];
    if (suites.length > 0) {
      const shown = suites.slice(0, JS_TEST_MAX_SUITES);
      if (suites.length > shown.length) shown.push(`... +${suites.length - shown.length} more suites`);
      parts.push("Suites:\n  " + shown.join("\n  "));
    }
    if (failures.length > 0) {
      const shown = failures.slice(0, JS_TEST_MAX_FAILURES);
      let block = "Failures:\n" + shown.join("\n---\n");
      if (failures.length > shown.length) block += `\n... +${failures.length - shown.length} more failures`;
      parts.push(block);
    }
    return parts.join("\n\n");
  }

  // Tier 3: whatever the generic test compressor can make of it.
  return compressTestOutput(text, opts);
}

// 1c. Pytest output. Command-dispatch only. Ported from 9router RTK's
// pytest state machine (rtk/src/cmds/python/pytest_cmd.rs:
// filter_pytest_output + parse_summary_line).

const PYTEST_MAX_FAILURES = 10;
const PYTEST_MAX_XFAIL = 10;

function parsePytestSummaryLine(summary) {
  const counts = { passed: 0, failed: 0, skipped: 0, xfailed: 0, xpassed: 0 };
  for (const part of summary.split(",")) {
    const words = part.trim().split(/\s+/);
    for (let i = 1; i < words.length; i++) {
      const n = parseInt(words[i - 1], 10);
      if (Number.isNaN(n)) continue;
      const word = words[i];
      // Order matters: "xpassed"/"xfailed" contain "passed"/"failed".
      if (word.includes("xpassed")) counts.xpassed = n;
      else if (word.includes("xfailed")) counts.xfailed = n;
      else if (word.includes("passed")) counts.passed = n;
      else if (word.includes("failed")) counts.failed = n;
      else if (word.includes("skipped")) counts.skipped = n;
    }
  }
  return counts;
}

function compressPytestOutput(text, opts = {}) {
  const clean = stripAnsi(text);
  let state = "header";
  const failures = [];
  let currentFailure = [];
  const xfailLines = [];
  let summaryLine = "";

  for (const line of clean.split("\n")) {
    const trimmed = line.trim();

    if (trimmed.startsWith("===") && trimmed.includes("test session starts")) {
      state = "header";
      continue;
    } else if (trimmed.startsWith("===") && trimmed.includes("FAILURES")) {
      state = "failures";
      continue;
    } else if (trimmed.startsWith("===") && trimmed.includes("short test summary")) {
      state = "summary";
      if (currentFailure.length > 0) { failures.push(currentFailure.join("\n")); currentFailure = []; }
      continue;
    } else if (trimmed.startsWith("===") &&
        (trimmed.includes("passed") || trimmed.includes("failed") || trimmed.includes("skipped"))) {
      summaryLine = trimmed;
      continue;
    } else if (summaryLine === "" && !trimmed.startsWith("===") &&
        !trimmed.startsWith("FAILED") && !trimmed.startsWith("ERROR") &&
        (trimmed.includes(" passed") || trimmed.includes(" failed") || trimmed.includes(" skipped")) &&
        trimmed.includes(" in ")) {
      // quiet mode (-q): bare summary without === wrapper
      summaryLine = trimmed;
      continue;
    }

    if (state === "failures") {
      if (trimmed.startsWith("___")) {
        if (currentFailure.length > 0) { failures.push(currentFailure.join("\n")); currentFailure = []; }
        currentFailure.push(trimmed);
      } else if (trimmed && !trimmed.startsWith("===")) {
        currentFailure.push(trimmed);
      }
    } else if (state === "summary") {
      if (trimmed.startsWith("FAILED") || trimmed.startsWith("ERROR")) failures.push(trimmed);
      else if (trimmed.startsWith("XFAIL") || trimmed.startsWith("XPASS")) xfailLines.push(trimmed);
    }
  }
  if (currentFailure.length > 0) failures.push(currentFailure.join("\n"));

  const c = parsePytestSummaryLine(summaryLine);
  if (c.passed === 0 && c.failed === 0 && c.skipped === 0 && c.xfailed === 0 && c.xpassed === 0) {
    return compressTestOutput(text, opts);
  }

  const extras = c.skipped > 0 || c.xfailed > 0 || c.xpassed > 0 || xfailLines.length > 0;
  if (c.failed === 0 && c.passed > 0 && !extras && failures.length === 0) {
    return `Pytest: ${c.passed} passed`;
  }

  let out = `Pytest: ${c.passed} passed, ${c.failed} failed`;
  if (c.skipped > 0) out += `, ${c.skipped} skipped`;
  if (c.xfailed > 0) out += `, ${c.xfailed} xfailed`;
  if (c.xpassed > 0) out += `, ${c.xpassed} xpassed`;

  // XPASS in particular signals that something expected-to-fail now passes.
  if (xfailLines.length > 0) {
    out += "\n\nExpected-failure outcomes:\n" +
      xfailLines.slice(0, PYTEST_MAX_XFAIL).map(l => `  ${l.slice(0, 120)}`).join("\n");
    if (xfailLines.length > PYTEST_MAX_XFAIL) out += `\n  ... +${xfailLines.length - PYTEST_MAX_XFAIL} more`;
  }

  if (failures.length > 0) {
    out += "\n\nFailures:\n";
    const blocks = [];
    for (const [i, failure] of failures.slice(0, PYTEST_MAX_FAILURES).entries()) {
      const lines = failure.split("\n");
      const first = lines[0] || "";
      let block;
      if (first.startsWith("___")) {
        block = `${i + 1}. [FAIL] ${first.replace(/^_+|_+$/g, "").trim()}`;
      } else if (first.startsWith("FAILED") || first.startsWith("ERROR")) {
        // "FAILED tests/test_foo.py::test_bar - AssertionError: ..."
        const [testPath, ...reason] = first.split(" - ");
        block = `${i + 1}. [FAIL] ${testPath.replace(/^(?:FAILED|ERROR)\s+/, "")}`;
        if (reason.length > 0) block += `\n     ${reason.join(" - ").slice(0, 100)}`;
        blocks.push(block);
        continue;
      } else {
        block = `${i + 1}. [FAIL] ${first.slice(0, 100)}`;
      }
      // Keep the assertion/error/location lines only
      let kept = 0;
      for (const l of lines.slice(1)) {
        const lower = l.toLowerCase();
        const relevant = l.trim().startsWith(">") || l.trim().startsWith("E") ||
          lower.includes("assert") || lower.includes("error") || l.includes(".py:");
        if (relevant && kept < 3) {
          block += `\n     ${l.slice(0, 100)}`;
          kept++;
        }
      }
      blocks.push(block);
    }
    out += blocks.join("\n");
    if (failures.length > PYTEST_MAX_FAILURES) out += `\n... +${failures.length - PYTEST_MAX_FAILURES} more failures`;
  }
  return out;
}

// 1d. Cargo test output. Command-dispatch only. Ported from 9router RTK
// (rtk/src/cmds/rust/cargo_cmd.rs: filter_cargo_test +
// AggregatedTestResult).

const CARGO_MAX_FAILURES = 10;
const CARGO_TEST_RESULT_RE = /test result: (\w+)\.\s+(\d+) passed;\s+(\d+) failed;\s+(\d+) ignored;\s+(\d+) measured;\s+(\d+) filtered out(?:;\s+finished in ([\d.]+)s)?/;

function compressCargoTestOutput(text, opts = {}) {
  const clean = stripAnsi(text);
  const failures = [];
  const summaryLines = [];
  let inFailureSection = false;
  let currentFailure = [];

  for (const line of clean.split("\n")) {
    const lead = line.trimStart();
    if (lead.startsWith("Compiling") || lead.startsWith("Downloading") ||
        lead.startsWith("Downloaded") || lead.startsWith("Finished")) continue;
    if (line.startsWith("running ") || (line.startsWith("test ") && line.endsWith("... ok"))) continue;

    if (line === "failures:") { inFailureSection = true; continue; }

    if (inFailureSection) {
      if (line.startsWith("test result:")) {
        inFailureSection = false;
        summaryLines.push(line);
      } else if (line.startsWith("    ") || line.startsWith("---- ")) {
        currentFailure.push(line);
      } else if (!line.trim() && currentFailure.length > 0) {
        failures.push(currentFailure.join("\n"));
        currentFailure = [];
      } else if (line.trim()) {
        currentFailure.push(line);
      }
      continue;
    }
    if (line.startsWith("test result:")) summaryLines.push(line);
  }
  if (currentFailure.length > 0) failures.push(currentFailure.join("\n"));

  if (summaryLines.length === 0) return compressTestOutput(text, opts);

  if (failures.length === 0) {
    // All passed — aggregate the per-suite summary lines into one.
    const agg = { passed: 0, ignored: 0, filteredOut: 0, suites: 0, duration: 0, hasDuration: true };
    let allParsed = true;
    for (const line of summaryLines) {
      const m = line.match(CARGO_TEST_RESULT_RE);
      if (!m || m[1] !== "ok") { allParsed = false; break; }
      agg.passed += parseInt(m[2], 10);
      agg.ignored += parseInt(m[4], 10);
      agg.filteredOut += parseInt(m[6], 10);
      agg.suites++;
      if (m[7]) agg.duration += parseFloat(m[7]);
      else agg.hasDuration = false;
    }
    if (allParsed && agg.suites > 0) {
      const parts = [`${agg.passed} passed`];
      if (agg.ignored > 0) parts.push(`${agg.ignored} ignored`);
      if (agg.filteredOut > 0) parts.push(`${agg.filteredOut} filtered out`);
      const suiteText = agg.suites === 1 ? "1 suite" : `${agg.suites} suites`;
      return agg.hasDuration
        ? `cargo test: ${parts.join(", ")} (${suiteText}, ${agg.duration.toFixed(2)}s)`
        : `cargo test: ${parts.join(", ")} (${suiteText})`;
    }
    return summaryLines.join("\n");
  }

  let out = `FAILURES (${failures.length}):\n`;
  out += failures.slice(0, CARGO_MAX_FAILURES)
    .map((f, i) => `${i + 1}. ${f.slice(0, 240)}`).join("\n");
  if (failures.length > CARGO_MAX_FAILURES) out += `\n... +${failures.length - CARGO_MAX_FAILURES} more failures`;
  out += "\n\n" + summaryLines.join("\n");
  return out;
}

// 1e. Go test output. Command-dispatch only. Tier 1 parses the `go test
// -json` event stream (ported from 9router RTK's
// rtk/src/cmds/go/go_cmd.rs: filter_go_test_json — RTK forces -json;
// Lynkr also handles the default text mode as Tier 2).

const GO_MAX_FAILURES = 10;

function compressGoTestOutput(text, opts = {}) {
  const clean = stripAnsi(text);
  const lines = clean.split("\n");

  // Tier 1: -json event stream (one JSON event per line)
  if (/^\s*\{"/.test(clean.trimStart())) {
    const packages = new Map(); // pkg -> {pass, fail, skip, failedTests: [{test, output[]}]}
    const testOutput = new Map(); // "pkg::test" -> output lines
    let events = 0;
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let ev;
      try { ev = JSON.parse(trimmed); } catch { continue; }
      if (!ev || typeof ev.Action !== "string") continue;
      events++;
      const pkg = ev.Package || "unknown";
      if (!packages.has(pkg)) packages.set(pkg, { pass: 0, fail: 0, skip: 0, failedTests: [] });
      const p = packages.get(pkg);
      if (ev.Action === "pass" && ev.Test) p.pass++;
      else if (ev.Action === "skip" && ev.Test) p.skip++;
      else if (ev.Action === "fail" && ev.Test) {
        p.fail++;
        const key = `${pkg}::${ev.Test}`;
        p.failedTests.push({ test: ev.Test, output: testOutput.get(key) || [] });
        testOutput.delete(key);
      } else if (ev.Action === "output" && ev.Test && ev.Output) {
        const key = `${pkg}::${ev.Test}`;
        if (!testOutput.has(key)) testOutput.set(key, []);
        testOutput.get(key).push(ev.Output.trimEnd());
      }
    }
    if (events > 0 && packages.size > 0) {
      const totalPass = [...packages.values()].reduce((n, p) => n + p.pass, 0);
      const totalFail = [...packages.values()].reduce((n, p) => n + p.fail, 0);
      const totalSkip = [...packages.values()].reduce((n, p) => n + p.skip, 0);
      if (totalFail === 0 && totalPass === 0) return compressTestOutput(text, opts);
      if (totalFail === 0) return `Go test: ${totalPass} passed in ${packages.size} packages`;
      let out = `Go test: ${totalPass} passed, ${totalFail} failed`;
      if (totalSkip > 0) out += `, ${totalSkip} skipped`;
      const blocks = [];
      for (const [pkg, p] of packages) {
        for (const ft of p.failedTests) {
          if (blocks.length >= GO_MAX_FAILURES) break;
          // Drop the === RUN / --- FAIL framing, keep the t.Errorf output
          const detail = ft.output
            .filter(l => l.trim() && !/^(?:=== RUN|--- FAIL|=== (?:PAUSE|CONT))/.test(l.trim()))
            .slice(0, 5).map(l => `  ${l.trim()}`).join("\n");
          blocks.push(`FAIL ${pkg} > ${ft.test}` + (detail ? `\n${detail}` : ""));
        }
      }
      if (blocks.length > 0) out += "\n\nFailures:\n" + blocks.join("\n---\n");
      if (totalFail > blocks.length) out += `\n... +${totalFail - blocks.length} more failures`;
      return out;
    }
  }

  // Tier 2: default text mode — keep per-package ok/FAIL lines and
  // `--- FAIL:` blocks with their indented output; drop === RUN / --- PASS.
  const pkgLines = [];
  const failBlocks = [];
  let i = 0;
  let sawGoShape = false;
  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();
    if (/^(?:ok|FAIL|---\s|===\s|\?)\s/.test(trimmed) || trimmed === "PASS" || trimmed === "FAIL") sawGoShape = true;
    if (/^(?:ok\s+\S+|FAIL\s+\S+|\?\s+\S+\s+\[no test files\])/.test(trimmed)) {
      pkgLines.push(trimmed);
      i++;
      continue;
    }
    if (/^--- FAIL:/.test(trimmed)) {
      const block = [trimmed];
      i++;
      while (i < lines.length && /^\s{4,}/.test(lines[i]) && lines[i].trim()) {
        block.push(lines[i].trim());
        i++;
      }
      failBlocks.push(block.slice(0, 6).join("\n  "));
      continue;
    }
    i++;
  }
  if (!sawGoShape || pkgLines.length === 0) return compressTestOutput(text, opts);

  const failedPkgs = pkgLines.filter(l => l.startsWith("FAIL")).length;
  const okPkgs = pkgLines.length - failedPkgs;
  let out = `Go test: ${okPkgs} package${okPkgs === 1 ? "" : "s"} ok, ${failedPkgs} failed`;
  if (failBlocks.length > 0) {
    out += "\n\nFailures:\n" + failBlocks.slice(0, GO_MAX_FAILURES).join("\n---\n");
    if (failBlocks.length > GO_MAX_FAILURES) out += `\n... +${failBlocks.length - GO_MAX_FAILURES} more failures`;
  }
  out += "\n\nPackages:\n  " + pkgLines.slice(0, 30).join("\n  ");
  if (pkgLines.length > 30) out += `\n  ... +${pkgLines.length - 30} more (${pkgLines.length} total)`;
  return out;
}

// 2. Git diff
function compressGitDiff(text) {
  if (!text.startsWith("diff --git") && !text.includes("\ndiff --git")) return null;

  const files = [];
  let currentFile = null;
  let additions = 0;
  let deletions = 0;
  let changedLines = [];

  for (const line of text.split("\n")) {
    if (line.startsWith("diff --git")) {
      if (currentFile) {
        files.push({ file: currentFile, additions, deletions, changes: changedLines.slice(0, 20) });
      }
      const match = line.match(/diff --git a\/(.+?) b\//);
      currentFile = match ? match[1] : "unknown";
      additions = 0;
      deletions = 0;
      changedLines = [];
    } else if (line.startsWith("+") && !line.startsWith("+++")) {
      additions++;
      changedLines.push(line);
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      deletions++;
      changedLines.push(line);
    }
  }
  if (currentFile) {
    files.push({ file: currentFile, additions, deletions, changes: changedLines.slice(0, 20) });
  }

  if (files.length === 0) return null;

  return files.map(f => {
    const header = `${f.file} (+${f.additions}/-${f.deletions})`;
    const changes = f.changes.length > 0 ? "\n" + f.changes.join("\n") : "";
    const truncated = f.additions + f.deletions > 20 ? `\n... ${f.additions + f.deletions - 20} more lines` : "";
    return header + changes + truncated;
  }).join("\n\n");
}

// 3. Git status
function compressGitStatus(text) {
  // Anchor on git-status STRUCTURE (branch line or section headers), not on
  // bare "modified:" / "new file:" substrings — source code or prose that
  // merely contains those strings must not be compressed into a fake status.
  if (!text.includes("Changes not staged") && !text.includes("Changes to be committed") &&
      !text.includes("Untracked files") && !/^On branch \S+/m.test(text) &&
      !/^HEAD detached/m.test(text)) return null;

  const staged = [];
  const modified = [];
  const untracked = [];
  let section = null;

  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.includes("Changes to be committed")) section = "staged";
    else if (trimmed.includes("Changes not staged")) section = "modified";
    else if (trimmed.includes("Untracked files")) section = "untracked";
    else if (trimmed.startsWith("modified:")) (section === "staged" ? staged : modified).push("M " + trimmed.replace("modified:", "").trim());
    else if (trimmed.startsWith("new file:")) staged.push("A " + trimmed.replace("new file:", "").trim());
    else if (trimmed.startsWith("deleted:")) (section === "staged" ? staged : modified).push("D " + trimmed.replace("deleted:", "").trim());
    else if (section === "untracked" && trimmed && !trimmed.startsWith("(") && !trimmed.startsWith("no changes")) {
      untracked.push("? " + trimmed);
    }
  }

  const branchMatch = text.match(/On branch (\S+)/);
  const parts = [];
  if (branchMatch) parts.push(`branch: ${branchMatch[1]}`);
  if (staged.length > 0) parts.push(`staged: ${staged.join(", ")}`);
  if (modified.length > 0) parts.push(`modified: ${modified.join(", ")}`);
  if (untracked.length > 0) parts.push(`untracked: ${untracked.join(", ")}`);

  return parts.length > 0 ? parts.join("\n") : null;
}

// 4. Git log
function compressGitLog(text) {
  if (!/^commit [a-f0-9]{40}/m.test(text)) return null;

  const commits = [];
  const re = /commit ([a-f0-9]{40})\n(?:Merge: .+\n)?Author:\s*(.+?)\nDate:\s*(.+?)\n\n\s*(.+)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    commits.push(`${m[1].substring(0, 7)} ${m[4].trim()} (${m[2].trim().split(" <")[0]}, ${m[3].trim()})`);
  }

  return commits.length > 0 ? commits.join("\n") : null;
}

// 5. Directory listings (ls, find, tree)
function compressDirectoryListing(text, opts = {}) {
  const lines = text.split("\n").filter(l => l.trim());
  if (lines.length < 10) return null;

  // Detect: mostly file paths (one per line). A known ls/find/tree command
  // skips this check — real listings can contain names (spaces, unicode)
  // the shape regex would reject.
  if (!opts.trusted) {
    const pathLines = lines.filter(l => /^[.\w\/-]+\.\w+$/.test(l.trim()) || /^[.\w\/-]+\/$/.test(l.trim()) || /^[-drwx]{10}/.test(l.trim()));
    if (pathLines.length < lines.length * 0.6) return null;
  }

  // Group by directory
  const dirs = {};
  for (const line of lines) {
    const trimmed = line.trim().replace(/^[-drwxlrwst@.+\s\d]+\s+\w+\s+\w+\s+[\d,]+\s+\w+\s+\d+\s+[\d:]+\s+/, ""); // strip ls -la prefix
    const parts = trimmed.split("/");
    if (parts.length > 1) {
      const dir = parts.slice(0, -1).join("/");
      if (!dirs[dir]) dirs[dir] = [];
      dirs[dir].push(parts[parts.length - 1]);
    } else {
      if (!dirs["./"]) dirs["./"] = [];
      dirs["./"].push(trimmed);
    }
  }

  const result = Object.entries(dirs)
    .sort((a, b) => b[1].length - a[1].length)
    .map(([dir, files]) => {
      if (files.length <= 5) return `${dir}: ${files.join(", ")}`;
      return `${dir}: ${files.slice(0, 3).join(", ")} ... +${files.length - 3} more (${files.length} total)`;
    });

  return result.length > 0 ? result.join("\n") : null;
}

// 6. Lint output (eslint, tsc, ruff, clippy, biome). Grouping by rule and
// by file ported from 9router RTK's lint filter
// (rtk/src/cmds/js/lint_cmd.rs: filter_eslint_json + compact_path).

const LINT_MAX_RULES = 15;
const LINT_MAX_FILES = 8;

// Compact file path (remove common prefixes) — RTK's compact_path.
function compactPath(path) {
  const p = path.replace(/\\/g, "/");
  const srcPos = p.lastIndexOf("/src/");
  if (srcPos !== -1) return "src/" + p.slice(srcPos + 5);
  const libPos = p.lastIndexOf("/lib/");
  if (libPos !== -1) return "lib/" + p.slice(libPos + 5);
  return p;
}

// ESLint `-f json`: array of {filePath, messages[], errorCount, warningCount}
function formatEslintJson(results) {
  const totalErrors = results.reduce((n, r) => n + (r.errorCount || 0), 0);
  const totalWarnings = results.reduce((n, r) => n + (r.warningCount || 0), 0);
  const withIssues = results.filter(r => r.messages.length > 0);
  if (totalErrors === 0 && totalWarnings === 0) return "ESLint: No issues found";

  const byRule = new Map();
  for (const r of withIssues) {
    for (const m of r.messages) {
      if (m && m.ruleId) byRule.set(m.ruleId, (byRule.get(m.ruleId) || 0) + 1);
    }
  }

  const out = [`ESLint: ${totalErrors} errors, ${totalWarnings} warnings in ${withIssues.length} files`];
  const rules = [...byRule.entries()].sort((a, b) => b[1] - a[1]);
  if (rules.length > 0) {
    out.push("Top rules:");
    for (const [rule, count] of rules.slice(0, 10)) out.push(`  ${rule} (${count}x)`);
  }
  const byFile = withIssues
    .map(r => ({ r, count: r.messages.length }))
    .sort((a, b) => b.count - a.count);
  out.push("Top files:");
  for (const { r, count } of byFile.slice(0, LINT_MAX_FILES)) {
    out.push(`  ${compactPath(r.filePath)} (${count} issues)`);
    const fileRules = new Map();
    for (const m of r.messages) {
      if (m && m.ruleId) fileRules.set(m.ruleId, (fileRules.get(m.ruleId) || 0) + 1);
    }
    for (const [rule, n] of [...fileRules.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3)) {
      out.push(`    ${rule} (${n})`);
    }
  }
  if (byFile.length > LINT_MAX_FILES) out.push(`  ... +${byFile.length - LINT_MAX_FILES} more files`);
  return out.join("\n");
}

function compressLintOutput(text, opts = {}) {
  const clean = stripAnsi(text);

  // ESLint JSON reporter output — precise schema check so shape mode
  // can't misread arbitrary JSON arrays.
  const trimmedText = clean.trim();
  if (trimmedText.startsWith("[")) {
    let parsed = null;
    try { parsed = JSON.parse(trimmedText); } catch { /* not JSON */ }
    if (Array.isArray(parsed) && parsed.length > 0 &&
        parsed.every(r => r && typeof r.filePath === "string" && Array.isArray(r.messages) &&
          typeof r.errorCount === "number")) {
      return formatEslintJson(parsed);
    }
  }

  // Detect lint patterns: file:line:col or rule IDs. A known lint/tsc
  // command skips this gate (it misses tsc's `(line,col): error TSxxxx`
  // form; the per-line parsers below still decide what counts).
  const hasLintPattern = /(?:\d+:\d+\s+(?:error|warning)|error\[E\d+\]|:\d+:\d+:?\s+\w+\/[\w-]+|✖|⚠)/i.test(clean);
  if (!hasLintPattern && !opts.trusted) return null;

  const ruleGroups = {};
  const fileGroups = {};
  let errorCount = 0;
  let warningCount = 0;
  let currentFile = null;

  const record = (rule, severity, file) => {
    if (!ruleGroups[rule]) ruleGroups[rule] = { count: 0, severity };
    ruleGroups[rule].count++;
    if (severity === "error") errorCount++;
    else warningCount++;
    if (file) {
      if (!fileGroups[file]) fileGroups[file] = { count: 0, rules: {} };
      fileGroups[file].count++;
      fileGroups[file].rules[rule] = (fileGroups[file].rules[rule] || 0) + 1;
    }
  };

  for (const line of clean.split("\n")) {
    // ESLint stylish prints each file as a standalone path line above its
    // issue block — track it so issues group per file.
    if (/^\S+[\/\\]\S+\.\w+$/.test(line.trim()) && !line.includes(":")) {
      currentFile = line.trim();
      continue;
    }

    // ESLint stylish issue: line:col  error/warning  message  rule-name
    const eslintMatch = line.match(/(\d+:\d+)\s+(error|warning)\s+(.+?)\s+([\w\-/@]+)\s*$/i);
    if (eslintMatch) {
      const [, , severity, , rule] = eslintMatch;
      record(rule, severity.toLowerCase(), currentFile);
      continue;
    }

    // Biome: file.ts:10:5 lint/group/ruleName ━━━ (also assist/, syntax/)
    const biomeMatch = line.match(/^(\S+?):(\d+):(\d+)\s+((?:lint|assist|syntax)\/[\w/.-]+)/);
    if (biomeMatch) {
      const [, file, , , rule] = biomeMatch;
      record(rule, "error", file);
      continue;
    }

    // TypeScript style: file(line,col): error TSxxxx: message
    // (regex per 9router RTK's tsc parser, src/cmds/js/tsc_cmd.rs)
    const tsMatch = line.match(/^(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+(TS\d+):\s+(.+)$/);
    if (tsMatch) {
      const [, file, , , severity, code] = tsMatch;
      record(code, severity, file.trim());
      continue;
    }

    // Rust clippy: error[Exxxx]: message
    const rustMatch = line.match(/^(error|warning)\[(\w+)\]:\s*(.+)/);
    if (rustMatch) {
      const [, severity, code] = rustMatch;
      record(code, severity, null);
    }
  }

  if (Object.keys(ruleGroups).length === 0) return null;

  const sorted = Object.entries(ruleGroups)
    .sort((a, b) => b[1].count - a[1].count);

  const summary = [`${errorCount} errors, ${warningCount} warnings`];
  for (const [rule, data] of sorted.slice(0, LINT_MAX_RULES)) {
    summary.push(`  ${rule}: ${data.count}x (${data.severity})`);
  }
  if (sorted.length > LINT_MAX_RULES) summary.push(`  ... +${sorted.length - LINT_MAX_RULES} more rules`);

  const files = Object.entries(fileGroups).sort((a, b) => b[1].count - a[1].count);
  if (files.length > 1) {
    summary.push("Top files:");
    for (const [file, data] of files.slice(0, LINT_MAX_FILES)) {
      summary.push(`  ${compactPath(file)} (${data.count} issues)`);
      const topRules = Object.entries(data.rules).sort((a, b) => b[1] - a[1]).slice(0, 3);
      for (const [rule, n] of topRules) summary.push(`    ${rule} (${n})`);
    }
    if (files.length > LINT_MAX_FILES) summary.push(`  ... +${files.length - LINT_MAX_FILES} more files`);
  }

  return summary.join("\n");
}

// 7. Build output (npm, cargo, webpack)
function compressBuildOutput(text) {
  const isBuild = /(?:Compiling|Building|Bundling|compiled|webpack|Successfully|ERROR in|Build error|npm warn|npm error)/i.test(text);
  if (!isBuild) return null;

  const lines = text.split("\n");
  const errors = [];
  const warnings = [];
  let successLine = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (/(?:error|ERROR|failed|FAILED)/i.test(trimmed) && !/warning/i.test(trimmed)) {
      errors.push(trimmed);
    } else if (/(?:warning|WARN)/i.test(trimmed)) {
      if (warnings.length < 5) warnings.push(trimmed); // Cap warnings
    } else if (/(?:compiled|Successfully|Build complete|Finished)/i.test(trimmed)) {
      successLine = trimmed;
    }
  }

  if (errors.length === 0 && !successLine) return null;

  const parts = [];
  if (successLine) parts.push(successLine);
  if (errors.length > 0) parts.push("Errors:\n" + errors.join("\n"));
  if (warnings.length > 0) {
    const totalWarnings = (text.match(/warning/gi) || []).length;
    parts.push(`Warnings (${totalWarnings} total, showing ${warnings.length}):\n` + warnings.join("\n"));
  }

  return parts.join("\n\n");
}

// 8. Large file / code skeleton
function compressLargeFile(text) {
  const lines = text.split("\n");
  if (lines.length < 80) return null;

  // Detect code-like content
  const codeIndicators = lines.filter(l =>
    /^(?:import |from |require\(|export |function |class |def |fn |pub |const |let |var |type |interface |struct |enum |module |package |#include|using |namespace )/.test(l.trim())
  ).length;

  if (codeIndicators < 3) return null; // Not code

  // Extract structural skeleton
  const skeleton = [];
  let inBlock = false;
  let braceDepth = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Always keep: imports, exports, function/class/type signatures
    if (/^(?:import |from |require\(|export |#include|using |package )/.test(trimmed)) {
      skeleton.push(line);
      continue;
    }

    if (/^(?:(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function|class|interface|type|enum|struct|trait|impl|def|fn|pub\s+fn|pub\s+struct|pub\s+enum|const|let|var)\s)/.test(trimmed)) {
      skeleton.push(line);
      // If it's a one-liner, keep it
      if (trimmed.endsWith(";") || trimmed.endsWith(",")) continue;
      // Otherwise mark that we're entering a block
      if (trimmed.includes("{") || trimmed.endsWith(":")) {
        skeleton.push("  // ... implementation");
      }
      continue;
    }

    // Keep decorators/attributes
    if (/^[@#\[]/.test(trimmed)) {
      skeleton.push(line);
      continue;
    }
  }

  if (skeleton.length < 5) return null;

  return `[${lines.length} lines, showing skeleton]\n` + skeleton.join("\n");
}

// 9. JSON response compression
function compressJSON(text) {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return null;
  if (trimmed.length < 500) return null;

  try {
    const parsed = JSON.parse(trimmed);
    // Don't compress search/fetch results — they ARE the content the model needs
    if (parsed && typeof parsed === "object") {
      if (Array.isArray(parsed.results) && parsed.results.some(r => r?.url || r?.snippet || r?.content || r?.title)) {
        return null; // Looks like search results — preserve
      }
      if (parsed.url && (parsed.body || parsed.content || parsed.text || parsed.html)) {
        return null; // Looks like a fetched page — preserve
      }
    }
    const structure = extractJSONStructure(parsed, 0, 3);
    return `[JSON structure, ${trimmed.length} chars original]\n` + JSON.stringify(structure, null, 2);
  } catch {
    return null;
  }
}

function extractJSONStructure(obj, depth, maxDepth) {
  if (depth >= maxDepth) return typeof obj === "object" ? (Array.isArray(obj) ? `[Array:${obj.length}]` : "{...}") : typeof obj;
  if (Array.isArray(obj)) {
    if (obj.length === 0) return [];
    return [`${typeof obj[0] === "object" ? extractJSONStructure(obj[0], depth + 1, maxDepth) : typeof obj[0]} (×${obj.length})`];
  }
  if (typeof obj === "object" && obj !== null) {
    const result = {};
    for (const [key, value] of Object.entries(obj)) {
      if (typeof value === "object" && value !== null) {
        result[key] = extractJSONStructure(value, depth + 1, maxDepth);
      } else {
        result[key] = typeof value;
      }
    }
    return result;
  }
  return typeof obj;
}

// 10. Docker/kubectl table output (docker ps, docker images, kubectl get).
// Detection anchors on the TABLE HEADER, never on a keyword appearing
// anywhere in the text: the old /docker/i containment trigger fired on any
// `ls` output that contained "Dockerfile", truncated the listing to 10
// lines, and the model hallucinated the dropped file names.
const CONTAINER_HEADER_COLUMNS = [
  "CONTAINER ID", "IMAGE ID", "IMAGE", "COMMAND", "CREATED", "STATUS",
  "PORTS", "NAMES", "REPOSITORY", "TAG", "SIZE",
  "NAMESPACE", "NAME", "READY", "RESTARTS", "AGE", "CLUSTER-IP",
  "EXTERNAL-IP", "TYPE", "DESIRED", "CURRENT", "AVAILABLE", "UP-TO-DATE",
];
function compressContainerOutput(text, opts = {}) {
  const lines = text.split("\n").filter(l => l.trim());
  if (lines.length < 3) return null;

  // The first line must be a real docker/kubectl column header: at least
  // three known column tokens and nothing but known tokens and whitespace.
  const header = lines[0];
  let rest = header;
  let columns = 0;
  for (const col of CONTAINER_HEADER_COLUMNS) {
    if (rest.includes(col)) {
      columns++;
      rest = rest.split(col).join(" ");
    }
  }
  if (columns < 3 || rest.trim() !== "") {
    // Known docker/kubectl command: custom columns (--format, -o custom)
    // won't be in the token list, so accept any header that is visibly a
    // column row — at least two runs of 2+ spaces separating columns.
    const columnGaps = (header.match(/\S {2,}(?=\S)/g) || []).length;
    if (!opts.trusted || columnGaps < 2) return null;
  }

  const dataLines = lines.slice(1);
  if (dataLines.length <= 10) return null; // Not enough to compress

  return `${header}\n${dataLines.slice(0, 10).join("\n")}\n... +${dataLines.length - 10} more (${dataLines.length} total)`;
}

// 10b. `gh pr list` / `gh issue list` output. Command-dispatch only.
// Line format ported from 9router RTK (rtk/src/cmds/git/gh_cmd.rs:
// format_pr_list / format_issue_list). RTK re-runs gh with --json and
// formats that; Lynkr sees whatever the agent got — non-tty gh emits
// header-less tab-separated rows, tty-mode emits space-aligned columns,
// and both are handled here. Commands with an explicit --json flag are
// never dispatched (the caller asked for those exact fields).

const GH_LIST_MAX = 30;
const GH_STATE_TOKENS = new Set(["OPEN", "CLOSED", "MERGED", "DRAFT"]);

function formatGhRow(fields) {
  const number = fields[0].replace(/^#/, "");
  const title = (fields[1] || "").slice(0, 60);
  const rest = fields.slice(2)
    .filter(f => f && !/^\d{4}-\d{2}-\d{2}T/.test(f) && !/^about /.test(f));
  const state = rest.find(f => GH_STATE_TOKENS.has(f.toUpperCase()));
  const extra = rest.filter(f => f !== state).slice(0, 2);
  let line = `  ${state ? `[${state.toLowerCase()}] ` : ""}#${number} ${title}`;
  if (extra.length > 0) line += ` (${extra.join(", ")})`;
  return line;
}

function compressGhList(text) {
  const clean = stripAnsi(text);
  const trimmedText = clean.trim();

  // gh --json shape (guarded in dispatch, but an alias may still yield it)
  if (trimmedText.startsWith("[")) {
    let parsed = null;
    try { parsed = JSON.parse(trimmedText); } catch { /* not JSON */ }
    if (Array.isArray(parsed) && parsed.length > 0 &&
        parsed.every(r => r && typeof r.number === "number" && typeof r.title === "string")) {
      const rows = parsed.map(r => {
        const author = r.author && r.author.login ? ` (${r.author.login})` : "";
        const state = r.state ? `[${String(r.state).toLowerCase()}] ` : "";
        return `  ${state}#${r.number} ${r.title.slice(0, 60)}${author}`;
      });
      let out = `${parsed.length} items:\n` + rows.slice(0, GH_LIST_MAX).join("\n");
      if (rows.length > GH_LIST_MAX) out += `\n  ... +${rows.length - GH_LIST_MAX} more (${rows.length} total)`;
      return out;
    }
    return null;
  }

  // Table rows: tab-separated (non-tty) or 2+-space aligned (tty), first
  // field the PR/issue number.
  const rows = [];
  let total = 0;
  for (const line of clean.split("\n")) {
    if (!line.trim()) continue;
    if (/^Showing \d+ of \d+/i.test(line.trim())) continue; // tty header
    const fields = (line.includes("\t") ? line.split("\t") : line.trim().split(/ {2,}/))
      .map(f => f.trim()).filter(Boolean);
    if (fields.length < 2 || !/^#?\d+$/.test(fields[0])) return null; // not a gh list table
    total++;
    if (rows.length < GH_LIST_MAX) rows.push(formatGhRow(fields));
  }
  if (total === 0) return null;

  let out = `${total} items:\n` + rows.join("\n");
  if (total > rows.length) out += `\n  ... +${total - rows.length} more (${total} total)`;
  return out;
}

// 11. Grep / ripgrep output ("file:lineno:content"), per-file match cap.
// Ported from 9router RTK grep filter (rtk/src/cmds/system/pipe_cmd.rs).
const GREP_PER_FILE_MAX = 10;
function compressGrep(text) {
  const byFile = new Map();
  let total = 0;

  for (const line of text.split("\n")) {
    // splitn(3, ':') — only split on the first two colons.
    const first = line.indexOf(":");
    if (first === -1) continue;
    const second = line.indexOf(":", first + 1);
    if (second === -1) continue;
    const file = line.slice(0, first);
    const lineNumStr = line.slice(first + 1, second);
    const content = line.slice(second + 1);
    if (!/^\d+$/.test(lineNumStr)) continue;
    total++;
    if (!byFile.has(file)) byFile.set(file, []);
    byFile.get(file).push([lineNumStr, content]);
  }

  // Require a meaningful number of matches so we don't mangle prose that
  // happens to contain a "word:123:..." line.
  if (total < 5) return null;

  const files = Array.from(byFile.keys()).sort();
  let out = `${total} matches in ${files.length}F:\n\n`;
  for (const file of files) {
    const matches = byFile.get(file);
    out += `[file] ${file} (${matches.length}):\n`;
    for (const [lineNum, content] of matches.slice(0, GREP_PER_FILE_MAX)) {
      out += `  ${lineNum.padStart(4)}: ${content.trim()}\n`;
    }
    if (matches.length > GREP_PER_FILE_MAX) {
      out += `  +${matches.length - GREP_PER_FILE_MAX}\n`;
    }
    out += "\n";
  }
  return out;
}

// 12. Generic log de-duplication: collapse consecutive duplicate lines and
// runs of blank lines, with a hard line cap. Ported from 9router RTK dedupLog.
const DEDUP_LINE_MAX = 2000;
function compressDedupLog(text) {
  const lines = text.split("\n");
  const out = [];
  let prev = null;
  let runCount = 0;
  let blankStreak = 0;

  const flushRun = () => {
    if (prev !== null && runCount > 1) {
      out.push(`  ... (${runCount - 1} duplicate lines)`);
    }
  };

  for (const line of lines) {
    if (line.trim() === "") {
      if (blankStreak < 1) out.push(line);
      blankStreak += 1;
      flushRun();
      prev = null;
      runCount = 0;
      continue;
    }
    blankStreak = 0;
    if (line === prev) {
      runCount += 1;
      continue;
    }
    flushRun();
    out.push(line);
    prev = line;
    runCount = 1;
    if (out.length >= DEDUP_LINE_MAX) {
      out.push(`... (truncated at ${DEDUP_LINE_MAX} lines)`);
      return out.join("\n");
    }
  }
  flushRun();
  return out.join("\n");
}

// 13. Last-resort generic truncation: keep head + tail lines, drop the middle.
// Only kicks in for very long output no specific compressor matched.
// Ported from 9router RTK smartTruncate.
const SMART_TRUNCATE_HEAD = 120;
const SMART_TRUNCATE_TAIL = 60;
const SMART_TRUNCATE_MIN_LINES = 250;
function compressSmartTruncate(text) {
  const lines = text.split("\n");
  if (lines.length < SMART_TRUNCATE_MIN_LINES) return null;

  const head = lines.slice(0, SMART_TRUNCATE_HEAD);
  const tail = lines.slice(lines.length - SMART_TRUNCATE_TAIL);
  const cut = lines.length - head.length - tail.length;
  return [...head, `... +${cut} lines truncated`, ...tail].join("\n");
}

// ── Compression Pipeline ─────────────────────────────────────────────
//
// DETECTION RULE: a compressor's trigger must anchor on the STRUCTURE of
// its target format (header line anatomy, per-line shape, section markers)
// — never on a keyword appearing anywhere in the text. A misfire doesn't
// just waste tokens: it silently drops content the model then hallucinates
// back (live incident: /docker/i matched "Dockerfile" in an ls listing,
// truncated it to 10 lines, and the model invented the rest).

// Generic fallbacks last: dedup exact-duplicate spam, then hard head/tail
// truncation only if nothing more specific applied. Also the only layer
// that runs when a command-dispatched compressor declines (see below).
const GENERIC_FALLBACKS = [
  { name: "dedup_log", fn: compressDedupLog },
  { name: "smart_truncate", fn: compressSmartTruncate },
];

const COMPRESSORS = [
  { name: "test_output", fn: compressTestOutput },
  { name: "git_diff", fn: compressGitDiff },
  { name: "git_status", fn: compressGitStatus },
  { name: "git_log", fn: compressGitLog },
  { name: "lint_output", fn: compressLintOutput },
  { name: "build_output", fn: compressBuildOutput },
  { name: "container_output", fn: compressContainerOutput },
  { name: "json_response", fn: compressJSON },
  { name: "grep_output", fn: compressGrep },
  { name: "directory_listing", fn: compressDirectoryListing },
  { name: "large_file", fn: compressLargeFile },
  ...GENERIC_FALLBACKS,
];

// ── Command-Aware Dispatch ───────────────────────────────────────────
//
// RTK never misfires format detection because it knows the command it
// wraps. Lynkr has the command too: every tool_result's tool_use block
// carries the literal shell command in its input. When the command is
// known, dispatch straight to the matching compressor and skip shape
// detection entirely; shape anchoring (DETECTION RULE above) remains the
// fallback for unknown commands and non-shell tools. Dispatch tables
// modeled on 9router RTK's command routing (rtk/src/cmds/mod.rs).

// Shell-executing tool names across supported harnesses — see
// client-profiles.js baselines (claude-code: Bash; goose/codex: shell;
// cursor: run_terminal_command; codex v0.142+: exec_command).
const SHELL_TOOL_NAMES = new Set([
  "Bash", "bash", "shell", "run_terminal_command", "run_shell_command",
  "exec_command", "execute_command",
]);

// Ordered dispatch table: `match` tokens are checked against the
// command's non-flag tokens (first token exact after basename/runner
// stripping, rest as an in-order subsequence, so `git -C x status`
// matches). A token also matches its npm-script variants (`test` ⇢
// `test:unit`). A wrong dispatch is safe: every compressor still
// validates its input's structure and declines what it can't parse.
const COMMAND_DISPATCH = [
  { match: ["git", "status"], name: "git_status" },
  { match: ["git", "diff"], name: "git_diff" },
  { match: ["git", "log"], name: "git_log" },
  { match: ["docker", "ps"], name: "container_output" },
  { match: ["docker", "images"], name: "container_output" },
  { match: ["docker", "container"], name: "container_output" },
  { match: ["podman", "ps"], name: "container_output" },
  { match: ["kubectl", "get"], name: "container_output" },
  { match: ["ls"], name: "directory_listing" },
  { match: ["find"], name: "directory_listing" },
  { match: ["tree"], name: "directory_listing" },
  { match: ["fd"], name: "directory_listing" },
  { match: ["grep"], name: "grep_output" },
  { match: ["egrep"], name: "grep_output" },
  { match: ["rg"], name: "grep_output" },
  { match: ["tsc"], name: "lint_output" },
  { match: ["eslint"], name: "lint_output" },
  { match: ["biome"], name: "lint_output" },
  { match: ["ruff"], name: "lint_output" },
  { match: ["jest"], name: "js_test_output" },
  { match: ["vitest"], name: "js_test_output" },
  { match: ["pytest"], name: "pytest_output" },
  // `-m` is a flag, so it's already stripped before matching:
  // `python -m pytest` arrives here as [python, pytest].
  { match: ["python", "pytest"], name: "pytest_output" },
  { match: ["python3", "pytest"], name: "pytest_output" },
  { match: ["cargo", "test"], name: "cargo_test_output" },
  { match: ["cargo", "nextest"], name: "cargo_test_output" },
  { match: ["go", "test"], name: "go_test_output" },
  { match: ["gh", "pr", "list"], name: "gh_list_output" },
  { match: ["gh", "issue", "list"], name: "gh_list_output" },
  { match: ["npm", "test"], name: "test_output" },
  { match: ["yarn", "test"], name: "test_output" },
  { match: ["pnpm", "test"], name: "test_output" },
  { match: ["npm", "run", "test"], name: "test_output" },
  { match: ["yarn", "run", "test"], name: "test_output" },
  { match: ["pnpm", "run", "test"], name: "test_output" },
  { match: ["cargo", "build"], name: "build_output" },
  { match: ["npm", "run", "build"], name: "build_output" },
  { match: ["make"], name: "build_output" },
];

const COMPRESSOR_BY_NAME = new Map([
  ...COMPRESSORS.map(c => [c.name, c.fn]),
  // Dispatch-only parsers: reachable via a known command, never via shape
  // detection (their format gates are too loose to run on unknown text).
  ["js_test_output", compressJsTestOutput],
  ["pytest_output", compressPytestOutput],
  ["cargo_test_output", compressCargoTestOutput],
  ["go_test_output", compressGoTestOutput],
  ["gh_list_output", compressGhList],
]);

function extractCommandString(input) {
  if (input == null) return null;
  if (typeof input === "string") {
    // OpenAI-shaped arguments arrive as a JSON string if this ever runs
    // pre-conversion (today it runs post-conversion, Anthropic shape).
    try { input = JSON.parse(input); } catch { return null; }
  }
  const cmd = input.command ?? input.cmd ?? input.script;
  return typeof cmd === "string" && cmd.trim() ? cmd : null;
}

// Reduce a raw shell command to the tokens that identify what ran, or
// null when the output can't be attributed to a single command.
function commandTokens(raw) {
  let s = raw.trim();

  // Strip leading env assignments, wrappers, and `cd x &&` chains.
  for (;;) {
    let m;
    if ((m = s.match(/^[A-Za-z_][A-Za-z0-9_]*=(?:"(?:\\.|[^"])*"|'[^']*'|\S*)\s+/))) { s = s.slice(m[0].length); continue; }
    if ((m = s.match(/^(?:sudo|command|time|env)\s+/))) { s = s.slice(m[0].length); continue; }
    if ((m = s.match(/^cd\s+(?:"(?:\\.|[^"])*"|'[^']*'|\S+)\s*(?:&&|;)\s*/))) { s = s.slice(m[0].length); continue; }
    break;
  }

  // Separator analysis on a copy with quoted strings and redirections
  // blanked out (a `|` inside a grep pattern is not a pipe; `2>&1` is not
  // a chain).
  const bare = s
    .replace(/"(?:\\.|[^"])*"|'[^']*'/g, '""')
    .replace(/\d*>{1,2}\s*&\d+/g, " ")
    .replace(/\d*>{1,2}\s*\S+/g, " ");

  // Chained commands produce mixed output — dispatching on the first
  // command would compress the rest as the wrong format. Bail to shape
  // detection. Pipes are allowed only into display-only filters.
  if (/&&|\|\||;|&\s*$/.test(bare)) return null;
  const segments = bare.split("|");
  if (segments.slice(1).some(seg => !/^\s*(?:head|tail|cat)\b/.test(seg))) return null;

  const tokens = segments[0].trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;
  tokens[0] = tokens[0].split("/").pop(); // /usr/bin/git → git

  // Skip package-runner prefixes: npx tsc, pnpm exec eslint, bunx vitest.
  if (tokens[0] === "npx" || tokens[0] === "bunx") tokens.shift();
  else if (/^(?:npm|pnpm|yarn|bun)$/.test(tokens[0]) && /^(?:exec|dlx|x)$/.test(tokens[1] || "")) tokens.splice(0, 2);

  return tokens.length > 0 ? tokens : null;
}

function tokenMatches(pattern, token) {
  return token === pattern || token.startsWith(pattern + ":");
}

function matchDispatch(nonFlag) {
  for (const entry of COMMAND_DISPATCH) {
    if (!tokenMatches(entry.match[0], nonFlag[0])) continue;
    // Remaining pattern tokens must appear in order among the next few
    // non-flag tokens (allows `git -C x status`, `kubectl get pods -A`).
    let pos = 1;
    let ok = true;
    for (const pat of entry.match.slice(1)) {
      let found = false;
      while (pos < Math.min(nonFlag.length, 5)) {
        if (tokenMatches(pat, nonFlag[pos++])) { found = true; break; }
      }
      if (!found) { ok = false; break; }
    }
    if (ok) return { name: entry.name, fn: COMPRESSOR_BY_NAME.get(entry.name) };
  }
  return null;
}

function resolveCommandCompressor(command) {
  const tokens = commandTokens(command);
  if (!tokens) return null;
  const nonFlag = tokens.filter(t => !t.startsWith("-"));
  if (nonFlag.length === 0) return null;

  const hit = matchDispatch(nonFlag);
  if (hit) {
    // RTK rule: an explicit --json means the caller asked for those exact
    // fields — pass gh output through rather than reformatting it.
    if (hit.name === "gh_list_output" && tokens.some(t => t === "--json" || t.startsWith("--json="))) {
      return null;
    }
    return hit;
  }
  // Bare package-manager bin invocation (`yarn jest`, `pnpm vitest`):
  // no entry matched with the PM in front, retry without it — but only
  // for known JS bins. `pnpm ls` must NOT become an `ls` dispatch (its
  // output is a dependency tree, not a directory listing).
  if (nonFlag.length > 1 && /^(?:npm|pnpm|yarn|bun)$/.test(nonFlag[0]) &&
      /^(?:jest|vitest|tsc|eslint|biome)$/.test(nonFlag[1])) {
    return matchDispatch(nonFlag.slice(1));
  }
  return null;
}

// tool_use_id → command string, from the tool_use blocks that precede
// every tool_result in the message stream.
function buildCommandMap(messages) {
  const map = new Map();
  for (const msg of messages) {
    if (!Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (block.type !== "tool_use" || !block.id) continue;
      if (!SHELL_TOOL_NAMES.has(block.name)) continue;
      const cmd = extractCommandString(block.input);
      if (cmd) map.set(block.id, cmd);
    }
  }
  return map;
}

// Compression levels tied to routing tiers
const TIER_THRESHOLDS = {
  SIMPLE: 300,     // Compress if > 300 chars
  MEDIUM: 800,     // Compress if > 800 chars
  COMPLEX: 2000,   // Compress if > 2000 chars
  REASONING: Infinity, // Never compress
};

function runCompressors(list, text, opts) {
  for (const { name, fn } of list) {
    try {
      const result = fn(text, opts);
      if (result && result.length < text.length * 0.7) {
        return { compressed: result, pattern: name };
      }
    } catch (err) {
      logger.debug({ compressor: name, error: err.message }, "Compressor failed, trying next");
    }
  }
  return null;
}

function tryCompress(text, tier, command) {
  const threshold = TIER_THRESHOLDS[tier] || TIER_THRESHOLDS.MEDIUM;
  if (text.length < threshold) return null;

  // Command known → dispatch directly, no shape guessing. If the mapped
  // compressor declines (e.g. `docker ps` with 3 rows), only the generic
  // fallbacks may run: we KNOW the format, so no other structure detector
  // gets to second-guess it.
  const dispatch = command ? resolveCommandCompressor(command) : null;
  if (dispatch) {
    const hit = runCompressors([dispatch], text, { trusted: true });
    if (hit) return { compressed: hit.compressed, pattern: `cmd:${dispatch.name}` };
    return runCompressors(GENERIC_FALLBACKS, text, {});
  }

  return runCompressors(COMPRESSORS, text, {});
}

// ── Main Entry Point ─────────────────────────────────────────────────

/**
 * Compress tool_result blocks in conversation messages.
 * Scans for known output patterns and replaces with compressed versions.
 *
 * @param {Array} messages - Conversation messages (mutated in place)
 * @param {Object} options
 * @param {string} options.tier - Routing tier (SIMPLE/MEDIUM/COMPLEX/REASONING)
 * @param {boolean} options.enabled - Whether compression is enabled (default: true)
 * @returns {Object} - { compressed: number, saved: number }
 */
function compressToolResults(messages, options = {}) {
  if (options.enabled === false) return { compressed: 0, saved: 0 };
  if (!Array.isArray(messages)) return { compressed: 0, saved: 0 };

  const tier = options.tier || "MEDIUM";
  let compressedCount = 0;
  let tokensSaved = 0;

  const commandByToolUse = buildCommandMap(messages);

  for (const msg of messages) {
    if (!Array.isArray(msg.content)) continue;

    for (const block of msg.content) {
      if (block.type !== "tool_result") continue;
      if (typeof block.content !== "string") continue;

      metrics.totalToolResults++;
      const original = block.content;

      const result = tryCompress(original, tier, commandByToolUse.get(block.tool_use_id));
      if (result) {
        const teeId = teeStore(original);
        block.content = result.compressed + `\n[full: ${teeId}]`;

        recordMetric(result.pattern, original.length, block.content.length);
        compressedCount++;
        tokensSaved += Math.ceil((original.length - block.content.length) / 4);

        logger.debug({
          pattern: result.pattern,
          originalChars: original.length,
          compressedChars: block.content.length,
          savings: Math.round((1 - block.content.length / original.length) * 100) + "%",
          teeId,
        }, "Compressed tool_result");
      }
    }
  }

  if (compressedCount > 0) {
    logger.info({
      compressed: compressedCount,
      tokensSaved,
      tier,
    }, "Tool result compression applied");
  }

  return { compressed: compressedCount, saved: tokensSaved };
}

module.exports = {
  compressToolResults,
  teeGet,
  getMetrics,
};
