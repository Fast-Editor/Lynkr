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
  metrics.patterns[pattern].tokensSaved += Math.ceil((originalLen - compressedLen) / 4);
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

// 1. Test output (jest, vitest, pytest, cargo test, go test, rspec)
function compressTestOutput(text) {
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

  const parts = [];
  if (summary.length > 0) parts.push(summary.join("\n"));
  if (failures.length > 0) {
    parts.push("Failures:\n" + failures.join("\n---\n"));
  }
  return parts.join("\n\n") || null;
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
  if (!text.includes("Changes not staged") && !text.includes("Changes to be committed") &&
      !text.includes("Untracked files") && !text.includes("On branch") &&
      !text.includes("modified:") && !text.includes("new file:")) return null;

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
function compressDirectoryListing(text) {
  const lines = text.split("\n").filter(l => l.trim());
  if (lines.length < 10) return null;

  // Detect: mostly file paths (one per line)
  const pathLines = lines.filter(l => /^[.\w\/-]+\.\w+$/.test(l.trim()) || /^[.\w\/-]+\/$/.test(l.trim()) || /^[-drwx]{10}/.test(l.trim()));
  if (pathLines.length < lines.length * 0.6) return null;

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

// 6. Lint output (eslint, tsc, ruff, clippy, biome)
function compressLintOutput(text) {
  // Detect lint patterns: file:line:col or rule IDs
  const hasLintPattern = /(?:\d+:\d+\s+(?:error|warning)|error\[E\d+\]|:\d+:\d+:?\s+\w+\/[\w-]+|✖|⚠)/i.test(text);
  if (!hasLintPattern) return null;

  const ruleGroups = {};
  const fileGroups = {};
  let errorCount = 0;
  let warningCount = 0;

  for (const line of text.split("\n")) {
    // ESLint/Biome style: file:line:col  error/warning  message  rule-name
    const eslintMatch = line.match(/(\d+:\d+)\s+(error|warning)\s+(.+?)\s+([\w\-/@]+)\s*$/i);
    if (eslintMatch) {
      const [, , severity, , rule] = eslintMatch;
      if (!ruleGroups[rule]) ruleGroups[rule] = { count: 0, severity };
      ruleGroups[rule].count++;
      if (severity === "error") errorCount++;
      else warningCount++;
      continue;
    }

    // TypeScript style: file(line,col): error TSxxxx: message
    const tsMatch = line.match(/\((\d+,\d+)\):\s*(error)\s+(TS\d+):\s*(.+)/);
    if (tsMatch) {
      const [, , , code] = tsMatch;
      if (!ruleGroups[code]) ruleGroups[code] = { count: 0, severity: "error" };
      ruleGroups[code].count++;
      errorCount++;
      continue;
    }

    // Rust clippy: error[Exxxx]: message
    const rustMatch = line.match(/^(error|warning)\[(\w+)\]:\s*(.+)/);
    if (rustMatch) {
      const [, severity, code] = rustMatch;
      if (!ruleGroups[code]) ruleGroups[code] = { count: 0, severity };
      ruleGroups[code].count++;
      if (severity === "error") errorCount++;
      else warningCount++;
    }
  }

  if (Object.keys(ruleGroups).length === 0) return null;

  const sorted = Object.entries(ruleGroups)
    .sort((a, b) => b[1].count - a[1].count);

  const summary = [`${errorCount} errors, ${warningCount} warnings`];
  for (const [rule, data] of sorted) {
    summary.push(`  ${rule}: ${data.count}x (${data.severity})`);
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

// 10. Docker/kubectl output
function compressContainerOutput(text) {
  const isDocker = /(?:CONTAINER ID|IMAGE|PORTS|STATUS|docker|NAMESPACE|READY|RESTARTS|AGE|kubectl|pod\/)/i.test(text);
  if (!isDocker) return null;

  const lines = text.split("\n").filter(l => l.trim());
  if (lines.length < 3) return null;

  // Keep header + data rows, strip verbose columns
  const header = lines[0];
  const dataLines = lines.slice(1).filter(l => l.trim());

  if (dataLines.length <= 10) return null; // Not enough to compress

  return `${header}\n${dataLines.slice(0, 10).join("\n")}\n... +${dataLines.length - 10} more (${dataLines.length} total)`;
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
  // Generic fallbacks last: dedup exact-duplicate spam, then hard head/tail
  // truncation only if nothing more specific applied.
  { name: "dedup_log", fn: compressDedupLog },
  { name: "smart_truncate", fn: compressSmartTruncate },
];

// Compression levels tied to routing tiers
const TIER_THRESHOLDS = {
  SIMPLE: 300,     // Compress if > 300 chars
  MEDIUM: 800,     // Compress if > 800 chars
  COMPLEX: 2000,   // Compress if > 2000 chars
  REASONING: Infinity, // Never compress
};

function tryCompress(text, tier) {
  const threshold = TIER_THRESHOLDS[tier] || TIER_THRESHOLDS.MEDIUM;
  if (text.length < threshold) return null;

  for (const { name, fn } of COMPRESSORS) {
    try {
      const result = fn(text);
      if (result && result.length < text.length * 0.7) {
        return { compressed: result, pattern: name };
      }
    } catch (err) {
      logger.debug({ compressor: name, error: err.message }, "Compressor failed, trying next");
    }
  }
  return null;
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

  for (const msg of messages) {
    if (!Array.isArray(msg.content)) continue;

    for (const block of msg.content) {
      if (block.type !== "tool_result") continue;
      if (typeof block.content !== "string") continue;

      metrics.totalToolResults++;
      const original = block.content;

      const result = tryCompress(original, tier);
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
