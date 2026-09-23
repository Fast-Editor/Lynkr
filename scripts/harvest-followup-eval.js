#!/usr/bin/env node
/**
 * Harvest short follow-up turns from routing telemetry for the TaskBand
 * continuation-detector eval set.
 *
 * Reads <cwd>/.lynkr/telemetry.db (read-only — never mutates production
 * telemetry), groups rows by session ordered by timestamp, and emits every
 * turn whose request_text is ≤200 chars: short asks are where "do the same
 * here" follow-ups live, and where single-message scoring is blindest.
 * Each line carries up to 3 prior asks from the same session so a labeler
 * can judge continuation vs. new task without replaying the session.
 *
 * Output: data/followup-eval-unlabeled.jsonl (gitignored), one JSON object
 * per line: {session_id, ts, request_text, prior_asks, chosen_tier,
 * complexity_score, label: null} — label is filled in by hand.
 *
 * Usage: node scripts/harvest-followup-eval.js
 */

const fs = require("fs");
const path = require("path");

const MAX_ASK_CHARS = 200;
const MAX_PRIOR_ASKS = 3;
const OUT_FILE = path.join(__dirname, "../data/followup-eval-unlabeled.jsonl");

let Database;
try {
  Database = require("better-sqlite3");
} catch {
  console.error("better-sqlite3 is not installed (it is an optionalDependency) — cannot read telemetry.db.");
  console.error("Install it with: npm install better-sqlite3");
  process.exit(1);
}

function main() {
  const dbPath = path.join(process.cwd(), ".lynkr", "telemetry.db");
  if (!fs.existsSync(dbPath)) {
    console.error(`No telemetry database at ${dbPath} — run the proxy from this directory first to collect telemetry.`);
    process.exit(1);
  }

  const db = new Database(dbPath, { readonly: true, fileMustExist: true });

  const rows = db
    .prepare(
      `SELECT session_id, timestamp, request_text, tier, complexity_score
       FROM routing_telemetry
       WHERE session_id IS NOT NULL AND request_text IS NOT NULL AND request_text != ''
       ORDER BY session_id, timestamp ASC`
    )
    .all();
  db.close();

  const out = [];
  let sessions = 0;
  let prevSession = null;
  let priorAsks = [];

  for (const row of rows) {
    if (row.session_id !== prevSession) {
      prevSession = row.session_id;
      priorAsks = [];
      sessions++;
    }
    const text = String(row.request_text);
    if (text.length <= MAX_ASK_CHARS) {
      out.push(JSON.stringify({
        session_id: row.session_id,
        ts: row.timestamp,
        request_text: text,
        prior_asks: priorAsks.slice(-MAX_PRIOR_ASKS),
        chosen_tier: row.tier ?? null,
        complexity_score: row.complexity_score ?? null,
        label: null,
      }));
    }
    priorAsks.push(text);
  }

  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, out.length ? out.join("\n") + "\n" : "");
  console.log(`Scanned ${rows.length} rows across ${sessions} sessions.`);
  console.log(`Wrote ${OUT_FILE}: ${out.length} candidate follow-up turns (label: null — awaiting hand labels).`);
}

main();
