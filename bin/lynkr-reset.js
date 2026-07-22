#!/usr/bin/env node

const path = require("path");
const fs = require("fs");

const DB_PATH =
  process.env.LYNKR_TELEMETRY_DB ||
  path.join(__dirname, "..", ".lynkr", "telemetry.db");

const RESOURCES = {
  session_pins: {
    describe: "Session → provider affinity pins",
    table: "session_pins",
  },
};

function usage(code = 0) {
  const lines = Object.entries(RESOURCES).map(
    ([k, v]) => `  ${k.padEnd(16)} ${v.describe}`
  );
  console.log(
`Usage: lynkr reset <resource>

Resources:
${lines.join("\n")}
  all              Clear every resource above

DB: ${DB_PATH}
`
  );
  process.exit(code);
}

const target = process.argv[2];
if (!target || target === "-h" || target === "--help") usage(0);

if (target !== "all" && !RESOURCES[target]) {
  console.error(`Error: unknown resource '${target}'.`);
  usage(1);
}

if (!fs.existsSync(DB_PATH)) {
  console.error(`Error: telemetry DB not found at ${DB_PATH}`);
  process.exit(1);
}

let Database;
try {
  Database = require("better-sqlite3");
} catch (err) {
  console.error("Error: better-sqlite3 not installed. Run `npm install` in ~/claude-code.");
  process.exit(1);
}

const db = new Database(DB_PATH);
const targets = target === "all" ? Object.keys(RESOURCES) : [target];

let hadError = false;
for (const t of targets) {
  const { table } = RESOURCES[t];
  try {
    const before = db.prepare(`SELECT COUNT(*) as n FROM ${table}`).get().n;
    db.prepare(`DELETE FROM ${table}`).run();
    console.log(`✓ cleared ${t} (${before} rows)`);
  } catch (err) {
    hadError = true;
    console.error(`✗ ${t}: ${err.message}`);
  }
}
db.close();
process.exit(hadError ? 1 : 0);
