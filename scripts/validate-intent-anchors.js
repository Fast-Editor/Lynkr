#!/usr/bin/env node
/**
 * Validate new anchors against old (config/ vs data/) on a held-out eval set.
 *
 * Mines ~40 real prompts from logs + hand-picked coding-agent asks, assigns
 * target tiers, scores with both anchor sets, reports accuracy and tier-shift
 * delta. Use to tune FRONTIER_MIN_SIM and confirm the mined anchors beat the
 * 13-anchor baseline without false-positive REASONING routing.
 *
 * Usage: node scripts/validate-intent-anchors.js [--baseline|--new]
 *   --baseline: score eval set with config/difficulty-anchors.json only
 *   --new:      score eval set with data/difficulty-anchors.json only
 *   (no flag):  compare both and report delta
 */

const fs = require("fs");
const path = require("path");

const CONFIG_ANCHORS = path.join(__dirname, "../config/difficulty-anchors.json");
const DATA_ANCHORS = path.join(__dirname, "../data/difficulty-anchors.json");

// Tier bands (from model-tiers.js defaults — verify if calibrated)
const TIER_BANDS = {
  SIMPLE: [0, 19],
  MEDIUM: [20, 50],
  COMPLEX: [51, 75],
  REASONING: [76, 100],
};

function tierFromScore(score) {
  for (const [tier, [lo, hi]] of Object.entries(TIER_BANDS)) {
    if (score >= lo && score <= hi) return tier;
  }
  return "UNKNOWN";
}

// Eval set: real prompts from logs + coding-agent asks, with ground-truth tier.
// Target tier is what config B SHOULD route (local/GLM/Claude) given intent.
const EVAL_SET = [
  // SIMPLE (local/ollama)
  { text: "hi", target: "SIMPLE" },
  { text: "ok thanks", target: "SIMPLE" },
  { text: "yes continue", target: "SIMPLE" },
  { text: "what time is it", target: "SIMPLE" },
  { text: "got it", target: "SIMPLE" },
  // MEDIUM (ollama)
  { text: "Run the unit tests and summarize failures", target: "MEDIUM" },
  { text: "What does this function do", target: "MEDIUM" },
  { text: "Show me the git diff", target: "MEDIUM" },
  { text: "List the exports from this file", target: "MEDIUM" },
  { text: "Fix the linter warnings", target: "MEDIUM" },
  { text: "Add error handling to this try block", target: "MEDIUM" },
  { text: "Write a test for the login function", target: "MEDIUM" },
  { text: "Explain this regex pattern", target: "MEDIUM" },
  { text: "Debug this null reference error", target: "MEDIUM" },
  { text: "Refactor this into smaller functions", target: "MEDIUM" },
  // COMPLEX (GLM)
  { text: "Do an architecture review of the orchestrator", target: "COMPLEX" },
  { text: "Review this retry helper for bugs", target: "COMPLEX" },
  { text: "Refactor the entire ingestion pipeline and give me the plan", target: "COMPLEX" },
  { text: "Design a horizontally scalable architecture for the router", target: "COMPLEX" },
  { text: "Code review the PR #84 routing hardening changes", target: "COMPLEX" },
  { text: "Analyze every module in src/ for circular dependencies", target: "COMPLEX" },
  { text: "Debug this complex race condition in the connection pool", target: "COMPLEX" },
  { text: "Plan a zero-downtime migration to the new schema", target: "COMPLEX" },
  { text: "Implement a distributed rate limiter with Redis", target: "COMPLEX" },
  { text: "Design the caching strategy for this API gateway", target: "COMPLEX" },
  // REASONING (Claude)
  { text: "Prove the correctness of this lock-free queue implementation", target: "REASONING" },
  { text: "Security audit the authentication middleware", target: "REASONING" },
  { text: "Derive the optimal cache eviction policy and prove its competitive ratio", target: "REASONING" },
  { text: "Formal verification of the state machine — prove it never deadlocks", target: "REASONING" },
  { text: "From first principles, design a Byzantine-fault-tolerant consensus protocol variant", target: "REASONING" },
  { text: "Think deeply about why this floating-point summation loses precision at scale", target: "REASONING" },
  { text: "Prove this rate limiter is fair under concurrent refill or construct the starvation schedule", target: "REASONING" },
  { text: "Reason through the exact memory ordering constraints this hashmap needs on ARM", target: "REASONING" },
  { text: "Given these heap dumps, reason to the retention path causing the leak", target: "REASONING" },
  { text: "Ultrathink: analyze whether this migration can run online without violating invariants", target: "REASONING" },
];

