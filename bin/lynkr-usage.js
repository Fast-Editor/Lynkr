#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * lynkr usage — print AI spend report from routing telemetry.
 *
 * Usage:
 *   lynkr-usage                          # last 30 days
 *   lynkr-usage --days 7
 *   lynkr-usage --window 1d
 *   lynkr-usage --window all
 *   lynkr-usage --json                   # machine-readable
 *   lynkr-usage --flagship gpt-5         # alternative comparison model
 *   lynkr-usage --provider moonshot      # filter to one provider
 */

const path = require("path");

// Make sure config/logger pick up the workspace root
process.env.WORKSPACE_ROOT = process.env.WORKSPACE_ROOT || path.resolve(__dirname, "..");

const aggregator = require("../src/usage/aggregator");

function parseArgs(argv) {
  const opts = { window: "30d", json: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    if (a === "--json") opts.json = true;
    else if (a === "--card") opts.card = true;
    else if (a === "--days" && next) {
      opts.window = `${parseInt(next, 10)}d`;
      i++;
    } else if (a === "--window" && next) {
      opts.window = next;
      i++;
    } else if (a === "--since" && next) {
      opts.window = next;
      i++;
    } else if (a === "--flagship" && next) {
      opts.flagship = next;
      i++;
    } else if (a === "--provider" && next) {
      opts.provider = next;
      i++;
    } else if (a === "--model" && next) {
      opts.model = next;
      i++;
    } else if (a === "--help" || a === "-h") {
      printHelp();
      process.exit(0);
    }
  }
  return opts;
}

function printHelp() {
  console.log(`Lynkr usage report — show AI spend and tier-routing savings.

Usage:
  lynkr usage [options]

Options:
  --days N            Window in days (e.g. --days 7)
  --window <preset>   Window preset: 1d, 7d, 30d, all (default: 30d)
  --since <iso>       Custom start time (ISO 8601 or epoch ms)
  --flagship <model>  Comparison model for "savings" math (default: claude-sonnet-4-5-20250929)
  --provider <name>   Filter to a single provider
  --model <id>        Filter to a single model
  --json              Print as JSON instead of a formatted table
  -h, --help          Show this help

Examples:
  lynkr usage
  lynkr usage --days 7
  lynkr usage --window all --json
`);
}

const C = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  red: "\x1b[31m",
  gray: "\x1b[90m",
};

function colour(text, code) {
  if (!process.stdout.isTTY) return text;
  return `${code}${text}${C.reset}`;
}

