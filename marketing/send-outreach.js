#!/usr/bin/env node
// One-shot outreach sender: one email per contact from a CSV, rotating across
// one or more SMTP mailboxes with a per-mailbox daily cap.
//
// Accounts — two ways to configure:
//   A) Multi-mailbox (recommended): marketing/accounts.json
//      [
//        {"host": "smtp.privateemail.com", "port": 465, "user": "vishal@lynkrhq.com", "pass": "..."},
//        {"host": "smtp.privateemail.com", "port": 465, "user": "hello@lynkrhq.com",  "pass": "..."}
//      ]
//      (marketing/ is untracked, but never commit this file anywhere.)
//   B) Single Gmail fallback: GMAIL_USER / GMAIL_APP_PASSWORD env vars.
//
// CSV format (marketing/outreach.csv) — header row required:
//   email,name,personal_line
//   jane@acme.dev,Jane,"loved your post on Claude Code costs last month"
//
// Template: marketing/outreach-template.txt
//   First line  = Subject (supports {{name}} etc.)
//   Rest        = plain-text body. Placeholders: {{name}} {{personal_line}} {{email}}
//
// Usage:
//   node marketing/send-outreach.js --dry-run
//   node marketing/send-outreach.js
//
// Behavior:
//   - Sends at most DAILY_CAP per mailbox per run (default 40); mailboxes rotate
//     round-robin, so 3 mailboxes = up to 120 sends per daily run.
//   - Random 2–5 min gap between sends (looks human, not like a blast).
//   - marketing/sent-log.csv records every send; contacts already in it are skipped,
//     so re-running is always safe and double-sends are impossible.
//   - A mailbox is dropped from rotation after an auth error or 3 consecutive
//     failures; the run stops when no mailboxes remain.

const fs = require('fs');
const path = require('path');

const DAILY_CAP = parseInt(process.env.DAILY_CAP || '40', 10); // per mailbox
const MIN_GAP_MS = 2 * 60 * 1000;
const MAX_GAP_MS = 5 * 60 * 1000;

const DIR = path.dirname(__filename);
const CSV_PATH = path.join(DIR, 'outreach.csv');
const TEMPLATE_PATH = path.join(DIR, 'outreach-template.txt');
const LOG_PATH = path.join(DIR, 'sent-log.csv');

const dryRun = process.argv.includes('--dry-run');

// --- tiny CSV parser (handles quoted fields with commas) ---
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

function loadContacts() {
  const rows = parseCsv(fs.readFileSync(CSV_PATH, 'utf8'));
  const header = rows.shift().map(h => h.trim().toLowerCase());
  const emailIdx = header.indexOf('email');
  if (emailIdx === -1) throw new Error('CSV needs an "email" column');
  return rows
    .filter(r => r[emailIdx] && r[emailIdx].includes('@'))
    .map(r => Object.fromEntries(header.map((h, i) => [h, (r[i] || '').trim()])));
}

function loadSentSet() {
  if (!fs.existsSync(LOG_PATH)) return new Set();
  return new Set(
    fs.readFileSync(LOG_PATH, 'utf8').split('\n').filter(Boolean)
      .map(line => line.split(',')[1]).filter(Boolean)
  );
}

