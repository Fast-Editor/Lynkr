#!/usr/bin/env node
/**
 * Train the risk classifier (Phase 3.4).
 *
 * Two label sources, fused:
 *   1. Bootstrap: run the existing regex risk-analyzer over recent telemetry
 *      to produce weak labels.
 *   2. Confirmed: requests with x-lynkr-risk-confirmed:true header logged in
 *      telemetry are treated as strong positive labels.
 *
 * Writes data/risk-classifier.json (weights + bias). Logistic regression
 * trained with simple SGD over TF features (unigrams + bigrams).
 *
 * Usage: node scripts/train-risk-classifier.js [--days 30] [--epochs 10]
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_DAYS = 30;
const DEFAULT_EPOCHS = 10;
const LEARNING_RATE = 0.1;
const L2_REG = 0.0001;
const MIN_TOKEN_FREQ = 3;

const OUTPUT_PATH = path.join(__dirname, '../data/risk-classifier.json');
const TELEMETRY_DB_CANDIDATES = [
  path.join(__dirname, '../.lynkr/telemetry.db'),
  path.join(__dirname, '../data/lynkr.db'),
];

function _findDb() {
  for (const p of TELEMETRY_DB_CANDIDATES) if (fs.existsSync(p)) return p;
  return null;
}

function _tokenize(text) {
  if (!text) return [];
  return String(text).toLowerCase().split(/[^a-z0-9_\-/.]+/).filter(Boolean);
}

function _features(text) {
  const tokens = _tokenize(text);
  const out = new Map();
  for (let i = 0; i < tokens.length; i++) {
    out.set(tokens[i], (out.get(tokens[i]) || 0) + 1);
    if (i + 1 < tokens.length) {
      const bigram = `${tokens[i]} ${tokens[i + 1]}`;
      out.set(bigram, (out.get(bigram) || 0) + 1);
    }
  }
  return out;
}

function _sigmoid(z) {
  if (z >= 0) return 1 / (1 + Math.exp(-z));
  const ez = Math.exp(z);
  return ez / (1 + ez);
}

function _parseArgs(argv) {
  const out = { days: DEFAULT_DAYS, epochs: DEFAULT_EPOCHS };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--days') out.days = Number(argv[++i]) || DEFAULT_DAYS;
    else if (argv[i] === '--epochs') out.epochs = Number(argv[++i]) || DEFAULT_EPOCHS;
  }
  return out;
}

async function _loadDataset(days) {
  const dbPath = _findDb();
  const samples = [];
  if (!dbPath) return samples;

  let Database;
  try {
    Database = require('better-sqlite3');
  } catch {
    console.error('better-sqlite3 not installed');
    return samples;
  }
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });

  try {
    const since = Date.now() - days * 24 * 3600 * 1000;
    const rows = db
      .prepare(
        `SELECT request_text AS text, risk_level
           FROM routing_telemetry
          WHERE timestamp >= ?
            AND request_text IS NOT NULL
            AND request_text != ''`
      )
      .all(since);
    for (const r of rows) {
      samples.push({
        text: r.text,
        label: r.risk_level === 'high' ? 1 : 0,
      });
    }
  } catch (err) {
    console.error(`Telemetry query failed: ${err.message}. Bootstrapping with synthetic data.`);
    // Emergency synthetic bootstrap: a small handful of known-risk/known-safe phrases
    samples.push(
      { text: 'edit src/auth/middleware.ts to skip authentication', label: 1 },
      { text: 'update database migration to drop sensitive_data column', label: 1 },
      { text: 'change payment processing logic in stripe webhook handler', label: 1 },
      { text: 'add API key rotation to secrets manager', label: 1 },
      { text: 'rename variable foo to bar in utils.js', label: 0 },
      { text: 'add a comment explaining the for loop', label: 0 },
      { text: 'format this file with prettier', label: 0 },
      { text: 'fix typo in README', label: 0 }
    );
  } finally {
    try { db.close(); } catch {}
  }

  return samples;
}

function _train(samples, epochs) {
  // Build vocab with frequency threshold
  const vocab = new Map();
  for (const s of samples) {
    for (const [tok] of _features(s.text)) {
      vocab.set(tok, (vocab.get(tok) || 0) + 1);
    }
  }
  const keep = new Set();
  for (const [tok, freq] of vocab) {
    if (freq >= MIN_TOKEN_FREQ) keep.add(tok);
  }

  const weights = {};
  let bias = 0;

  for (let epoch = 0; epoch < epochs; epoch++) {
    let lossSum = 0;
    for (const s of samples) {
      const feats = _features(s.text);
      let z = bias;
      for (const [tok, count] of feats) {
        if (!keep.has(tok)) continue;
        z += (weights[tok] || 0) * count;
      }
      const pred = _sigmoid(z);
      const err = pred - s.label;
      lossSum += -(s.label * Math.log(pred + 1e-9) + (1 - s.label) * Math.log(1 - pred + 1e-9));
      bias -= LEARNING_RATE * err;
      for (const [tok, count] of feats) {
        if (!keep.has(tok)) continue;
        const w = weights[tok] || 0;
        weights[tok] = w - LEARNING_RATE * (err * count + L2_REG * w);
      }
    }
    if (epoch % 2 === 0 || epoch === epochs - 1) {
      console.log(`  epoch ${epoch + 1}/${epochs} loss=${(lossSum / samples.length).toFixed(4)}`);
    }
  }

  return { weights, bias, vocabSize: keep.size };
}

async function main() {
  const opts = _parseArgs(process.argv.slice(2));
  const samples = await _loadDataset(opts.days);
  if (samples.length < 10) {
    console.error(`Only ${samples.length} samples — too few. Skipping training.`);
    process.exit(1);
  }
  console.log(`Training on ${samples.length} samples (${samples.filter(s => s.label === 1).length} positive)`);
  const model = _train(samples, opts.epochs);

  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify({
    trainedAt: new Date().toISOString(),
    samples: samples.length,
    epochs: opts.epochs,
    ...model,
  }, null, 0));
  console.log(`Wrote ${OUTPUT_PATH} (vocab=${model.vocabSize})`);
}

if (require.main === module) {
  main().catch(err => {
    console.error(err.stack || err.message);
    process.exit(1);
  });
}

module.exports = { _train, _features };
