# [MEDIUM] SHA-256 truncated to 64 bits enables collision attacks against audit log integrity

**File:** [`src/logger/deduplicator.js`](https://github.com/Fast-Editor/Lynkr/blob/feat/parallel-tool-execution/blob/feat/src/logger/deduplicator.js#L155-L158) (lines 155, 156, 157, 158)
**Project:** claude-code
**Severity:** MEDIUM  •  **Confidence:** medium  •  **Slug:** `insecure-crypto`

## Owners

**Suggested assignee:** `developer@call-home.ch` _(via last-committer)_

## Finding

`hashContent` (line 157-158) computes a full SHA-256 hex digest but then returns only the first 16 hex characters: `return `sha256:${hash.substring(0, 16)}`;` That is a 64-bit fingerprint, which is well below modern collision-resistance standards. A birthday collision is reachable in ~2^32 hashes — a few minutes to a few hours on commodity GPU hardware.

This hash is the *primary key* for the audit log content-addressable store (line 254 `storeContent`, and the `storeContentWithHash` flow used by `audit-logger.js` lines 339-380, 525-540). Once a hash is in `contentCache`, future calls with that same hash skip storage and just return `{ $ref: hash, size }` (lines 262-269). On restore (line 506+), `getContent(value.$ref)` returns whatever content was stored *first* under the hash — not necessarily what was logged at that point.

Exploit scenario for an attacker who can submit content that gets audited (i.e., an authenticated LLM client):
  1. Attacker observes / predicts the truncated-hash of legitimate content A that will be logged later (or pre-computes one for a known-fixed system prompt).
  2. Attacker crafts content B that hash-collides with A (truncated to 16 hex chars), submits B first so it lands in the dictionary.
  3. Later, content A is logged — but `contentCache.has(hash)` is true, so only the reference is written. `_updateDictionaryEntry` writes a metadata-update line, never re-storing A.
  4. When auditors run `restoreLogEntry`, they retrieve B as if it were A. The audit trail no longer reflects what was actually sent to the LLM provider.

The truncated `size` field in the reference even reflects the *current* content's length (line 281), making the log row look internally consistent. Because this codebase explicitly markets the audit logger as a compliance feature ('Always log at info level for compliance' — `audit-logger.js:40`), undermining its integrity guarantees has direct compliance impact.

## Recommendation

Use the full SHA-256 hex digest (64 chars) — disk savings from truncation are negligible and any compression layer below already deduplicates repeated bytes. If a shorter ID is desired for ergonomics, keep the full hash internally for storage/retrieval and only truncate for human-facing display: e.g., store under the full hash but render `sha256:abcd…1234` in UIs. Alternatively, use a wider truncation (≥32 hex chars / 128 bits) — but full hash is preferred. Additionally, on collision detection (i.e., when `contentCache.has(hash)` but the new content differs from the cached content), the deduplicator should either store under a salted/extended key or refuse to deduplicate and log a warning.

## Recent committers (`git log`)

- MichaelAnders <developer@call-home.ch> (2026-01-31)
- Vishal Veera Reddy <veerareddyvishal56@gmail.com> (2026-01-26)
