#!/usr/bin/env node

/**
 * Compact LLM Audit Dictionary
 *
 * Removes redundant UPDATE entries from the dictionary file, keeping only:
 * - One entry per hash with full content
 * - Latest metadata (useCount, lastSeen)
 *
 * Usage:
 *   node scripts/compact-dictionary.js [options]
 *
 * Options:
 *   --dict-path <path>    Path to dictionary file (default: logs/llm-audit-dictionary.jsonl)
 *   --backup              Create backup before compacting (default: true)
 *   --dry-run             Show what would be done without making changes
 *   --help                Show this help message
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');

// Parse command line arguments
function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    dictPath: 'logs/llm-audit-dictionary.jsonl',
    backup: true,
    dryRun: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case '--dict-path':
        options.dictPath = args[++i];
        break;
      case '--backup':
        options.backup = true;
        break;
      case '--no-backup':
        options.backup = false;
        break;
      case '--dry-run':
        options.dryRun = true;
        break;
      case '--help':
        console.log(`
Compact LLM Audit Dictionary

Removes redundant UPDATE entries from the dictionary file.

Usage:
  node scripts/compact-dictionary.js [options]

Options:
  --dict-path <path>    Path to dictionary file (default: logs/llm-audit-dictionary.jsonl)
  --backup              Create backup before compacting (default: true)
  --no-backup           Skip creating backup
  --dry-run             Show what would be done without making changes
  --help                Show this help message

Example:
  node scripts/compact-dictionary.js --dict-path logs/llm-audit-dictionary.jsonl --dry-run
        `);
        process.exit(0);
      default:
        if (arg.startsWith('--')) {
          console.error(`Unknown option: ${arg}`);
          process.exit(1);
        }
    }
  }

  return options;
}

// Read and compact dictionary
async function compactDictionary(dictPath) {
  if (!fs.existsSync(dictPath)) {
    throw new Error(`Dictionary file not found: ${dictPath}`);
  }

  console.log(`Reading dictionary: ${dictPath}`);

  // Map: hash -> entry object
  // For each hash, we'll keep the latest metadata merged with content
  const entries = new Map();
  let totalLines = 0;
  let malformedLines = 0;

  // Read all entries
  const fileStream = fs.createReadStream(dictPath);
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    totalLines++;
    if (!line.trim()) continue;

    try {
      const entry = JSON.parse(line);
      if (!entry.hash) {
        malformedLines++;
        continue;
      }

      const hash = entry.hash;

      // Check if we already have an entry for this hash
      if (entries.has(hash)) {
        const existing = entries.get(hash);

        // Merge: keep content from entry that has it, use latest metadata
        const merged = {
          hash,
          firstSeen: existing.firstSeen || entry.firstSeen,
          useCount: entry.useCount || existing.useCount,
          lastSeen: entry.lastSeen || existing.lastSeen,
          content: existing.content || entry.content,
        };

        entries.set(hash, merged);
      } else {
        // First time seeing this hash
        entries.set(hash, entry);
      }
    } catch (err) {
      malformedLines++;
      console.warn(`Skipping malformed line ${totalLines}: ${err.message}`);
    }
  }

  const compactedCount = entries.size;
  const removedCount = totalLines - malformedLines - compactedCount;

  return {
    entries,
    stats: {
      totalLines,
      malformedLines,
      uniqueHashes: compactedCount,
      removedEntries: removedCount,
    },
  };
}

// Write compacted dictionary
async function writeCompactedDictionary(dictPath, entries, backup = true) {
  // Create backup if requested
  if (backup) {
    const backupPath = `${dictPath}.backup.${Date.now()}`;
    console.log(`Creating backup: ${backupPath}`);
    fs.copyFileSync(dictPath, backupPath);
  }

  // Write compacted entries
  console.log(`Writing compacted dictionary: ${dictPath}`);
  const lines = Array.from(entries.values()).map((entry) => JSON.stringify(entry));
  fs.writeFileSync(dictPath, lines.join('\n') + '\n');
}

// Main
async function main() {
  try {
    const options = parseArgs();
    const dictPath = path.resolve(options.dictPath);

    console.log('=== LLM Audit Dictionary Compaction ===\n');

    // Read and compact
    const { entries, stats } = await compactDictionary(dictPath);

    // Report statistics
    console.log('\nCompaction Statistics:');
    console.log(`  Total lines in dictionary: ${stats.totalLines}`);
    console.log(`  Malformed lines skipped: ${stats.malformedLines}`);
    console.log(`  Unique content hashes: ${stats.uniqueHashes}`);
    console.log(`  Redundant entries removed: ${stats.removedEntries}`);

    const reductionPercent =
      stats.totalLines > 0
        ? ((stats.removedEntries / stats.totalLines) * 100).toFixed(1)
        : 0;
    console.log(`  Size reduction: ${reductionPercent}%\n`);

    if (options.dryRun) {
      console.log('DRY RUN: No changes made to dictionary file.');
      console.log(`Would have written ${stats.uniqueHashes} entries.\n`);
    } else {
      // Write compacted dictionary
      await writeCompactedDictionary(dictPath, entries, options.backup);
      console.log('✓ Dictionary compaction complete!\n');
    }
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
}

main();
