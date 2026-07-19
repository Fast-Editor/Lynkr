#!/usr/bin/env node
/**
 * Mine empirically-labeled difficulty anchors from public router datasets.
 *
 * Sources (fetched via the HF datasets-server JSON API, no deps):
 *  - RouteWorks/RouterArena (full split): per-query empirical difficulty
 *    bands — easy (≥20/42 models correct), medium (5–19/42), hard (≤4/42).
 *  - routellm/gpt4_dataset: per-prompt mixtral_score 1–5 (GPT-4-judged
 *    quality of the weak model's answer).
 *
 * Label recipe (config B: local → GLM → Claude):
 *  - substantive (45, MEDIUM/ollama):  RouterArena easy  + mixtral_score 5
 *  - heavyweight (68, COMPLEX/GLM):    RouterArena medium + mixtral_score ≤2
 *  - frontier    (85, REASONING/Claude): RouterArena hard + hand examples
 *  - trivial stays hand-curated — benchmarks have no conversational prompts.
 *
 * Output: data/difficulty-anchors.json (gitignored, wins over config/) and
 * data/difficulty-anchors.provenance.json. The bundled 13-anchor default in
 * config/ is untouched.
 *
 * Requires local Ollama with nomic-embed-text (for diversity selection).
 * Usage: node scripts/mine-difficulty-anchors.js [--dry-run]
 */

const fs = require("fs");
const path = require("path");

const DS_SERVER = "https://datasets-server.huggingface.co/rows";
const OLLAMA_EMBED = process.env.OLLAMA_EMBEDDINGS_ENDPOINT || "http://localhost:11434/api/embeddings";
const EMBED_MODEL = process.env.OLLAMA_EMBEDDINGS_MODEL || "nomic-embed-text";

const OUT_ANCHORS = path.join(__dirname, "../data/difficulty-anchors.json");
const OUT_PROVENANCE = path.join(__dirname, "../data/difficulty-anchors.provenance.json");
const CONFIG_ANCHORS = path.join(__dirname, "../config/difficulty-anchors.json");

// Per-class targets after diversity selection (mined only, hand anchors extra)
const TARGETS = { substantive: 130, heavyweight: 130, frontier: 100 };

// Hand-written frontier examples: engineering-flavored deep-reasoning asks.
// RouterArena's hard band skews competition-academic; real Lynkr frontier
// traffic looks like these. Both kinds go in.
const HAND_FRONTIER = [
  "Prove the correctness of this lock-free queue implementation and identify any ABA hazards",
  "Design a novel conflict-free replicated data type for collaborative rich-text editing and argue its convergence from first principles",
  "Derive the optimal cache eviction policy for this access distribution and prove its competitive ratio",
  "Diagnose this heisenbug: a race that only reproduces under load across three services, given these interleaved logs",
  "Design a Byzantine-fault-tolerant consensus protocol variant that tolerates f faults with 2f+1 replicas by weakening liveness, and analyze exactly which guarantees are lost",
  "Formally verify that this state machine can never deadlock, or produce a counterexample trace",
  "Given these profiler traces, determine whether the tail latency is queueing-theoretic or GC-driven, and prove which by constructing a discriminating experiment",
  "Reason through the security of this key-rotation scheme under an adversary who can observe but not modify traffic, and find the weakest assumption it relies on",
  "Work out the exact memory ordering constraints this concurrent hashmap needs on ARM, and justify each barrier from the C++ memory model",
  "Given this failing distributed transaction trace, determine whether the anomaly is write skew or lost update, and design the minimal isolation-level change that eliminates it",
  "Derive the amortized complexity of this self-adjusting tree under this adversarial access pattern, and prove the bound is tight",
  "Analyze whether this migration can be run online without violating any invariant the application relies on, enumerating the interleavings that could corrupt state",
  "Reverse-engineer why this JIT deoptimizes on this hot path and design a fix that preserves the semantics, with reasoning about hidden class transitions",
  "Prove this rate limiter is fair under concurrent refill, or construct the starvation schedule that breaks it",
  "Design an exactly-once delivery layer on top of an at-least-once queue without idempotency keys, or prove it is impossible under these constraints",
  "Given these heap dumps over time, reason to the retention path causing the leak and rule out the two most plausible alternative explanations",
  "Reconcile these conflicting benchmark results by identifying the confound in the experimental setup, and design the experiment that isolates it",
  "Determine the weakest consistency model under which this caching layer is still linearizable from the client's perspective, with proof",
  "Plan a zero-downtime re-sharding of this 2TB database under sustained writes, reasoning through every failure mode and its recovery path",
  "Explain step by step why this floating-point summation loses precision at scale and derive the compensated algorithm that bounds the error",
];

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchRows(dataset, config, split, offset, length) {
  const url = `${DS_SERVER}?dataset=${encodeURIComponent(dataset)}&config=${config}&split=${split}&offset=${offset}&length=${length}`;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const res = await fetch(url);
      if (res.status === 429) { await sleep(2500 * (attempt + 1)); continue; }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      return { rows: json.rows?.map(r => r.row) || [], total: json.num_rows_total ?? null };
    } catch (err) {
      if (attempt === 5) {
        console.warn(`  page offset=${offset} failed after retries (${err.message}) — skipping`);
        return { rows: [], total: null, failed: true };
      }
      await sleep(1500 * (attempt + 1));
    }
  }
  return { rows: [], total: null, failed: true };
}

