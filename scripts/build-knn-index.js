#!/usr/bin/env node
/**
 * Build the kNN router index from telemetry (and optional RouterBench bootstrap).
 *
 * Phase 3.1 of the routing overhaul. Should be run nightly:
 *   node scripts/build-knn-index.js [--days 30] [--bootstrap path/to/routerbench.jsonl]
 *
 * RouterBench bootstrap format (one JSON per line):
 *   { "query": "...", "provider": "anthropic", "model": "claude-...",
 *     "quality": 87, "cost": 0.0034, "latency": 1200, "tier": "COMPLEX" }
 */

const fs = require('fs');
const path = require('path');
const { generateEmbedding } = require('../src/cache/embeddings');
const { getKnnRouter } = require('../src/routing/knn-router');

const DEFAULT_DAYS = 30;
const TELEMETRY_DB_CANDIDATES = [
  path.join(__dirname, '../.lynkr/telemetry.db'),
  path.join(__dirname, '../data/lynkr.db'),
];

function _findDb() {
  for (const p of TELEMETRY_DB_CANDIDATES) if (fs.existsSync(p)) return p;
  return null;
}

function _parseArgs(argv) {
  const out = { days: DEFAULT_DAYS, bootstrap: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--days') out.days = Number(argv[++i]) || DEFAULT_DAYS;
    else if (argv[i] === '--bootstrap') out.bootstrap = argv[++i];
  }
  return out;
}

async function _readTelemetry(days) {
  const dbPath = _findDb();
  if (!dbPath) return [];
  let Database;
  try {
    Database = require('better-sqlite3');
  } catch {
    console.error('better-sqlite3 not installed');
    return [];
  }
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const since = Date.now() - days * 24 * 3600 * 1000;
    return db
      .prepare(
        `SELECT request_text AS query, provider, model, quality_score AS quality,
                cost, total_latency_ms AS latency, tier
           FROM routing_telemetry
          WHERE timestamp >= ?
            AND quality_score IS NOT NULL
            AND request_text IS NOT NULL
            AND request_text != ''`
      )
      .all(since);
  } catch (err) {
    console.error(`Telemetry query failed: ${err.message}`);
    return [];
  } finally {
    try { db.close(); } catch {}
  }
}

async function _readBootstrap(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return [];
  const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean);
  const out = [];
  for (const line of lines) {
    try {
      out.push(JSON.parse(line));
    } catch {
      // skip malformed
    }
  }
  return out;
}

async function build({ days = DEFAULT_DAYS, bootstrap = null } = {}) {
  const router = getKnnRouter();
  if (!router.ready) {
    console.error('Router index not ready (hnswlib-node may be missing). Aborting.');
    process.exit(2);
  }

  const teleRows = await _readTelemetry(days);
  const bootRows = await _readBootstrap(bootstrap);
  const all = [...bootRows, ...teleRows];
  console.log(`Building index from ${bootRows.length} bootstrap + ${teleRows.length} telemetry rows`);

  let added = 0;
  let failed = 0;
  for (const row of all) {
    const text = row.query || row.request_text;
    if (!text) continue;
    try {
      const emb = await generateEmbedding(text);
      router.add(emb, {
        provider: row.provider,
        model: row.model,
        quality: row.quality,
        cost: row.cost,
        latency: row.latency,
        tier: row.tier,
      });
      added++;
      if (added % 100 === 0) console.log(`  ${added} indexed...`);
    } catch (err) {
      failed++;
    }
  }

  router.save();
  console.log(`Indexed ${added}, failed ${failed}. Index size: ${router.size}`);
}

if (require.main === module) {
  const opts = _parseArgs(process.argv.slice(2));
  build(opts).catch((err) => {
    console.error(err.stack || err.message);
    process.exit(1);
  });
}

module.exports = { build };
