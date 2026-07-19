#!/usr/bin/env node
/**
 * Build the difficulty-classifier evaluation set.
 *
 * Sources (all zero-cost, no LLM judge required):
 *  1. RouterArena unused rows — native empirical difficulty labels
 *     (easy/medium/hard from 42-model pass rate). No LLM involved.
 *  2. routellm/gpt4_dataset unused rows — native mixtral_score 1–5
 *     (GPT-4-judged when the dataset was built). No LLM involved.
 *  3. Hand-crafted coding-agent-flavored prompts — representative of
 *     Lynkr's real traffic (real logs proved too thin, ~7 unique prompts).
 *
 * Leak avoidance: skip any text already in data/difficulty-anchors.provenance.json
 * (the mined anchor set) so eval and anchors don't overlap.
 *
 * Label → tier mapping:
 *   RouterArena easy   → MEDIUM  (any competent model handles)
 *   RouterArena medium → COMPLEX (needs strong general model)
 *   RouterArena hard   → REASONING (frontier model territory)
 *   gpt4_dataset score 5      → MEDIUM   (Mixtral got it right — trivially easy)
 *   gpt4_dataset score 3–4    → COMPLEX  (Mixtral partial — real difficulty)
 *   gpt4_dataset score 1–2    → REASONING (Mixtral failed — top-tier work)
 *
 * Output: data/difficulty-eval.jsonl (gitignored)
 * Usage: node scripts/build-eval-set.js
 */

const fs = require("fs");
const path = require("path");

const DS_SERVER = "https://datasets-server.huggingface.co/rows";
const OUT_FILE = path.join(__dirname, "../data/difficulty-eval.jsonl");
const PROVENANCE = path.join(__dirname, "../data/difficulty-anchors.provenance.json");

const TARGETS = { routerarena: 200, gpt4_dataset: 200 };

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchRows(dataset, config, split, offset, length) {
  const url = `${DS_SERVER}?dataset=${encodeURIComponent(dataset)}&config=${config}&split=${split}&offset=${offset}&length=${length}`;
  for (let a = 0; a < 5; a++) {
    try {
      const res = await fetch(url);
      if (res.status === 429) { await sleep(3000 * (a + 1)); continue; }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()).rows?.map(r => r.row) || [];
    } catch (err) {
      if (a === 4) return [];
      await sleep(1500 * (a + 1));
    }
  }
  return [];
}

function clean(text) {
  if (typeof text !== "string") return null;
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length < 15 || t.length > 400) return null;
  if (/\(\s*\)/.test(t) || /_{3,}/.test(t)) return null;
  if (/\b[A-D]\)\s/.test(t) || /which of the following/i.test(t)) return null;
  if (/\b(premise|hypothesis)\b/i.test(t) && /\b(entail|inference|contradict)\b/i.test(t)) return null;
  if (/NAME_\d|\{\{.*\}\}/.test(t)) return null;
  const nonAscii = (t.match(/[^\x20-\x7E]/g) || []).length;
  if (nonAscii > t.length * 0.1) return null;
  return t;
}

function isQuizbowlStyle(t) {
  return /^(this |one |a \d{4} (book|work|paper)|fictional |in one (work|section))/i.test(t) ||
    /\([A-Za-z]+-[A-Z][A-Za-z-]+\)/.test(t);
}