// --- candidate filters -------------------------------------------------------

function cleanCandidate(text) {
  if (typeof text !== "string") return null;
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length < 15 || t.length > 400) return null;
  // Cloze / MCQ scaffolding reads nothing like a typed ask
  if (/\(\s*\)/.test(t) || /_{3,}/.test(t)) return null;
  if (/\b[A-D]\)\s/.test(t) || /which of the following/i.test(t)) return null;
  // NLI/benchmark scaffolding (gpt4_dataset carries FLAN-style tasks)
  if (/\b(premise|hypothesis)\b/i.test(t) && /\b(entail|inference|contradict)\b/i.test(t)) return null;
  if (/natural language inference|answer with (yes|no)|options: -/i.test(t)) return null;
  // Anonymization tokens (gpt4_dataset) and template junk
  if (/NAME_\d|\{\{.*\}\}/.test(t)) return null;
  // Mostly-English only: embeddings + our traffic are English
  const nonAscii = (t.match(/[^\x20-\x7E]/g) || []).length;
  if (nonAscii > t.length * 0.1) return null;
  return t;
}

// Quiz-bowl clue style: leading demonstrative riddles and pronunciation
// guides. "Hard" trivia measures obscure recall, not reasoning depth — it
// would anchor the frontier class to the wrong concept entirely.
function isQuizbowlStyle(t) {
  return /^(this |one |a \d{4} (book|work|paper)|fictional |in one (work|section))/i.test(t) ||
    /\([A-Za-z]+-[A-Z][A-Za-z-]+\)/.test(t);
}

const TECH_DOMAIN_RE = /computer science|technology|engineering|mathematic|science/i;
// SuperGLUE tasks are benchmark scaffolding, not natural asks.
const DATASET_EXCLUDE_RE = /superglue|cloze|entailment/i;

// --- diversity selection (greedy k-center / max-min) -------------------------

async function embed(text) {
  const res = await fetch(OLLAMA_EMBED, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: EMBED_MODEL, prompt: text }),
  });
  if (!res.ok) throw new Error(`embed HTTP ${res.status}`);
  const json = await res.json();
  return json.embedding;
}

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  const d = Math.sqrt(na) * Math.sqrt(nb);
  return d > 0 ? dot / d : 0;
}

async function diversitySelect(candidates, target, label) {
  if (candidates.length <= target) return candidates.map(c => c.text);
  process.stdout.write(`  embedding ${candidates.length} ${label} candidates...`);
  const embedded = [];
  for (const c of candidates) {
    try {
      embedded.push({ ...c, vec: await embed(c.text) });
    } catch { /* skip failures */ }
    if (embedded.length % 200 === 0) process.stdout.write(".");
  }
  console.log(` ${embedded.length} embedded`);

  // Greedy max-min: always keep the candidate farthest from the selected set.
  const selected = [embedded[0]];
  const minSim = new Array(embedded.length).fill(-1).map((_, i) => cosine(embedded[i].vec, embedded[0].vec));
  while (selected.length < target) {
    let bestIdx = -1, bestVal = Infinity;
    for (let i = 0; i < embedded.length; i++) {
      if (minSim[i] === Infinity) continue; // already selected
      if (minSim[i] < bestVal) { bestVal = minSim[i]; bestIdx = i; }
    }
    if (bestIdx === -1) break;
    const pick = embedded[bestIdx];
    selected.push(pick);
    minSim[bestIdx] = Infinity;
    for (let i = 0; i < embedded.length; i++) {
      if (minSim[i] === Infinity) continue;
      const s = cosine(embedded[i].vec, pick.vec);
      if (s > minSim[i]) minSim[i] = s;
    }
  }
  return selected.map(s => s.text);
}

