#!/usr/bin/env node
/**
 * Compare active vs shadow routing policies (Phase 4.4).
 *
 * Reads data/shadow-decisions.jsonl and reports agreement rate and the
 * disagreement breakdown by (active model → shadow model).
 *
 * Run weekly: node scripts/compare-policies.js [--days 7]
 */

const fs = require('fs');
const path = require('path');
const { LOG_PATH } = require('../src/routing/shadow-mode');

function _parseArgs(argv) {
  let days = 7;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--days') days = Number(argv[++i]) || 7;
  }
  return { days };
}

function main() {
  const { days } = _parseArgs(process.argv.slice(2));
  if (!fs.existsSync(LOG_PATH)) {
    console.log('No shadow decisions logged yet.');
    return;
  }
  const since = Date.now() - days * 24 * 3600 * 1000;
  const lines = fs.readFileSync(LOG_PATH, 'utf8').split('\n').filter(Boolean);

  let total = 0;
  let agree = 0;
  const disagreement = new Map(); // "active → shadow" -> count
  for (const line of lines) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.timestamp < since) continue;
    total++;
    if (entry.agree) {
      agree++;
    } else if (entry.shadow) {
      const key = `${entry.active.provider}:${entry.active.model} → ${entry.shadow.provider}:${entry.shadow.model}`;
      disagreement.set(key, (disagreement.get(key) || 0) + 1);
    }
  }

  if (total === 0) {
    console.log(`No decisions in last ${days} days.`);
    return;
  }

  console.log(`Last ${days}d: ${total} decisions, ${(agree / total * 100).toFixed(1)}% agreement`);
  if (disagreement.size > 0) {
    console.log('\nTop disagreements:');
    const sorted = Array.from(disagreement.entries()).sort((a, b) => b[1] - a[1]).slice(0, 10);
    for (const [k, c] of sorted) {
      console.log(`  ${c}× ${k}`);
    }
  }
}

main();
