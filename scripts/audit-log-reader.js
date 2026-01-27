#!/usr/bin/env node

/**
 * LLM Audit Log Reader
 *
 * Utility to read and reconstruct audit log entries from deduplicated logs.
 * Resolves hash references from the dictionary file and outputs full content.
 *
 * Usage:
 *   node scripts/audit-log-reader.js [options]
 *
 * Options:
 *   --log-file <path>        Path to audit log file (default: logs/llm-audit.log)
 *   --dict-file <path>       Path to dictionary file (default: logs/llm-audit-dictionary.jsonl)
 *   --full                   Output full restored entries (resolve all references)
 *   --filter <type=value>    Filter by field (e.g., type=llm_request, provider=anthropic)
 *   --correlation-id <id>    Filter by correlation ID
 *   --last <n>               Show only last N entries
 *   --stats                  Show deduplication statistics
 *   --verify                 Verify all references can be resolved
 *   --help                   Show this help message
 *
 * Examples:
 *   # Show all entries with full content
 *   node scripts/audit-log-reader.js --full
 *
 *   # Show only requests
 *   node scripts/audit-log-reader.js --filter type=llm_request
 *
 *   # Show last 5 entries
 *   node scripts/audit-log-reader.js --last 5 --full
 *
 *   # Show deduplication statistics
 *   node scripts/audit-log-reader.js --stats
 *
 *   # Verify all references resolve
 *   node scripts/audit-log-reader.js --verify
 */

const fs = require("fs");
const path = require("path");
const readline = require("readline");
const { ContentDeduplicator } = require("../src/logger/deduplicator");

// Default file paths
const DEFAULT_LOG_FILE = path.join(process.cwd(), "logs", "llm-audit.log");
const DEFAULT_DICT_FILE = path.join(process.cwd(), "logs", "llm-audit-dictionary.jsonl");

/**
 * Parse command line arguments
 */
function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    logFile: DEFAULT_LOG_FILE,
    dictFile: DEFAULT_DICT_FILE,
    full: false,
    filter: null,
    correlationId: null,
    last: null,
    stats: false,
    verify: false,
    help: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case "--log-file":
        options.logFile = args[++i];
        break;
      case "--dict-file":
        options.dictFile = args[++i];
        break;
      case "--full":
        options.full = true;
        break;
      case "--filter":
        const filterArg = args[++i];
        const [key, value] = filterArg.split("=");
        options.filter = { key, value };
        break;
      case "--correlation-id":
        options.correlationId = args[++i];
        break;
      case "--last":
        options.last = Number.parseInt(args[++i], 10);
        break;
      case "--stats":
        options.stats = true;
        break;
      case "--verify":
        options.verify = true;
        break;
      case "--help":
        options.help = true;
        break;
      default:
        console.error(`Unknown option: ${arg}`);
        process.exit(1);
    }
  }

  return options;
}

/**
 * Show help message
 */
function showHelp() {
  const helpText = `
LLM Audit Log Reader

Usage: node scripts/audit-log-reader.js [options]

Options:
  --log-file <path>        Path to audit log file (default: logs/llm-audit.log)
  --dict-file <path>       Path to dictionary file (default: logs/llm-audit-dictionary.jsonl)
  --full                   Output full restored entries (resolve all references)
  --filter <type=value>    Filter by field (e.g., type=llm_request, provider=anthropic)
  --correlation-id <id>    Filter by correlation ID
  --last <n>               Show only last N entries
  --stats                  Show deduplication statistics
  --verify                 Verify all references can be resolved
  --help                   Show this help message

Examples:
  # Show all entries with full content
  node scripts/audit-log-reader.js --full

  # Show only requests
  node scripts/audit-log-reader.js --filter type=llm_request

  # Show last 5 entries
  node scripts/audit-log-reader.js --last 5 --full

  # Show deduplication statistics
  node scripts/audit-log-reader.js --stats

  # Verify all references resolve
  node scripts/audit-log-reader.js --verify
`;
  console.log(helpText);
}

/**
 * Read and process log entries
 */
async function readLogEntries(options) {
  const { logFile, dictFile, full, filter, correlationId, last } = options;

  // Check if log file exists
  if (!fs.existsSync(logFile)) {
    console.error(`Log file not found: ${logFile}`);
    process.exit(1);
  }

  // Initialize deduplicator if needed
  let deduplicator = null;
  if (full && fs.existsSync(dictFile)) {
    deduplicator = new ContentDeduplicator(dictFile);
  }

  const entries = [];

  // Read log file line by line
  const fileStream = fs.createReadStream(logFile);
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (!line.trim()) continue;

    try {
      let entry = JSON.parse(line);

      // Apply filters
      if (filter && entry[filter.key] !== filter.value) {
        continue;
      }
      if (correlationId && entry.correlationId !== correlationId) {
        continue;
      }

      // Restore full content if requested
      if (full && deduplicator) {
        entry = deduplicator.restoreEntry(entry);
      }

      entries.push(entry);
    } catch (err) {
      console.error("Malformed log entry:", err.message);
    }
  }

  // Apply last N filter
  const output = last ? entries.slice(-last) : entries;

  // Output as JSONL
  for (const entry of output) {
    console.log(JSON.stringify(entry, null, 2));
  }

  return entries.length;
}

