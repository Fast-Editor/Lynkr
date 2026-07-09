#!/usr/bin/env node
// Free list verification (layers 1-3 of what paid verifiers do):
//   1. Syntax check + common typo detection (gamil.com etc.)
//   2. Domain accepts mail (MX record lookup)
//   3. Disposable-domain and role-account filtering + dedupe
// It does NOT do live SMTP probing (layer 4) — that's what paid credits buy.
//
// Usage:
//   node marketing/verify-list.js marketing/outreach.csv
//
// Output:
//   marketing/outreach.verified.csv  — rows that passed (send these)
//   marketing/outreach.rejected.csv  — rows that failed, with reason column
//
// No dependencies, no network calls except DNS lookups.

const fs = require('fs');
const path = require('path');
const dns = require('dns').promises;

const input = process.argv[2];
if (!input || !fs.existsSync(input)) {
  console.error('Usage: node marketing/verify-list.js <contacts.csv>');
  process.exit(1);
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

const TYPO_DOMAINS = {
  'gamil.com': 'gmail.com', 'gmial.com': 'gmail.com', 'gmail.co': 'gmail.com',
  'gmai.com': 'gmail.com', 'gnail.com': 'gmail.com', 'hotmial.com': 'hotmail.com',
  'hotmai.com': 'hotmail.com', 'outlok.com': 'outlook.com', 'yaho.com': 'yahoo.com',
  'yahooo.com': 'yahoo.com', 'iclould.com': 'icloud.com', 'icloud.co': 'icloud.com',
};

const DISPOSABLE = new Set([
  'mailinator.com', 'guerrillamail.com', '10minutemail.com', 'tempmail.com',
  'temp-mail.org', 'throwawaymail.com', 'yopmail.com', 'sharklasers.com',
  'getnada.com', 'maildrop.cc', 'dispostable.com', 'trashmail.com',
  'fakeinbox.com', 'mytemp.email', 'mohmal.com', 'emailondeck.com',
]);

// Role accounts rarely reply to cold outreach and attract spam complaints.
const ROLE_LOCALPARTS = new Set([
  'info', 'admin', 'support', 'sales', 'contact', 'help', 'office', 'mail',
  'noreply', 'no-reply', 'webmaster', 'postmaster', 'abuse', 'billing',
  'careers', 'jobs', 'hr', 'legal', 'security', 'privacy', 'marketing',
]);

function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') inQuotes = false;
      else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (field !== '' || row.length) { row.push(field); rows.push(row); row = []; field = ''; }
      if (c === '\r' && text[i + 1] === '\n') i++;
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function toCsvLine(cells) {
  return cells.map(c => /[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c).join(',');
}

async function hasMx(domain, cache) {
  if (cache.has(domain)) return cache.get(domain);
  let ok = false;
  try {
    const mx = await dns.resolveMx(domain);
    ok = mx.length > 0;
  } catch {
    // No MX — fall back to A record (rare but valid mail setup)
    try { ok = (await dns.resolve4(domain)).length > 0; } catch { ok = false; }
  }
  cache.set(domain, ok);
  return ok;
}

async function main() {
  const rows = parseCsv(fs.readFileSync(input, 'utf8'));
  const header = rows.shift();
  const emailIdx = header.map(h => h.trim().toLowerCase()).indexOf('email');
  if (emailIdx === -1) { console.error('CSV needs an "email" column'); process.exit(1); }

  const seen = new Set();
  const passed = [], rejected = [];
  const mxCache = new Map();
  let checked = 0;

  for (const row of rows) {
    const raw = (row[emailIdx] || '').trim().toLowerCase();
    const reject = (reason) => rejected.push([...row, reason]);

    if (!raw) { reject('empty'); continue; }
    if (!EMAIL_RE.test(raw)) { reject('invalid syntax'); continue; }

    const [local, domain] = raw.split('@');

    if (seen.has(raw)) { reject('duplicate'); continue; }
    seen.add(raw);

    if (TYPO_DOMAINS[domain]) { reject(`likely typo of ${TYPO_DOMAINS[domain]}`); continue; }
    if (DISPOSABLE.has(domain)) { reject('disposable domain'); continue; }
    if (ROLE_LOCALPARTS.has(local)) { reject('role account'); continue; }

    if (!(await hasMx(domain, mxCache))) { reject('domain has no mail server (MX)'); continue; }

    row[emailIdx] = raw;
    passed.push(row);
    checked++;
    if (checked % 100 === 0) console.log(`...${checked} verified`);
  }

  const base = input.replace(/\.csv$/i, '');
  fs.writeFileSync(`${base}.verified.csv`,
    [toCsvLine(header), ...passed.map(toCsvLine)].join('\n') + '\n');
  fs.writeFileSync(`${base}.rejected.csv`,
    [toCsvLine([...header, 'reject_reason']), ...rejected.map(toCsvLine)].join('\n') + '\n');

  console.log(`\nInput:    ${rows.length}`);
  console.log(`Passed:   ${passed.length}  → ${base}.verified.csv`);
  console.log(`Rejected: ${rejected.length}  → ${base}.rejected.csv`);
  const reasons = {};
  for (const r of rejected) reasons[r[r.length - 1]] = (reasons[r[r.length - 1]] || 0) + 1;
  for (const [reason, n] of Object.entries(reasons).sort((a, b) => b[1] - a[1])) {
    console.log(`  - ${reason}: ${n}`);
  }
}

main();