// Hand-crafted coding-agent-flavored prompts by tier. Reflects real Lynkr
// traffic shape (imperatives, technical vocabulary, mix of simple/mechanical/
// systemic/rigorous). Labels are mine — the honest reviewer for this session.
const HAND_EVAL = [
  // SIMPLE — casual/acks
  { text: "hi", tier: "SIMPLE" },
  { text: "hello", tier: "SIMPLE" },
  { text: "ok thanks", tier: "SIMPLE" },
  { text: "yes continue", tier: "SIMPLE" },
  { text: "no skip that", tier: "SIMPLE" },
  { text: "got it", tier: "SIMPLE" },
  { text: "sure go ahead", tier: "SIMPLE" },
  { text: "what time is it", tier: "SIMPLE" },
  { text: "cool", tier: "SIMPLE" },
  { text: "makes sense", tier: "SIMPLE" },
  { text: "thanks a lot", tier: "SIMPLE" },
  { text: "hey there", tier: "SIMPLE" },
  { text: "yep proceed", tier: "SIMPLE" },
  { text: "great work", tier: "SIMPLE" },
  { text: "no worries", tier: "SIMPLE" },
  // MEDIUM — one specific mechanical task
  { text: "list the exports from src/router.js", tier: "MEDIUM" },
  { text: "run the unit tests and summarize failures", tier: "MEDIUM" },
  { text: "show me the git diff for this file", tier: "MEDIUM" },
  { text: "what does this function do", tier: "MEDIUM" },
  { text: "explain this regex pattern to me", tier: "MEDIUM" },
  { text: "add error handling to this try block", tier: "MEDIUM" },
  { text: "fix the linter warnings in this file", tier: "MEDIUM" },
  { text: "write a unit test for the login helper", tier: "MEDIUM" },
  { text: "convert this callback to async/await", tier: "MEDIUM" },
  { text: "add a null check before this dereference", tier: "MEDIUM" },
  { text: "rename this variable to something more descriptive", tier: "MEDIUM" },
  { text: "extract this into a helper function", tier: "MEDIUM" },
  { text: "add a docstring to this method", tier: "MEDIUM" },
  { text: "check if this file has any TODO comments", tier: "MEDIUM" },
  { text: "search the codebase for uses of deprecated API", tier: "MEDIUM" },
  { text: "install the axios package as a dev dependency", tier: "MEDIUM" },
  { text: "revert the last commit but keep the working tree", tier: "MEDIUM" },
  { text: "delete unused imports from this file", tier: "MEDIUM" },
  { text: "format this JSON blob nicely", tier: "MEDIUM" },
  { text: "which files were changed in the last commit", tier: "MEDIUM" },
  { text: "how do I use the fetch API with timeouts", tier: "MEDIUM" },
  { text: "what's the difference between let and const in JavaScript", tier: "MEDIUM" },
  { text: "add a rate limit to this endpoint", tier: "MEDIUM" },
  { text: "grep for TODO in the routing folder", tier: "MEDIUM" },
  { text: "make this loop use Promise.all instead of sequential awaits", tier: "MEDIUM" },
  // COMPLEX — systemic / design / multi-file
  { text: "do an architecture review of the orchestrator", tier: "COMPLEX" },
  { text: "review this retry helper for bugs and race conditions", tier: "COMPLEX" },
  { text: "refactor the entire ingestion pipeline and give me a plan", tier: "COMPLEX" },
  { text: "design a horizontally scalable architecture for the router with failure-mode analysis", tier: "COMPLEX" },
  { text: "code review the PR #84 routing hardening changes", tier: "COMPLEX" },
  { text: "analyze every module in src/ for circular dependencies", tier: "COMPLEX" },
  { text: "debug this complex race condition in the connection pool", tier: "COMPLEX" },
  { text: "plan a zero-downtime migration to the new schema", tier: "COMPLEX" },
  { text: "implement a distributed rate limiter with Redis backing", tier: "COMPLEX" },
  { text: "design the caching strategy for this API gateway including invalidation rules", tier: "COMPLEX" },
  { text: "trace through the request lifecycle end to end and identify bottlenecks", tier: "COMPLEX" },
  { text: "restructure the module boundaries to reduce coupling between core and plugins", tier: "COMPLEX" },
  { text: "propose a testing strategy for the new streaming pipeline covering edge cases", tier: "COMPLEX" },
  { text: "identify all the places in the codebase that depend on the legacy auth flow and plan the deprecation", tier: "COMPLEX" },
  { text: "walk me through how the tier routing decision cascade works and highlight the weak points", tier: "COMPLEX" },
  { text: "compare our current queueing implementation against BullMQ and recommend a migration path", tier: "COMPLEX" },
  { text: "extract the shared session logic into a separate package and update all consumers", tier: "COMPLEX" },
  { text: "design the observability layer for the multi-tenant deployment with per-tenant metrics", tier: "COMPLEX" },
  { text: "diagnose why the latency P99 spiked yesterday afternoon across the fleet", tier: "COMPLEX" },
  { text: "plan the sharding strategy for the telemetry database as we scale to 10x traffic", tier: "COMPLEX" },
  { text: "audit the codebase for uses of unsafe eval and propose safe replacements", tier: "COMPLEX" },
  { text: "propose a graceful degradation plan for when the primary embedding model is unavailable", tier: "COMPLEX" },
  { text: "review the error handling across the client SDK and standardize on a single pattern", tier: "COMPLEX" },
  { text: "outline the migration from the monolith to a services split with backwards compatibility", tier: "COMPLEX" },
  { text: "reason about whether this cache invalidation scheme is correct under concurrent writes", tier: "COMPLEX" },
  // REASONING — proof / audit / formal / deep
  { text: "prove the correctness of this lock-free queue implementation and identify any ABA hazards", tier: "REASONING" },
  { text: "security audit the authentication middleware for token reuse vulnerabilities", tier: "REASONING" },
  { text: "derive the optimal cache eviction policy for this access pattern and prove its competitive ratio", tier: "REASONING" },
  { text: "formally verify that this state machine can never deadlock or produce a counterexample trace", tier: "REASONING" },
  { text: "from first principles design a Byzantine-fault-tolerant consensus variant tolerating f faults with 2f+1 replicas", tier: "REASONING" },
  { text: "think deeply about why this floating-point summation loses precision at scale and derive the compensated algorithm", tier: "REASONING" },
  { text: "prove this rate limiter is fair under concurrent refill or construct the starvation schedule that breaks it", tier: "REASONING" },
  { text: "reason through the exact memory ordering constraints this concurrent hashmap needs on ARM and justify each barrier", tier: "REASONING" },
  { text: "given these heap dumps reason to the retention path causing the leak and rule out the two most plausible alternatives", tier: "REASONING" },
  { text: "ultrathink: analyze whether this online schema migration can preserve every invariant the application relies on", tier: "REASONING" },
  { text: "verify no path in this state machine violates the safety property that read never observes a partial write", tier: "REASONING" },
  { text: "derive the amortized complexity bound for this splay tree under this adversarial access pattern and prove it tight", tier: "REASONING" },
  { text: "prove that this distributed algorithm makes progress under fair scheduling regardless of message reordering", tier: "REASONING" },
  { text: "penetration test the session token handling and enumerate every replay attack vector", tier: "REASONING" },
  { text: "formal proof that this compensation transaction preserves ACID under partial-failure scenarios", tier: "REASONING" },
  { text: "reason from first principles about whether exactly-once semantics are achievable on top of this at-least-once queue", tier: "REASONING" },
  { text: "vulnerability scan the recently-added crypto path for downgrade attacks and misuse of primitives", tier: "REASONING" },
  { text: "prove that this garbage collector will always terminate on any input given the described root set", tier: "REASONING" },
  { text: "verify the linearizability of this concurrent skip list using the linearization-point argument", tier: "REASONING" },
  { text: "think hard about which of these three algorithms actually preserves invariant I under crash recovery and which only appears to", tier: "REASONING" },
];

