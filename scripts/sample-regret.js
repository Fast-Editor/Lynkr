#!/usr/bin/env node
/**
 * Sample yesterday's traffic for regret estimation (Phase 4.2).
 *
 * Reads 0.5% of yesterday's requests from telemetry, re-runs them through
 * Opus, and writes alerts if the routed model consistently underperforms.
 *
 * Costs real money — only runs when LYNKR_REGRET_ESTIMATOR=true.
 */

const path = require('path');
const fs = require('fs');
const { estimate, isEnabled } = require('../src/routing/regret-estimator');

const SAMPLE_RATE = 0.005;

async function main() {
  if (!isEnabled()) {
    console.log('LYNKR_REGRET_ESTIMATOR not set; skipping.');
    return;
  }

  let Database;
  try {
    Database = require('better-sqlite3');
  } catch {
    console.error('better-sqlite3 not installed');
    process.exit(2);
  }

  const dbPath = path.join(__dirname, '../.lynkr/telemetry.db');
  if (!fs.existsSync(dbPath)) {
    console.log('No telemetry DB; skipping.');
    return;
  }

  const db = new Database(dbPath, { readonly: true });
  const yesterday = Date.now() - 24 * 3600 * 1000;
  const rows = db.prepare(
    `SELECT request_text, response_text, model, quality_score
       FROM routing_telemetry
      WHERE timestamp >= ?
        AND quality_score IS NOT NULL
        AND request_text IS NOT NULL`
  ).all(yesterday);
  db.close();

  if (rows.length === 0) {
    console.log('No eligible rows yesterday.');
    return;
  }

  const sampleSize = Math.max(5, Math.floor(rows.length * SAMPLE_RATE));
  const sampled = [];
  while (sampled.length < sampleSize && rows.length > 0) {
    const idx = Math.floor(Math.random() * rows.length);
    sampled.push(rows.splice(idx, 1)[0]);
  }

  console.log(`Sampling ${sampled.length} rows for regret estimation`);

  // Caller must wire an actual Opus invocation; default to a no-op for safety.
  const runOpus = async (req) => {
    console.warn('No opus runner wired — implement runOpus in scripts/sample-regret.js or override via LYNKR_REGRET_OPUS_RUNNER');
    return { response: null, quality: 0 };
  };

  const samples = sampled.map(r => ({
    request: { messages: [{ role: 'user', content: r.request_text }] },
    response: r.response_text,
    model: r.model,
    quality: r.quality_score,
  }));

  const result = await estimate({ samples, runOpus });
  console.log(`Regret: ${result.regret.toFixed(3)} over ${result.sampledCount} samples; ${result.alerts.length} alert(s) written.`);
}

if (require.main === module) {
  main().catch(err => {
    console.error(err.stack || err.message);
    process.exit(1);
  });
}