// --- main --------------------------------------------------------------------

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const pools = { substantive: [], heavyweight: [], frontier: [] };
  const provenance = {};

  // RouterArena: full split, paginate everything (~8.4k rows)
  console.log("Fetching RouterArena (full split)...");
  let raCount = 0;
  let raTotal = null;
  for (let offset = 0; raTotal === null || offset < raTotal; offset += 100) {
    const { rows, total } = await fetchRows("RouteWorks/RouterArena", "default", "full", offset, 100);
    if (total !== null) raTotal = total;
    if (rows.length === 0 && raTotal === null) break;
    raCount += rows.length;
    for (const row of rows) {
      if (row.Context && String(row.Context).trim()) continue; // passage-dependent
      if (Array.isArray(row.Options) && row.Options.length > 0) continue; // MCQ
      if (DATASET_EXCLUDE_RE.test(String(row["Dataset name"] || ""))) continue;
      const text = cleanCandidate(row.Question);
      if (!text || isQuizbowlStyle(text)) continue;
      const technical = TECH_DOMAIN_RE.test(String(row.Domain || ""));
      const diff = String(row.Difficulty || "").toLowerCase();
      // hard→frontier and medium→heavyweight only from technical domains:
      // non-technical "hard" is dominated by obscure-recall trivia, which
      // anchors the expensive tiers to the wrong concept.
      let cls = null;
      if (diff === "easy") cls = "substantive";
      else if (diff === "medium" && technical) cls = "heavyweight";
      else if (diff === "hard" && technical) cls = "frontier";
      if (!cls) continue;
      pools[cls].push({ text, source: "RouterArena", label: `${row.Difficulty}/${row["Dataset name"]}`, technical });
    }
    if (offset % 2000 === 0 && offset > 0) console.log(`  ...${raCount}/${raTotal ?? "?"} rows scanned`);
    await sleep(250); // stay friendly to the API
  }
  console.log(`RouterArena: ${raCount} rows → pools: sub=${pools.substantive.length} heavy=${pools.heavyweight.length} frontier=${pools.frontier.length}`);

  // gpt4_dataset: sample pages spread across the 109k-row train split
  console.log("Sampling routellm/gpt4_dataset...");
  const PAGES = 60;
  const SPAN = 109000;
  for (let p = 0; p < PAGES; p++) {
    const offset = Math.floor((p * SPAN) / PAGES);
    const { rows } = await fetchRows("routellm/gpt4_dataset", "default", "train", offset, 100);
    for (const row of rows) {
      const text = cleanCandidate(row.prompt);
      if (!text) continue;
      const score = Number(row.mixtral_score);
      const technical = /code|function|script|debug|compile|regex|sql|api|server|deploy|git|test/i.test(text);
      if (score === 5) {
        pools.substantive.push({ text, source: "gpt4_dataset", label: `mixtral_score=${score}`, technical });
      } else if (score <= 2 && score >= 1 && text.length >= 60) {
        // ≥60 chars: low judge scores on one-liners are label noise
        // ("What is the capital of Massachusetts?" scored 1), not difficulty.
        pools.heavyweight.push({ text, source: "gpt4_dataset", label: `mixtral_score=${score}`, technical });
      }
    }
    await sleep(250);
  }
  console.log(`After gpt4_dataset: sub=${pools.substantive.length} heavy=${pools.heavyweight.length} frontier=${pools.frontier.length}`);

  // Bias ~60% technical where the pool allows: sort technical-first, then
  // interleave so diversity selection sees both kinds.
  for (const cls of Object.keys(pools)) {
    const tech = pools[cls].filter(c => c.technical);
    const gen = pools[cls].filter(c => !c.technical);
    const mixed = [];
    let ti = 0, gi = 0;
    while (ti < tech.length || gi < gen.length) {
      // 3 technical : 2 general cadence ≈ 60/40
      for (let k = 0; k < 3 && ti < tech.length; k++) mixed.push(tech[ti++]);
      for (let k = 0; k < 2 && gi < gen.length; k++) mixed.push(gen[gi++]);
    }
    pools[cls] = mixed;
  }

  if (dryRun) {
    for (const cls of Object.keys(pools)) {
      console.log(`\n=== ${cls} (${pools[cls].length} candidates), first 5:`);
      for (const c of pools[cls].slice(0, 5)) console.log(`  [${c.source}/${c.label}] ${c.text.slice(0, 100)}`);
    }
    return;
  }

  // Diversity-select down to targets
  const selected = {};
  for (const [cls, target] of Object.entries(TARGETS)) {
    selected[cls] = await diversitySelect(pools[cls], target, cls);
    for (const text of selected[cls]) {
      const cand = pools[cls].find(c => c.text === text);
      provenance[text] = { class: cls, source: cand?.source, label: cand?.label };
    }
  }

  // Merge with the bundled hand anchors (they always survive)
  const hand = JSON.parse(fs.readFileSync(CONFIG_ANCHORS, "utf8"));
  const out = {
    _comment: `Mined ${new Date().toISOString().slice(0, 10)} by scripts/mine-difficulty-anchors.js from RouteWorks/RouterArena (empirical difficulty bands) and routellm/gpt4_dataset (mixtral_score). Hand anchors from config/difficulty-anchors.json retained. Local only (data/ is gitignored and excluded from the npm tarball).`,
    trivial: hand.trivial,
    substantive: [...hand.substantive, ...selected.substantive],
    heavyweight: [...hand.heavyweight, ...selected.heavyweight],
    frontier: [...HAND_FRONTIER, ...selected.frontier],
  };
  for (const t of HAND_FRONTIER) provenance[t] = { class: "frontier", source: "hand", label: "engineering-frontier" };

  fs.writeFileSync(OUT_ANCHORS, JSON.stringify(out, null, 2));
  fs.writeFileSync(OUT_PROVENANCE, JSON.stringify(provenance, null, 2));
  console.log(`\nWrote ${OUT_ANCHORS}:`);
  for (const cls of ["trivial", "substantive", "heavyweight", "frontier"]) {
    console.log(`  ${cls}: ${out[cls].length} anchors`);
  }
}

main().catch(err => { console.error(err); process.exit(1); });