async function main() {
  const seenTexts = new Set();
  try {
    const prov = JSON.parse(fs.readFileSync(PROVENANCE, "utf8"));
    for (const text of Object.keys(prov)) seenTexts.add(text);
    console.log(`Loaded ${seenTexts.size} anchor texts from provenance (excluded from eval)`);
  } catch { /* first run may have no provenance */ }

  const eval_ = [];
  const seen = new Set([...seenTexts].map(t => t.slice(0, 80)));

  const add = (text, tier, source, label) => {
    const key = text.slice(0, 80);
    if (seen.has(key)) return false;
    seen.add(key);
    eval_.push({ text, tier, source, label });
    return true;
  };

  // 1. Hand-crafted prompts (canary + real-traffic representative)
  for (const item of HAND_EVAL) {
    add(item.text, item.tier, "hand", "author-labeled");
  }
  console.log(`Hand-crafted: ${eval_.length} added`);

  // 2. RouterArena — technical domains only, empirical difficulty labels
  console.log("Fetching RouterArena rows...");
  const TECH_DOMAIN_RE = /computer science|technology|engineering|mathematic|science/i;
  const DATASET_EXCLUDE_RE = /superglue|cloze|entailment/i;
  let raAdded = 0;
  outer: for (let offset = 4000; offset < 8400; offset += 100) {
    const rows = await fetchRows("RouteWorks/RouterArena", "default", "full", offset, 100);
    for (const row of rows) {
      if (raAdded >= TARGETS.routerarena) break outer;
      if (row.Context && String(row.Context).trim()) continue;
      if (Array.isArray(row.Options) && row.Options.length > 0) continue;
      if (DATASET_EXCLUDE_RE.test(String(row["Dataset name"] || ""))) continue;
      const text = clean(row.Question);
      if (!text || isQuizbowlStyle(text)) continue;
      const technical = TECH_DOMAIN_RE.test(String(row.Domain || ""));
      const diff = String(row.Difficulty || "").toLowerCase();
      let tier = null;
      if (diff === "easy") tier = "MEDIUM";
      else if (diff === "medium" && technical) tier = "COMPLEX";
      else if (diff === "hard" && technical) tier = "REASONING";
      if (!tier) continue;
      if (add(text, tier, "RouterArena", `${diff}/${row["Dataset name"]}`)) raAdded++;
    }
    await sleep(200);
  }
  console.log(`RouterArena: +${raAdded}`);

  // 3. gpt4_dataset — skip pages we mined for anchors (offset 0, 1817, 3634...)
  console.log("Fetching gpt4_dataset rows...");
  let gpAdded = 0;
  outer2: for (let offset = 60000; offset < 109000; offset += 500) {
    const rows = await fetchRows("routellm/gpt4_dataset", "default", "train", offset, 100);
    for (const row of rows) {
      if (gpAdded >= TARGETS.gpt4_dataset) break outer2;
      const text = clean(row.prompt);
      if (!text) continue;
      const score = Number(row.mixtral_score);
      let tier = null;
      if (score === 5) tier = "MEDIUM";
      else if (score === 3 || score === 4) tier = "COMPLEX";
      else if (score === 1 || score === 2) tier = text.length < 60 ? null : "REASONING";
      if (!tier) continue;
      if (add(text, tier, "gpt4_dataset", `mixtral_score=${score}`)) gpAdded++;
    }
    await sleep(200);
  }
  console.log(`gpt4_dataset: +${gpAdded}`);

  // Shuffle deterministically (session-repro via fixed permutation)
  eval_.sort((a, b) => a.text.length - b.text.length);
  const shuffled = [];
  for (let i = 0; i < eval_.length; i++) {
    const j = (i * 37 + 11) % eval_.length;
    shuffled.push(eval_[j]);
  }

  fs.writeFileSync(OUT_FILE, shuffled.map(r => JSON.stringify(r)).join("\n") + "\n");
  console.log(`\nWrote ${OUT_FILE}: ${shuffled.length} rows`);
  const perTier = {};
  for (const r of shuffled) perTier[r.tier] = (perTier[r.tier] || 0) + 1;
  console.log("Per-tier:", JSON.stringify(perTier));
}

main().catch(err => { console.error(err); process.exit(1); });
