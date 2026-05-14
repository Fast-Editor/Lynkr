# [BUG] Non-atomic check-then-insert in upsertSession can throw under concurrent multi-process access

**File:** [`src/sessions/store.js`](https://github.com/Fast-Editor/Lynkr/blob/feat/parallel-tool-execution/blob/feat/src/sessions/store.js#L144-L158) (lines 144, 145, 146, 147, 148, 149, 150, 151, 152, 153, 154, 155, 156, 157, 158)
**Project:** claude-code
**Severity:** BUG  •  **Confidence:** medium  •  **Slug:** `other-toctou-race`

## Owners

**Suggested assignee:** `veerareddyvishal56@gmail.com` _(via last-committer)_

## Finding

upsertSession (lines 138-160) performs selectSessionStmt.get() followed by either insertSessionStmt.run() or updateSessionStmt.run() outside of a transaction. Because the SQLite database is opened in WAL mode (db/index.js L30) and may be shared across multiple Node processes/workers, two concurrent upsertSession calls for the same brand-new sessionId can both observe `existing === undefined`, then both attempt INSERT — the second will throw SQLITE_CONSTRAINT_PRIMARYKEY. Unlike getOrCreateSession (lines 121-135), which explicitly catches that error code and falls back to a re-read, upsertSession has no such handling. The two callers in orchestrator/index.js (L3793, L3827) wrap the call in `try { ... } catch (e) {}` which prevents a crash, but silently loses the metadata write on the losing branch. This is a non-security correctness bug — not exploitable for cross-tenant access since session IDs are not authentication tokens in this design — but it can cause subtle data inconsistency. The scanner's L14/L82 'insecure-crypto' flag and L11 'non-atomic-read-delete' flag are false positives (the file contains no crypto, and L11 is a SELECT, not a read-then-delete).

## Recommendation

Wrap the SELECT + INSERT/UPDATE in a single `db.transaction(...)` (better-sqlite3 supports IMMEDIATE/EXCLUSIVE transactions), or replace the entire function with an atomic UPSERT: `INSERT INTO sessions (...) VALUES (...) ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at, metadata = excluded.metadata`. Either approach removes the race.

## Recent committers (`git log`)

- Vishal Veera Reddy <veerareddyvishal56@gmail.com> (2026-02-22)
- MichaelAnders <developer@call-home.ch> (2026-01-31)
- vishal veerareddy <vishalveera.reddy@servicenow.com> (2025-12-03)