async function scoreWithAnchors(anchorsPath) {
  const { scoreIntent, buildCentroids, CLASS_VALUES } = require("../src/routing/intent-score");
  const { getKnnRouter } = require("../src/routing/knn-router");
  const router = getKnnRouter();
  const embedFn = (t) => router.embed(t);

  let anchors = JSON.parse(fs.readFileSync(anchorsPath, "utf8"));
  // Old 3-class anchors lack frontier — stub it with a heavyweight anchor so
  // buildCentroids gets 4 centroids (it requires centroid count === CLASS_VALUES
  // count). The stub's embedding pulls frontier sim down, keeping the 3-class
  // baseline behavior (frontier excluded from blend via FRONTIER_MIN_SIM floor).
  if (!anchors.frontier && CLASS_VALUES.frontier) {
    anchors = { ...anchors, frontier: [anchors.heavyweight[0]] };
  }
  const centroids = await buildCentroids(anchors, embedFn);
  if (!centroids) throw new Error(`Failed to build centroids from ${anchorsPath}`);

  const results = [];
  for (const item of EVAL_SET) {
    const payload = { messages: [{ role: "user", content: item.text }] };
    const r = await scoreIntent(payload, { embedFn, centroids });
    const predicted = tierFromScore(r.score);
    const correct = predicted === item.target;
    results.push({ ...item, score: r.score, class: r.class, predicted, correct });
  }
  return results;
}

function reportResults(label, results) {
  const correct = results.filter(r => r.correct).length;
  const acc = (correct / results.length * 100).toFixed(1);
  console.log(`\n=== ${label} ===`);
  console.log(`Accuracy: ${correct}/${results.length} (${acc}%)`);

  const byTarget = {};
  for (const r of results) {
    if (!byTarget[r.target]) byTarget[r.target] = { total: 0, correct: 0 };
    byTarget[r.target].total++;
    if (r.correct) byTarget[r.target].correct++;
  }
  console.log("\nPer-tier accuracy:");
  for (const [tier, stats] of Object.entries(byTarget)) {
    const pct = (stats.correct / stats.total * 100).toFixed(1);
    console.log(`  ${tier}: ${stats.correct}/${stats.total} (${pct}%)`);
  }

  const errors = results.filter(r => !r.correct);
  if (errors.length > 0) {
    console.log(`\nMisclassified (${errors.length}):`);
    for (const e of errors) {
      console.log(`  [${e.target}→${e.predicted}, score=${e.score}] ${e.text.slice(0, 60)}`);
    }
  }
}

function compareResults(baseline, neu) {
  console.log("\n=== Δ (new vs baseline) ===");
  const baseCorrect = baseline.filter(r => r.correct).length;
  const neuCorrect = neu.filter(r => r.correct).length;
  const delta = neuCorrect - baseCorrect;
  const sign = delta > 0 ? "+" : "";
  console.log(`Accuracy: ${sign}${delta} (baseline ${baseCorrect}/${baseline.length}, new ${neuCorrect}/${neu.length})`);

  const improved = [];
  const regressed = [];
  for (let i = 0; i < baseline.length; i++) {
    if (!baseline[i].correct && neu[i].correct) improved.push(neu[i]);
    if (baseline[i].correct && !neu[i].correct) regressed.push(neu[i]);
  }
  if (improved.length > 0) {
    console.log(`\nFixed by new anchors (${improved.length}):`);
    for (const r of improved) console.log(`  [${r.target}, score=${r.score}] ${r.text.slice(0, 60)}`);
  }
  if (regressed.length > 0) {
    console.log(`\nBroken by new anchors (${regressed.length}):`);
    for (const r of regressed) console.log(`  [${r.target}→${r.predicted}, score=${r.score}] ${r.text.slice(0, 60)}`);
  }
}

async function main() {
  const mode = process.argv[2];
  if (mode === "--baseline") {
    const results = await scoreWithAnchors(CONFIG_ANCHORS);
    reportResults("Baseline (config/difficulty-anchors.json)", results);
  } else if (mode === "--new") {
    if (!fs.existsSync(DATA_ANCHORS)) {
      console.error(`${DATA_ANCHORS} does not exist — run scripts/mine-difficulty-anchors.js first`);
      process.exit(1);
    }
    const results = await scoreWithAnchors(DATA_ANCHORS);
    reportResults("New (data/difficulty-anchors.json)", results);
  } else {
    if (!fs.existsSync(DATA_ANCHORS)) {
      console.error(`${DATA_ANCHORS} does not exist — run scripts/mine-difficulty-anchors.js first`);
      process.exit(1);
    }
    console.log("Scoring eval set with both anchor sets...");
    const baseline = await scoreWithAnchors(CONFIG_ANCHORS);
    const neu = await scoreWithAnchors(DATA_ANCHORS);
    reportResults("Baseline (config/)", baseline);
    reportResults("New (data/)", neu);
    compareResults(baseline, neu);
  }
}

main().catch(err => { console.error(err); process.exit(1); });