function fmtUSD(n) {
  if (!n) return "$0.00";
  if (n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

function fmtTokens(n) {
  if (!n) return "0";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function fmtInt(n) {
  return new Intl.NumberFormat("en-US").format(n || 0);
}

function pad(s, width, align = "left") {
  s = String(s);
  if (s.length >= width) return s;
  const filler = " ".repeat(width - visibleLength(s));
  return align === "right" ? filler + s : s + filler;
}

function visibleLength(s) {
  // strip ANSI for column-width math
  return String(s).replace(/\x1b\[[0-9;]*m/g, "").length;
}

function tableRow(cells, widths, aligns) {
  return cells
    .map((c, i) => pad(c, widths[i], aligns[i] || "left"))
    .join("  ");
}

function printTable(rows, header, widths, aligns) {
  console.log(colour(tableRow(header, widths, aligns), C.bold));
  console.log(colour(widths.map((w) => "─".repeat(w)).join("  "), C.dim));
  for (const row of rows) {
    console.log(tableRow(row, widths, aligns));
  }
}

function bucketRows(bucket, widths) {
  return Object.entries(bucket)
    .sort((a, b) => b[1].actualCost - a[1].actualCost)
    .map(([key, b]) => [
      key,
      fmtInt(b.requests),
      fmtTokens(b.totalTokens),
      colour(fmtUSD(b.actualCost), C.cyan),
      colour(fmtUSD(b.flagshipCost), C.gray),
      colour(fmtUSD(b.saved), C.green),
      colour(`${b.savedPercent.toFixed(1)}%`, C.green),
    ]);
}

function printReport(usage) {
  const { window, since, flagship, totals, byTier, byProvider, byModel } = usage;

  const banner = `Lynkr — Usage Report`;
  console.log("");
  console.log(colour(banner, C.bold));
  console.log(
    colour(
      `window: ${window}${since ? `  since: ${since}` : ""}  flagship-comparison: ${flagship}`,
      C.dim
    )
  );
  console.log("");

  // Summary line
  const headline =
    `${fmtInt(totals.requests)} requests   ` +
    `${fmtTokens(totals.totalTokens)} tokens   ` +
    `actual ${colour(fmtUSD(totals.actualCost), C.cyan)}   ` +
    `flagship-only ${colour(fmtUSD(totals.flagshipCost), C.gray)}   ` +
    `saved ${colour(fmtUSD(totals.saved), C.green)} ` +
    colour(`(${totals.savedPercent.toFixed(1)}%)`, C.green);
  console.log(headline);
  if (totals.fallbacks || totals.errors) {
    console.log(
      colour(
        `   ${totals.fallbacks} fallback${totals.fallbacks !== 1 ? "s" : ""}, ` +
          `${totals.errors} error${totals.errors !== 1 ? "s" : ""}`,
        C.yellow
      )
    );
  }
  console.log("");

  if (totals.requests === 0) {
    console.log(colour("No telemetry yet for this window. Send some requests through Lynkr first.", C.yellow));
    return;
  }

  const headers = ["", "REQUESTS", "TOKENS", "ACTUAL", "FLAGSHIP", "SAVED", "PCT"];
  const widths = [22, 9, 9, 10, 10, 10, 7];
  const aligns = ["left", "right", "right", "right", "right", "right", "right"];

  console.log(colour("BY TIER", C.bold));
  printTable(bucketRows(byTier, widths), ["TIER", ...headers.slice(1)], widths, aligns);
  console.log("");

  console.log(colour("BY PROVIDER", C.bold));
  printTable(bucketRows(byProvider, widths), ["PROVIDER", ...headers.slice(1)], widths, aligns);
  console.log("");

  console.log(colour("BY MODEL", C.bold));
  printTable(bucketRows(byModel, widths), ["MODEL", ...headers.slice(1)], widths, aligns);
  console.log("");
}

// ---------------------------------------------------------------------------
// Shareable receipt card (`lynkr stats` / `lynkr usage --card`)
// ---------------------------------------------------------------------------

const LOCAL_PROVIDERS = new Set(["ollama", "llamacpp", "llama-cpp", "llama_cpp", "lmstudio", "lm-studio"]);

function printCard(usage, opts) {
  const { totals, byProvider, flagship, window } = usage;

  let localReqs = 0;
  let cloudReqs = 0;
  for (const [provider, bucket] of Object.entries(byProvider)) {
    if (LOCAL_PROVIDERS.has(String(provider).toLowerCase())) localReqs += bucket.requests;
    else cloudReqs += bucket.requests;
  }
  const totalReqs = localReqs + cloudReqs;
  const pct = (n) => (totalReqs > 0 ? `${Math.round((n / totalReqs) * 100)}%` : "0%");

  let savings = { total: 0, byCategory: {} };
  try {
    const telemetry = require("../src/routing/telemetry");
    const since = aggregator.resolveSince(opts.window) ?? 0;
    savings = telemetry.getSavingsSummary(since);
  } catch { /* savings table optional */ }

  const WIDTH = 46;
  const line = (label, value) => {
    const l = ` ${label}`;
    const v = `${value} `;
    const gap = Math.max(1, WIDTH - l.length - v.length);
    return `│${l}${" ".repeat(gap)}${v}│`;
  };
  const blank = `│${" ".repeat(WIDTH)}│`;

  const rows = [
    `╭${"─".repeat(WIDTH)}╮`,
    line("Lynkr — savings receipt", `last ${window}`),
    blank,
    line("Requests routed", fmtInt(totalReqs)),
    line("  local (free)", `${fmtInt(localReqs)} · ${pct(localReqs)}`),
    line("  cloud", `${fmtInt(cloudReqs)} · ${pct(cloudReqs)}`),
    blank,
  ];

  if (savings.total > 0) {
    rows.push(line("Tokens saved", fmtTokens(savings.total)));
    const labels = {
      tool_stripping: "  tool-schema stripping",
      compression: "  JSON compression",
      cache_hit: "  semantic cache hits",
    };
    for (const [cat, label] of Object.entries(labels)) {
      if (savings.byCategory[cat]) rows.push(line(label, fmtTokens(savings.byCategory[cat])));
    }
    rows.push(blank);
  }

  rows.push(line("Est. cost avoided*", fmtUSD(totals.saved)));
  rows.push(blank);
  rows.push(line("github.com/Fast-Editor/Lynkr", `v${require("../package.json").version}`));
  rows.push(`╰${"─".repeat(WIDTH)}╯`);
  rows.push(colour(`  *estimate vs routing everything to ${flagship}`, C.dim));

  console.log("");
  for (const row of rows) console.log(row);
  console.log("");
}

function main() {
  const opts = parseArgs(process.argv);
  const usage = aggregator.getUsage(opts);

  if (opts.json) {
    process.stdout.write(JSON.stringify(usage, null, 2) + "\n");
    return;
  }

  if (opts.card || process.env._LYNKR_SUBCMD === "stats") {
    printCard(usage, opts);
    return;
  }

  printReport(usage);
}

main();
