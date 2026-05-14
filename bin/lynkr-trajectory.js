#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * lynkr trajectory — export agent trajectories from the session DB
 * as JSONL training data.
 *
 * Usage:
 *   lynkr trajectory                                     # stdout, last 30 days
 *   lynkr trajectory --since 7d                          # last 7 days
 *   lynkr trajectory --output trajectories.jsonl        # write to file
 *   lynkr trajectory --tier COMPLEX                      # only complex sessions
 *   lynkr trajectory --anonymize                         # strip PII / paths / secrets
 *   lynkr trajectory --count                             # just print the row count
 */

const path = require("path");

process.env.WORKSPACE_ROOT = process.env.WORKSPACE_ROOT || path.resolve(__dirname, "..");

const compressor = require("../src/training/trajectory-compressor");

function parseArgs(argv) {
  const opts = { since: "30d", anonymize: false, output: "-", count: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    if (a === "--since" && next) {
      opts.since = next;
      i++;
    } else if (a === "--days" && next) {
      opts.since = `${parseInt(next, 10)}d`;
      i++;
    } else if (a === "--tier" && next) {
      opts.tier = next.toUpperCase();
      i++;
    } else if (a === "--output" && next) {
      opts.output = next;
      i++;
    } else if (a === "-o" && next) {
      opts.output = next;
      i++;
    } else if (a === "--anonymize" || a === "--anonymise") {
      opts.anonymize = true;
    } else if (a === "--count") {
      opts.count = true;
    } else if (a === "--help" || a === "-h") {
      printHelp();
      process.exit(0);
    } else if (a === "--format" && next) {
      // Reserved for future formats. Only "jsonl" is supported today.
      if (next !== "jsonl") {
        console.error(`Unsupported --format: ${next}. Only 'jsonl' is supported.`);
        process.exit(2);
      }
      i++;
    }
  }
  return opts;
}

function printHelp() {
  console.log(`Lynkr trajectory exporter — emit JSONL training samples from session history.

Usage:
  lynkr trajectory [options]

Options:
  --since <window>     "7d", "30d", ISO date, or epoch ms (default: 30d)
  --days N             Shorthand for --since Nd
  --tier <tier>        Filter to one tier: SIMPLE, MEDIUM, COMPLEX, REASONING
  --output, -o <path>  Output file (default: stdout, "-")
  --anonymize          Strip PII, file paths, API keys, hostnames
  --count              Print only the row count, no output
  --format jsonl       Output format (only jsonl supported)
  -h, --help           Show this help

Examples:
  lynkr trajectory --days 7 --output last-week.jsonl
  lynkr trajectory --tier COMPLEX --anonymize -o complex-anon.jsonl
  lynkr trajectory --count

Output format (one JSON object per line):
  {
    "session_id": "...",
    "messages": [{"role": "user", "content": "..."}, ...],
    "tool_calls": [...],
    "outcome": "success" | "error",
    "tier": "MEDIUM",
    "complexity_score": 38,
    "model_used": "gpt-4o",
    "provider_used": "azure-openai",
    "tokens_in": 1234,
    "tokens_out": 456,
    "latency_ms": 2400,
    "started_at": "...",
    "ended_at": "..."
  }
`);
}

function fmtInt(n) {
  return new Intl.NumberFormat("en-US").format(n || 0);
}

function main() {
  const opts = parseArgs(process.argv);

  if (opts.count) {
    // Quick path — stream-walk the sessions and just count valid trajectories.
    let count = 0;
    compressor.exportJsonl({
      ...opts,
      output: { write: () => count++, end: () => {} },
    });
    console.log(`${fmtInt(count)} trajectories`);
    return;
  }

  const isStdout = opts.output === "-";
  const start = Date.now();
  const result = compressor.exportJsonl({
    since: opts.since,
    tier: opts.tier,
    anonymize: opts.anonymize,
    output: opts.output,
  });

  if (!isStdout) {
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    process.stderr.write(
      `Exported ${fmtInt(result.count)} trajectories to ${result.output} in ${elapsed}s\n`
    );
  }
}

main();