function render(tpl, contact) {
  return tpl.replace(/\{\{(\w+)\}\}/g, (_, key) => contact[key] ?? '');
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function loadAccounts() {
  const accountsPath = path.join(DIR, 'accounts.json');
  if (fs.existsSync(accountsPath)) {
    const accounts = JSON.parse(fs.readFileSync(accountsPath, 'utf8'));
    if (!Array.isArray(accounts) || accounts.length === 0) {
      throw new Error('accounts.json must be a non-empty array of {host, port, user, pass}');
    }
    return accounts;
  }
  if (process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD) {
    return [{
      host: 'smtp.gmail.com', port: 465,
      user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD,
    }];
  }
  return null;
}

async function main() {
  const accounts = loadAccounts();
  if (!dryRun && !accounts) {
    console.error('No accounts: create marketing/accounts.json or set GMAIL_USER + GMAIL_APP_PASSWORD');
    process.exit(1);
  }

  const template = fs.readFileSync(TEMPLATE_PATH, 'utf8');
  const [subjectLine, ...bodyLines] = template.split('\n');
  const bodyTpl = bodyLines.join('\n').trim();

  const contacts = loadContacts();
  const sent = loadSentSet();
  const nAccounts = accounts ? accounts.length : 1;
  const queue = contacts.filter(c => !sent.has(c.email)).slice(0, DAILY_CAP * nAccounts);

  console.log(`Contacts: ${contacts.length} total, ${sent.size} already sent, ` +
    `${queue.length} queued this run (${nAccounts} mailbox${nAccounts > 1 ? 'es' : ''} × cap ${DAILY_CAP})`);
  if (!queue.length) { console.log('Nothing to send.'); return; }

  // Build one transporter per account; verify creds up front.
  const pool = [];
  if (!dryRun) {
    const nodemailer = require('nodemailer');
    for (const acc of accounts) {
      const transporter = nodemailer.createTransport({
        host: acc.host, port: acc.port || 465, secure: (acc.port || 465) === 465,
        auth: { user: acc.user, pass: acc.pass },
      });
      try {
        await transporter.verify();
        pool.push({ user: acc.user, transporter, sentCount: 0, consecutiveFailures: 0 });
        console.log(`✓ ${acc.user} connected`);
      } catch (err) {
        console.error(`✗ ${acc.user} failed to connect: ${err.message} — skipping this mailbox`);
      }
    }
    if (pool.length === 0) { console.error('No usable mailboxes.'); process.exit(1); }
  }

  let poolIdx = 0;
  const nextMailbox = () => {
    // round-robin over mailboxes that still have quota and aren't failing
    for (let n = 0; n < pool.length; n++) {
      const mb = pool[(poolIdx + n) % pool.length];
      if (mb.sentCount < DAILY_CAP && mb.consecutiveFailures < 3) {
        poolIdx = (poolIdx + n + 1) % pool.length;
        return mb;
      }
    }
    return null;
  };

  for (const [i, contact] of queue.entries()) {
    const subject = render(subjectLine, contact);
    const body = render(bodyTpl, contact);

    if (dryRun) {
      console.log(`\n--- [dry-run ${i + 1}/${queue.length}] to: ${contact.email}\nSubject: ${subject}\n${body}`);
      continue;
    }

    const mb = nextMailbox();
    if (!mb) { console.error('All mailboxes exhausted or failing — stopping for today.'); break; }

    try {
      await mb.transporter.sendMail({ from: mb.user, to: contact.email, subject, text: body });
      fs.appendFileSync(LOG_PATH, `${new Date().toISOString()},${contact.email},${mb.user}\n`);
      mb.sentCount++;
      mb.consecutiveFailures = 0;
      console.log(`[${i + 1}/${queue.length}] sent → ${contact.email}  (via ${mb.user}, ${mb.sentCount}/${DAILY_CAP})`);
    } catch (err) {
      mb.consecutiveFailures++;
      console.error(`[${i + 1}/${queue.length}] FAILED → ${contact.email} via ${mb.user}: ${err.message}`);
      if (/auth|credential|5\.7\.8/i.test(err.message)) {
        mb.consecutiveFailures = 3; // pull this mailbox from rotation
        console.error(`   ${mb.user} removed from rotation (auth problem).`);
      }
    }

    if (i < queue.length - 1) {
      const gap = MIN_GAP_MS + Math.random() * (MAX_GAP_MS - MIN_GAP_MS);
      console.log(`   waiting ${Math.round(gap / 1000)}s...`);
      await sleep(gap);
    }
  }
  console.log('\nDone for today. Run again tomorrow to continue the queue.');
}

main().catch(err => { console.error(err.message); process.exit(1); });
