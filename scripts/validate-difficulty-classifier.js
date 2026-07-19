#!/usr/bin/env node
/**
 * Validate the LLM difficulty classifier against the eval set.
 *
 * Runs data/difficulty-eval.jsonl through src/routing/difficulty-classifier.js
 * (the SIMPLE tier model — currently minimax-m2.5:cloud via ollama).
 * Reports overall + per-tier accuracy, confusion matrix, and lists the
 * misclassifications so we can eyeball whether classifier or label is wrong.
 *
 * Bar to ship: ≥85% overall, zero MEDIUM→REASONING false positives.
 *
 * Usage: node scripts/validate-difficulty-classifier.js
 */

const fs = require("fs");
const path = require("path");
const { classifyDifficulty, _clearCacheForTests } = require("../src/routing/difficulty-classifier");

const EVAL_FILE = path.join(__dirname, "../data/difficulty-eval.jsonl");
const RESULTS_FILE = path.join(__dirname, "../data/difficulty-eval-results.jsonl");
const TIERS = ["SIMPLE", "MEDIUM", "COMPLEX", "REASONING"];

async function main() {
  _clearCacheForTests();
  const lines = fs.readFileSync(EVAL_FILE, "utf8").split("\n").filter(Boolean);
  const rows = lines.map(l => JSON.parse(l));
  console.log(`Loaded ${rows.length} eval rows`);

  // Persist incrementally so a crash mid-run preserves partial data.
  const resultsFd = fs.openSync(RESULTS_FILE, "w");
  const results = [];
  const t0 = Date.now();
  let done = 0;
  for (const row of rows) {
    const r = await classifyDifficulty(row.text);
    const record = {
      ...row,
      predicted: r?.tier ?? null,
      confidence: r?.confidence ?? null,
    };
    results.push(record);
    fs.writeSync(resultsFd, JSON.stringify(record) + "\n");
    done++;
    if (done % 25 === 0) {
      const elapsed = (Date.now() - t0) / 1000;
      process.stdout.write(`  ${done}/${rows.length} (${elapsed.toFixed(0)}s, avg ${(elapsed / done * 1000).toFixed(0)}ms/prompt)\n`);
    }
  }
  fs.closeSync(resultsFd);
  console.log(`\nDone in ${((Date.now() - t0) / 1000).toFixed(0)}s (results saved to ${RESULTS_FILE})`);

  // Overall + per-tier accuracy
  const perTier = {};
  const confusion = {};
  for (const t of TIERS) {
    perTier[t] = { total: 0, correct: 0 };
    confusion[t] = { SIMPLE: 0, MEDIUM: 0, COMPLEX: 0, REASONING: 0, null: 0 };
  }
  let overall = 0;
  let classified = 0;
  let skipped = 0;
  for (const r of results) {
    if (r.predicted === null) { skipped++; continue; }
    classified++;
    perTier[r.tier].total++;
    confusion[r.tier][r.predicted] = (confusion[r.tier][r.predicted] || 0) + 1;
    if (r.predicted === r.tier) { overall++; perTier[r.tier].correct++; }
  }

  console.log(`\n=== Accuracy ===`);
  console.log(`Overall: ${overall}/${classified} (${(overall / classified * 100).toFixed(1)}%)`);
  console.log(`Skipped (short text / classifier disabled): ${skipped}`);
  console.log(`\nPer-tier:`);
  for (const t of TIERS) {
    const p = perTier[t];
    if (p.total === 0) continue;
    console.log(`  ${t}: ${p.correct}/${p.total} (${(p.correct / p.total * 100).toFixed(1)}%)`);
  }

  // Per-source accuracy: hand labels are trusted; benchmark labels have known
  // difficulty-vs-tier bias (RouterArena's "easy" band ≠ MEDIUM tier; gpt4's
  // mixtral_score ≠ tier). Report separately for an honest signal.
  console.log(`\n=== Per-source ===`);
  const sources = {};
  for (const r of results) {
    if (r.predicted === null) continue;
    const s = r.source || 'unknown';
    if (!sources[s]) sources[s] = { total: 0, correct: 0 };
    sources[s].total++;
    if (r.predicted === r.tier) sources[s].correct++;
  }
  for (const [s, v] of Object.entries(sources)) {
    console.log(`  ${s}: ${v.correct}/${v.total} (${(v.correct / v.total * 100).toFixed(1)}%)`);
  }

  console.log(`\n=== Confusion matrix (rows = true, cols = predicted) ===`);
  console.log(`         ${TIERS.map(t => t.padStart(9)).join("")}`);
  for (const t of TIERS) {
    const row = TIERS.map(pred => String(confusion[t][pred] || 0).padStart(9)).join("");
    console.log(`${t.padStart(9)}${row}`);
  }

  // Critical failure mode: MEDIUM→REASONING (over-routing to expensive tier)
  const overRouted = confusion.MEDIUM?.REASONING || 0;
  const simpleToReasoning = confusion.SIMPLE?.REASONING || 0;
  console.log(`\n=== Critical false positives ===`);
  console.log(`MEDIUM→REASONING: ${overRouted} (must be 0 to ship)`);
  console.log(`SIMPLE→REASONING: ${simpleToReasoning}`);
  console.log(`MEDIUM→COMPLEX: ${confusion.MEDIUM?.COMPLEX || 0}`);

  // List misclassifications (cap at 20 per tier)
  console.log(`\n=== Misclassifications (up to 5 per tier) ===`);
  for (const t of TIERS) {
    const errors = results.filter(r => r.tier === t && r.predicted && r.predicted !== t).slice(0, 5);
    if (errors.length === 0) continue;
    console.log(`\n${t}:`);
    for (const e of errors) {
      console.log(`  → ${e.predicted} (conf ${e.confidence?.toFixed(2)}): ${e.text.slice(0, 90)}`);
    }
  }
}

main().catch(err => { console.error(err); process.exit(1); });