/**
 * Show deduplication statistics
 */
async function showStats(options) {
  const { logFile, dictFile } = options;

  if (!fs.existsSync(logFile)) {
    console.error(`Log file not found: ${logFile}`);
    process.exit(1);
  }

  if (!fs.existsSync(dictFile)) {
    console.log("No dictionary file found. Deduplication may not be enabled.");
    return;
  }

  // Get file sizes
  const logStats = fs.statSync(logFile);
  const dictStats = fs.statSync(dictFile);

  console.log("\n=== LLM Audit Log Deduplication Statistics ===\n");
  console.log(`Log file: ${logFile}`);
  console.log(`  Size: ${formatBytes(logStats.size)}`);
  console.log(`  Lines: ${await countLines(logFile)}`);
  console.log();
  console.log(`Dictionary file: ${dictFile}`);
  console.log(`  Size: ${formatBytes(dictStats.size)}`);
  console.log(`  Entries: ${await countLines(dictFile)}`);
  console.log();
  console.log(`Total size: ${formatBytes(logStats.size + dictStats.size)}`);
  console.log();

  // Count reference occurrences in log
  const refCount = await countReferences(logFile);
  console.log(`Reference objects in log: ${refCount}`);
  console.log(`Estimated space saved: ~${formatBytes(refCount * 2000)} (assuming ~2KB per deduplicated field)`);
  console.log();
}

/**
 * Verify all references can be resolved
 */
async function verifyReferences(options) {
  const { logFile, dictFile } = options;

  if (!fs.existsSync(logFile)) {
    console.error(`Log file not found: ${logFile}`);
    process.exit(1);
  }

  if (!fs.existsSync(dictFile)) {
    console.log("No dictionary file found. Nothing to verify.");
    return;
  }

  const deduplicator = new ContentDeduplicator(dictFile);
  const fileStream = fs.createReadStream(logFile);
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity,
  });

  let totalRefs = 0;
  let unresolvedRefs = 0;
  const unresolvedHashes = new Set();

  console.log("Verifying references...\n");

  for await (const line of rl) {
    if (!line.trim()) continue;

    try {
      const entry = JSON.parse(line);

      // Check all fields for references
      for (const [key, value] of Object.entries(entry)) {
        if (typeof value === "object" && value !== null && value.$ref) {
          totalRefs++;
          const content = deduplicator.getContent(value.$ref);
          if (content === null) {
            unresolvedRefs++;
            unresolvedHashes.add(value.$ref);
            console.error(`✗ Unresolved reference: ${value.$ref} in field "${key}"`);
          }
        }
      }
    } catch (err) {
      console.error("Malformed log entry:", err.message);
    }
  }

  console.log("\n=== Verification Results ===\n");
  console.log(`Total references: ${totalRefs}`);
  console.log(`Unresolved references: ${unresolvedRefs}`);
  console.log(`Unique unresolved hashes: ${unresolvedHashes.size}`);

  if (unresolvedRefs === 0) {
    console.log("\n✓ All references resolved successfully!");
  } else {
    console.log("\n✗ Some references could not be resolved. Dictionary may be incomplete.");
    process.exit(1);
  }
}

/**
 * Helper: Format bytes to human-readable string
 */
function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/**
 * Helper: Count lines in a file
 */
async function countLines(filePath) {
  const fileStream = fs.createReadStream(filePath);
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity,
  });

  let count = 0;
  for await (const line of rl) {
    if (line.trim()) count++;
  }
  return count;
}

/**
 * Helper: Count reference objects in log
 */
async function countReferences(filePath) {
  const fileStream = fs.createReadStream(filePath);
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity,
  });

  let count = 0;
  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      for (const value of Object.values(entry)) {
        if (typeof value === "object" && value !== null && value.$ref) {
          count++;
        }
      }
    } catch {
      // Skip malformed lines
    }
  }
  return count;
}

/**
 * Main entry point
 */
async function main() {
  const options = parseArgs();

  if (options.help) {
    showHelp();
    return;
  }

  if (options.stats) {
    await showStats(options);
  } else if (options.verify) {
    await verifyReferences(options);
  } else {
    const count = await readLogEntries(options);
    console.error(`\n(Processed ${count} entries)`);
  }
}

// Run if called directly
if (require.main === module) {
  main().catch((err) => {
    console.error("Error:", err.message);
    process.exit(1);
  });
}

module.exports = {
  readLogEntries,
  showStats,
  verifyReferences,
};
